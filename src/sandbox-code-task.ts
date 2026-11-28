import { randomBytes } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import {
  clearDiscovery,
  envWithDiscovery,
  resolveTemplates,
} from "./discover.js";
import { findRole, loadHarnessConfig } from "./harness-config.js";
import { renderTemplate } from "./job-manifest.js";
import { McpNotSentError, PolicyError } from "./mcp.js";
import {
  classifyExecutorCall,
  commandExitCode,
  deterministicFailure,
  sandboxCall,
} from "./pending-jobs.js";
import { SCHEDULED_APPROVAL_REFUSAL } from "./guards.js";
import { durableTaskJobPrefix } from "./durable-tasks.js";
import { executorBodies, isExecutorApproval } from "./executor-result.js";

export const JOB_INDETERMINATE =
  "The call started, but the provider lost its response due to an internal Executor error. The job is still running and the result will arrive automatically in this topic. Do not repeat the request or start another job.";

type Env = Record<string, string | undefined>;
type Call = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

/** Everything provider-specific comes from `sandbox_code_task` in config.yaml. */
interface Task {
  tool: string;
  job: string;
  description?: string;
  server?: string;
  requires?: string[];
  idPrefix?: string;
  goal?: string;
  parameters: TSchema;
  exec: { tool: string; args?: Record<string, unknown> };
  allow?: { field: string; patterns?: string; default?: string };
  readonly?: { env?: string; command?: string; prompt?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The config block, or undefined when it is incomplete. */
function readTask(env: Env): Task | undefined {
  const raw = loadHarnessConfig(env).sandboxTask;
  if (!isRecord(raw) || !isRecord(raw.exec)) return undefined;
  const task = raw as unknown as Task;
  if (
    typeof task.tool !== "string" ||
    typeof task.job !== "string" ||
    typeof task.exec.tool !== "string"
  )
    return undefined;
  if (task.requires?.some((name) => !(env[name] ?? "").trim()))
    return undefined;
  return {
    ...task,
    parameters: isRecord(task.parameters)
      ? (task.parameters as TSchema)
      : Type.Object({}),
    exec: {
      ...task.exec,
      args: isRecord(task.exec.args) ? task.exec.args : {},
    },
  };
}

function isInstabox(task: Task): boolean {
  return (
    task.job === "internal.instabox.codeTask" ||
    /^(?:tools\.)?instabox\.machines\.exec$/.test(task.exec.tool)
  );
}

/**
 * System-prompt line while the long-task tool is actually registered.
 * The name comes from config. An incomplete block hides both the tool and this line.
 */
export function sandboxTaskSteer(env: Env = process.env): string | undefined {
  const task = readTask(env);
  if (!task) return;
  if (isInstabox(task))
    return `For a long-running code task the user authorizes to run with write access, call ${task.tool} once with writes=true and wait for approval. Never poll that work in a loop. Do not use this tool for read-only work.`;
  return `For anything long-running, or when the user asks to be told when it finishes ("avise quando terminar"), call ${task.tool} once. Never poll that work in a loop.`;
}

/** The registered long-task tool's name, when that tool is available this run. */
export function longTaskToolName(env: Env = process.env): string | undefined {
  return readTask(env)?.tool;
}

/** `owner/*` matches an owner, `*` matches anything, otherwise an exact value. */
export function isAllowed(value: string, patterns = ""): boolean {
  const parts = value.split("/");
  const [owner] = parts;
  return (
    !!owner &&
    !parts.some((part) => part === "." || part === "..") &&
    patterns.split(",").some((raw) => {
      const pattern = raw.trim().toLowerCase();
      if (pattern === "*" || pattern === "*/*") return true;
      return pattern.endsWith("/*")
        ? owner.toLowerCase() === pattern.slice(0, -2)
        : value.toLowerCase() === pattern;
    })
  );
}

function allowPatterns(allow: Task["allow"], env: Env): string {
  if (!allow) return "";
  const override = env.INSTABOX_REPO_ALLOWLIST?.trim();
  if (override) return override;
  const rendered = String(
    renderTemplate(allow.patterns ?? "", env) ?? "",
  ).trim();
  return rendered && !rendered.includes("${")
    ? rendered
    : (allow.default ?? "");
}

function createJobId(prefix: string) {
  return `${prefix}${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`.toLowerCase();
}

const READONLY_PROMPT =
  "Read-only: do not push, open pull requests, or post comments.";

function readOnly(task: Task) {
  const mode = task.readonly;
  if (!mode || typeof mode !== "object") return;
  const configured = typeof mode.prompt === "string" ? mode.prompt.trim() : "";
  return {
    env: typeof mode.env === "string" ? mode.env.trim() : "",
    command: typeof mode.command === "string" ? mode.command.trim() : "",
    prompt: configured || READONLY_PROMPT,
  };
}

function commandSlot(args: Record<string, unknown>, path: string) {
  const parts = path.split(".").filter(Boolean);
  let node: unknown = args;
  for (const key of parts.slice(0, -1)) {
    if (!isRecord(node)) return;
    node = node[key];
  }
  const key = parts.at(-1);
  if (!key || !isRecord(node) || typeof node[key] !== "string") return;
  return { parent: node, key };
}

function clip(value: string) {
  return value
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function writePreview(task: Task, input: Record<string, unknown>) {
  const goal = task.goal ?? "";
  const lines = ["Code task with write access"];
  for (const [key, value] of Object.entries(input)) {
    if (key === goal || key === "writes") continue;
    if (typeof value !== "string" || !value.trim()) continue;
    lines.push(`${key}: ${clip(value)}`);
  }
  if (!lines.some((line) => line.startsWith("branch:")))
    lines.push("branch: (job default)");
  const prompt = goal ? input[goal] : undefined;
  if (typeof prompt === "string" && prompt.trim())
    lines.push(`${goal}: ${clip(prompt)}`);
  return lines.join("\n");
}

/** Give the existing Executor card a task label without changing its resume data. */
function labelExecutorApproval(result: unknown, prefix: string) {
  if (!prefix) return result;
  const pause = executorBodies(result).find(isExecutorApproval);
  if (!pause) return result;
  const elicitation = pause.elicitation;
  const labeled = {
    ...pause,
    message:
      prefix +
      (typeof pause.message === "string" && pause.message.trim()
        ? pause.message
        : "Confirm this action in Executor."),
    ...(isRecord(elicitation) && typeof elicitation.message === "string"
      ? {
          elicitation: {
            ...elicitation,
            message: prefix + elicitation.message,
          },
        }
      : {}),
  };
  return isRecord(result) && Array.isArray(result.content)
    ? { ...result, structuredContent: labeled }
    : labeled;
}

function renderExec(
  task: Task,
  env: Env,
  jobId: string,
  goal: string | undefined,
  input: Record<string, unknown>,
) {
  const rendered = renderTemplate(task.exec.args ?? {}, {
    ...envWithDiscovery(env),
    id: jobId,
    job_id: jobId,
    goal,
    payload: JSON.stringify(input),
  });
  return isRecord(rendered) ? rendered : {};
}

function prepareExec(
  task: Task,
  env: Env,
  jobId: string,
  goal: string | undefined,
  input: Record<string, unknown>,
  writes: boolean,
) {
  const mode = writes ? undefined : readOnly(task);
  const field = task.goal;
  const text = field ? input[field] : undefined;
  const noted =
    mode?.command &&
    field &&
    typeof text === "string" &&
    !text.includes(mode.prompt)
      ? { ...input, writes, [field]: `${text}\n\n${mode.prompt}` }
      : { ...input, writes };
  const args = renderExec(task, env, jobId, goal, noted);
  if (!mode?.command) return args;
  const slot = commandSlot(args, mode.command);
  if (!slot) return renderExec(task, env, jobId, goal, { ...input, writes });
  if (!mode.env) return args;
  const current = String(slot.parent[slot.key]);
  if (current !== mode.env && !current.startsWith(`${mode.env} `))
    slot.parent[slot.key] = `${mode.env} ${current}`;
  return args;
}

function missingMachine(error: unknown) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b404\b/.test(text) || /not[\s_-]*found/i.test(text);
}

/** Clears the cache and looks up again. Same args means the id did not change. */
async function retarget(
  env: Env,
  call: Call,
  task: Task,
  jobId: string,
  goal: string | undefined,
  input: Record<string, unknown>,
  previous: Record<string, unknown>,
  writes: boolean,
): Promise<{ error?: string; args?: Record<string, unknown> }> {
  clearDiscovery(env);
  const resolved = await resolveTemplates(env, call, [task.exec.args ?? {}]);
  if (!resolved.ok) return { error: resolved.error };
  const args = prepareExec(task, env, jobId, goal, input, writes);
  if (JSON.stringify(args) === JSON.stringify(previous)) return {};
  return { args };
}

type DispatchText = {
  text: string;
  isError?: true;
  rejected?: true;
  approvalRequested?: boolean;
};

async function dispatchJob(
  app: Runtime,
  env: Env,
  task: Task,
  executor: string,
  usesSandbox: boolean,
  { conversationId, taskId }: ReturnType<Runtime["resolveJobConversation"]>,
  input: Record<string, unknown>,
  call: Call,
  writes: boolean,
  signal?: AbortSignal,
  roleInstructions?: string,
): Promise<DispatchText> {
  const prefix = taskId ? durableTaskJobPrefix(taskId) : "";
  const json = (body: unknown, rejected?: true): DispatchText => ({
    text: JSON.stringify(body),
    ...(rejected ? { rejected } : {}),
  });
  const resolved = await resolveTemplates(env, call, [task.exec.args ?? {}]);
  if (!resolved.ok) return json({ error: prefix + resolved.error }, true);

  const jobId = createJobId(task.idPrefix ?? "job-");
  const goal = task.goal
    ? String(input[task.goal] ?? "")
        .trim()
        .slice(0, 120)
    : undefined;
  if (roleInstructions) {
    const field = task.goal ?? "prompt";
    const prompt = input[field];
    input = {
      ...input,
      [field]:
        typeof prompt === "string"
          ? `${prompt}\n\n${roleInstructions}`
          : roleInstructions,
    };
  }
  let execArgs = prepareExec(task, env, jobId, goal, input, writes);
  const account =
    typeof execArgs.accountId === "string" && execArgs.accountId.trim()
      ? execArgs.accountId.trim()
      : undefined;

  // Register before dispatching, so a lost response is still covered.
  if (
    !app.pendingJobs.registerKnown(
      conversationId,
      task.job,
      jobId,
      goal,
      account,
      taskId,
    )
  )
    return json(
      {
        error:
          prefix +
          "Job status reading is invalid or disabled. The task was not registered.",
      },
      true,
    );

  const server = usesSandbox ? executor : task.server!;
  const failed = (detail: string): DispatchText => {
    app.pendingJobs.closeKnownUnstarted(jobId, conversationId);
    return json(
      { error: prefix + `Failed to start the task: ${detail}`.slice(0, 800) },
      true,
    );
  };
  let rediscovered = false;
  for (;;) {
    const attempt = signal
      ? AbortSignal.any([AbortSignal.timeout(20_000), signal])
      : AbortSignal.timeout(20_000);

    try {
      const tool = usesSandbox ? "execute" : task.exec.tool;
      const callArgs = usesSandbox
        ? { code: sandboxCall(task.exec.tool, execArgs) }
        : execArgs;
      const rawResult = await call(server, tool, callArgs, { signal: attempt });
      const outcome = classifyExecutorCall(rawResult);
      if (outcome.kind === "failure" && outcome.notFound && !rediscovered) {
        rediscovered = true;
        const again = await retarget(
          env,
          call,
          task,
          jobId,
          goal,
          input,
          execArgs,
          writes,
        );
        if (again.error) return failed(again.error);
        if (again.args) {
          execArgs = again.args;
          continue;
        }
      }
      if (outcome.kind === "approval") {
        // A scheduled run cannot wait for a card. The command has not run, so
        // refusing here neither repeats it nor needs a resume.
        if (app.scheduledTurn(conversationId))
          return { text: prefix + SCHEDULED_APPROVAL_REFUSAL, isError: true };
        // Nothing ran yet: leave the row open so a later approval delivers.
        let approvalRequested = false;
        try {
          approvalRequested = !!app.mcpCalls?.noteExecutorPause(
            conversationId,
            server,
            tool,
            callArgs,
            labelExecutorApproval(rawResult, prefix),
          );
        } catch {
          /* the tool result still reports the pending approval */
        }
        return {
          ...json({
            jobId,
            status: "approval_pending",
            ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
            message:
              prefix +
              "The call is paused for approval. The task has not started. Approve it using the card in this conversation. Do not repeat the request or say the job started.",
          }),
          approvalRequested,
        };
      }
      if (outcome.kind === "failure")
        return outcome.deterministic
          ? failed(outcome.message)
          : { text: prefix + JOB_INDETERMINATE };
      const exitCode = commandExitCode(outcome.value);
      if (exitCode !== undefined && exitCode !== 0) {
        const record = isRecord(outcome.value) ? outcome.value : {};
        const detail = [record.stderr, record.stdout]
          .filter((part) => typeof part === "string" && part.trim())
          .join("\n")
          .slice(0, 500);
        return failed(detail || `the launcher exited with code ${exitCode}`);
      }
      return json({
        jobId,
        status: "dispatched",
        message:
          prefix +
          "The task started in the sandbox. The result will arrive in this topic when it finishes; no follow-up is needed.",
      });
    } catch (error) {
      if (!rediscovered && missingMachine(error)) {
        rediscovered = true;
        const again = await retarget(
          env,
          call,
          task,
          jobId,
          goal,
          input,
          execArgs,
          writes,
        );
        if (again.error) return failed(again.error);
        if (again.args) {
          execArgs = again.args;
          continue;
        }
      }
      // Nothing was sent, or the server rejected the call before it ran.
      if (
        error instanceof PolicyError ||
        error instanceof McpNotSentError ||
        deterministicFailure(error)
      )
        return failed(error instanceof Error ? error.message : String(error));
      // Indeterminate timeout or transient error: keep the row open and
      // let the poller confirm via the manifest's observe tool.
      return { text: prefix + JOB_INDETERMINATE };
    }
  }
}

function asToolResult(outcome: DispatchText) {
  return {
    output: [{ type: "text" as const, text: outcome.text }],
    ...(outcome.isError ? { isError: true as const } : {}),
    ...(outcome.approvalRequested
      ? { details: { receiptApprovalRequested: true } }
      : {}),
  };
}

export function createSandboxCodeTaskTool(
  app: Runtime,
  env: Env = process.env,
) {
  const task = readTask(env);
  if (!task) return undefined;
  const { roles } = loadHarnessConfig(env);
  const writeRoles = Object.entries(roles ?? {})
    .filter(([, role]) => !role.readOnly)
    .map(([name]) => JSON.stringify(name))
    .join(", ");
  const parameters = roles
    ? {
        ...task.parameters,
        properties: {
          ...("properties" in task.parameters &&
          isRecord(task.parameters.properties)
            ? task.parameters.properties
            : {}),
          role: Type.String({
            description: `Configured write roles: ${writeRoles || "(none)"}. Requires writes=true.`,
          }),
        },
      }
    : task.parameters;
  const instabox = isInstabox(task);
  const patterns = allowPatterns(task.allow, env);
  const executor = (env.ASYNC_JOB_EXECUTOR ?? "").trim() || "executor";
  const usesSandbox =
    !task.server || task.server === "executor" || task.server === executor;
  app.mcpCalls?.setDeferredDispatch(async (spec) => {
    const conversationId =
      typeof spec.conversationId === "string" ? spec.conversationId : "";
    const input = isRecord(spec.input) ? spec.input : undefined;
    const taskId = typeof spec.taskId === "string" ? spec.taskId : undefined;
    const call = (app.options.gateway as { callDirect?: Call }).callDirect;
    if (!conversationId || input?.writes !== true || !call)
      return {
        state: "failed",
        text: `${taskId ? durableTaskJobPrefix(taskId) : ""}The write task did not start.`,
      };
    const outcome = await dispatchJob(
      app,
      env,
      task,
      executor,
      usesSandbox,
      { conversationId, taskId },
      input,
      call,
      true,
      undefined,
      typeof spec.roleInstructions === "string"
        ? spec.roleInstructions
        : undefined,
    );
    return {
      state: outcome.isError || outcome.rejected ? "failed" : "done",
      text: outcome.text,
    };
  });

  return defineTool({
    name: task.tool,
    description:
      task.description ??
      (instabox
        ? "Run code tasks with write access on Instabox. Use writes=true only with user authorization; starting the task requires approval in chat. Do not use for read-only tasks."
        : 'For any task that may take more than about 60 seconds or when asked to "let me know when it finishes", call this tool once. Do not poll in a loop. Starting the task does not block the conversation; the result arrives automatically. Use writes=true only for pushing, opening a pull request, or commenting (approval is required before the task starts). Otherwise, the task is read-only.'),
    parameters,
    replay: "safe",
    execute: async (
      args: Record<string, unknown>,
      api: ToolExecutionApi,
      callContext?: { abortSignal?: AbortSignal },
    ) => {
      const reply = (body: unknown) => ({
        output: [{ type: "text" as const, text: JSON.stringify(body) }],
      });
      const input = isRecord(args) ? args : {};
      const { role: roleName, ...taskInput } = input;
      let roleInstructions: string | undefined;
      if (typeof roleName === "string") {
        const role = findRole(roles, roleName);
        const name = JSON.stringify(roleName);
        const refuse = (text: string) => asToolResult({ text, isError: true });
        if (!role)
          return refuse(
            `Unknown sandbox code task role ${name}. Configured write roles: ${writeRoles || "(none)"}.`,
          );
        if (role.readOnly)
          return refuse(
            `Sandbox code task role ${name} is read-only. Use the subagent tool for this role.`,
          );
        if (input.writes !== true)
          return refuse(`Sandbox code task role ${name} requires writes=true.`);
        roleInstructions = role.instructions;
      }
      let valid = false;
      try {
        valid =
          (roleName === undefined || typeof roleName === "string") &&
          Value.Check(parameters, input);
      } catch {
        /* an invalid schema in config never becomes a caller error */
      }
      if (!valid) return reply({ error: "Invalid task parameters." });
      const allowedValue = task.allow
        ? String(input[task.allow.field] ?? "").trim()
        : "";
      if (task.allow && !isAllowed(allowedValue, patterns))
        return reply({
          error: `Value "${allowedValue}" is not allowed by policy (${patterns}).`,
        });

      if (instabox && input.writes !== true)
        return {
          output: [
            {
              type: "text" as const,
              text: "The shared Instabox does not accept read-only tasks. No task started. Do not switch to writes=true without user authorization to run with write access.",
            },
          ],
          isError: true,
        };

      const gateway = app.options.gateway as { callDirect?: Call };
      if (!gateway?.callDirect)
        return reply({
          error: "The direct MCP gateway is unavailable to start the job.",
        });
      const destination = app.resolveJobConversation(
        String(api.conversationId),
      );
      const { conversationId, taskId } = destination;
      const prefix = taskId ? durableTaskJobPrefix(taskId) : "";
      if (input.writes === true) {
        // A scheduled run cannot wait for a card, and nothing has been sent.
        if (app.scheduledTurn(conversationId))
          return {
            output: [
              {
                type: "text" as const,
                text: prefix + SCHEDULED_APPROVAL_REFUSAL,
              },
            ],
            isError: true,
          };
        const server = usesSandbox ? executor : task.server!;
        const requestId = app.mcpCalls?.noteDeferredApproval(
          conversationId,
          server,
          task.tool,
          prefix + writePreview(task, input),
          roleInstructions
            ? { ...destination, input: taskInput, roleInstructions }
            : { ...destination, input },
        );
        if (!requestId)
          return reply({
            error:
              prefix + "Approval is unavailable. The write task did not start.",
          });
        return {
          ...reply({
            status: "approval_pending",
            requestId,
            message:
              prefix +
              "Writing requires approval. The task has not started. Approve it using the card in this conversation. Do not repeat the request or say the job started.",
          }),
          details: { receiptApprovalRequested: true },
        };
      }
      return asToolResult(
        await dispatchJob(
          app,
          env,
          task,
          executor,
          usesSandbox,
          destination,
          input,
          gateway.callDirect,
          false,
          callContext?.abortSignal,
        ),
      );
    },
  });
}

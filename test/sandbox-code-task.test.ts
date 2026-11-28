import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { McpGateway } from "../src/mcp.js";
import {
  createSandboxCodeTaskTool,
  isAllowed,
  JOB_INDETERMINATE,
  sandboxTaskSteer,
} from "../src/sandbox-code-task.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { configureTelegram } from "../src/telegram-polling.js";
import { queueMcpApprovals } from "../src/telegram-approvals.js";
import type { Delivery } from "../src/store.js";

function executorCompleted(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: true, value },
        }),
      },
    ],
  };
}

function executorFailed(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: false, error },
        }),
      },
    ],
  };
}

function getText(result: { output?: unknown[] }): string {
  const item = result?.output?.[0] as { text?: string } | undefined;
  return item?.text ?? "";
}

async function sectionText(app: Runtime, key: string) {
  const found = (
    app as unknown as {
      registry: {
        snapshot: () => {
          extension: (name: string) => {
            sections?: {
              key: string;
              render: (
                ...args: unknown[]
              ) => Promise<string | undefined> | string | undefined;
            }[];
          };
        };
      };
    }
  ).registry
    .snapshot()
    .extension("personal-assistant")
    ?.sections?.find((item) => item.key === key);
  return (await found?.render(undefined, undefined)) ?? "";
}

async function createFixture(
  envOverrides: Record<string, string | undefined> = {},
  config?: string,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-task-test-"));
  const models = createModels();
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "mock-model" }],
  });
  models.setProvider(faux.provider);

  const calls: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
  }[] = [];
  let onCallDirect:
    | ((
        server: string,
        tool: string,
        args: Record<string, unknown>,
      ) => Promise<unknown>)
    | undefined;

  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
    },
    {
      name: "freestyle",
      url: "http://127.0.0.1:2/mcp",
      mode: "direct",
    },
  ]);
  gateway.catalog = async () => [];
  gateway.connectionBinding = async () => "mock-binding";
  gateway.callDirect = (async (
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    calls.push({ server, tool, args });
    if (onCallDirect) return onCallDirect(server, tool, args);
    return executorCompleted({
      stdout: JSON.stringify({ state: "PENDING" }),
      stderr: "",
      exitCode: 0,
    });
  }) as unknown as typeof gateway.callDirect;

  const env = {
    INSTABOX_MACHINE_ID: "machine-test-1",
    INSTABOX_ACCOUNT_ID: "acc-test-1",
    INSTABOX_REPO_ALLOWLIST: "example/*, allowed-owner/specific-repo",
    ...(config === undefined ? {} : { CONFIG_FILE: join(dir, "config.yaml") }),
    ...envOverrides,
  };
  if (config !== undefined) await writeFile(join(dir, "config.yaml"), config);

  const app = await Runtime.open({
    dir,
    gateway,
    models,
    modelId: faux.getModel().id,
    env,
  });

  return {
    app,
    faux,
    dir,
    env,
    calls,
    setCallDirectHandler: (
      fn: (
        server: string,
        tool: string,
        args: Record<string, unknown>,
      ) => Promise<unknown>,
    ) => {
      onCallDirect = fn;
    },
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Instabox rejects read-only jobs before discovery, approval or dispatch", async () => {
  const f = await createFixture({
    INSTABOX_MACHINE_ID: "",
    INSTABOX_ACCOUNT_ID: "",
  });
  try {
    const convId = await f.app.create("Read-only");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    for (const args of [{}, { writes: false }]) {
      const res = await tool.execute(
        { repo: "example/app", agent: "agy", prompt: "review", ...args },
        { conversationId: convId } as unknown as ToolExecutionApi,
        context,
      );
      assert.equal(res.isError, true);
      assert.match(getText(res), /does not accept read-only tasks/);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.app.mcpCalls!.interactions(convId).length, 0);
    assert.equal(jobCount(f.app, convId), 0);
  } finally {
    await f.close();
  }
});

function launched(calls: { tool: string; args: Record<string, unknown> }[]) {
  return calls
    .filter((call) => call.tool === "execute")
    .map((call) => String(call.args.code ?? ""));
}

function jobCount(app: Runtime, conversationId: string) {
  const table = app.store.get(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_jobs'",
  );
  if (!table) return 0;
  return (
    app.store.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM pending_jobs WHERE conversation_id=?",
      conversationId,
    )?.c ?? 0
  );
}

async function approveJob(app: Runtime, conversationId: string) {
  const interaction = app.mcpCalls!.interactions(conversationId)[0]!;
  await app.mcpCalls!.decide(conversationId, interaction.id, "accept", {});
  const call = app.mcpCalls!.list(conversationId)[0]!;
  const result = JSON.parse(call.result ?? "{}") as {
    content?: { text: string }[];
  };
  return result.content?.[0]?.text ?? "";
}

const APPROVAL_MESSAGE =
  "Writing requires approval. The task has not started. Approve it using the card in this conversation. Do not repeat the request or say the job started.";
const DISPATCH_MESSAGE =
  "The task started in the sandbox. The result will arrive in this topic when it finishes; no follow-up is needed.";
const SCHEDULED_REFUSAL = "needs approval; not available in scheduled runs";

function markScheduled(app: Runtime, conversationId: string) {
  app.store.run(
    "INSERT INTO requests(conversationId,requestId,text,source) VALUES (?,?,'Run job','task')",
    conversationId,
    "scheduled-job-test",
  );
}

async function taskRun(app: Runtime, origin: string) {
  const task = app.durableTasks.create(origin, "Run job");
  const run = await app.create("Durable task");
  app.store.run(
    "UPDATE durable_tasks SET state='running',runConversationId=? WHERE id=?",
    run,
    task.id,
  );
  markScheduled(app, run);
  assert.equal(app.scheduledTurn(run), true);
  assert.equal(app.scheduledTurn(origin), false);
  return { run, prefix: `Tarefa ${task.id.slice(0, 8)} · ` };
}

async function deliveryTopic(app: Runtime) {
  configureTelegram(
    app.store,
    { token: "synthetic", users: ["42"], chats: ["-100123"] },
    { id: 123 },
  );
  return app.telegramChats.ensure({
    chat: "-100123",
    user: "42",
    messageThreadId: 11,
  });
}

async function expectJobDelivery(app: Runtime, origin: string, text: string) {
  await app.pendingJobs.tick();
  await (await app.conversation(origin)).waitForIdle(context);
  const jobRequest = () =>
    app.store.get<{ status: string }>(
      "SELECT status FROM requests WHERE conversationId=? AND source='job'",
      origin,
    );
  assert.ok(jobRequest(), "the poller submitted the result to the origin");
  for (
    let attempt = 0;
    attempt < 200 && jobRequest()?.status === "pending";
    attempt++
  )
    await delay(5);
  assert.equal(jobRequest()?.status, "done");
  const deliveries = app.store.all<Delivery>(
    "SELECT * FROM deliveries WHERE id LIKE '%:notify:completion:%'",
  );
  assert.deepEqual(
    deliveries.map(({ chat, messageThreadId, text }) => ({
      chat,
      messageThreadId,
      text,
    })),
    [{ chat: "-100123", messageThreadId: 11, text: `${text}\n\n` }],
  );
}

test("writes=true waits for approval and dispatches only after accept", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Write");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const prompt = "abra um PR https://example.test/secret com o parser";
    const pending = await tool.execute(
      {
        repo: "example/app",
        agent: "agy",
        prompt,
        branch: "feature/x",
        writes: true,
      },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    const output = JSON.parse(getText(pending)) as {
      status: string;
      requestId?: string;
    };
    assert.equal(output.status, "approval_pending");
    assert.match(output.requestId ?? "", /^exec_local_/);
    assert.deepEqual(output, {
      status: "approval_pending",
      requestId: output.requestId,
      message: APPROVAL_MESSAGE,
    });
    assert.equal(launched(f.calls).length, 0);
    assert.equal(jobCount(f.app, convId), 0);
    const interaction = f.app.mcpCalls!.interactions(convId)[0]!;
    const payload = JSON.parse(interaction.payload) as {
      protocol: string;
      requestId: string;
      executionId: string;
      elicitation: {
        message: string;
        requestedSchema: { type: string; properties: Record<string, unknown> };
      };
    };
    assert.equal(payload.protocol, "executor");
    assert.equal(payload.executionId, payload.requestId);
    assert.equal(payload.elicitation.requestedSchema.type, "object");
    assert.equal(
      Object.keys(payload.elicitation.requestedSchema.properties).length,
      0,
    );
    const message = payload.elicitation.message;
    assert.equal(
      message,
      "Code task with write access\nrepo: example/app\nagent: agy\nbranch: feature/x\nprompt: abra um PR [link] com o parser",
    );
    assert.match(message, /example\/app/);
    assert.match(message, /agy/);
    assert.match(message, /feature\/x/);
    assert.match(message, /\[link\]/);
    assert.doesNotMatch(message, /example\.test/);
    const dispatched = JSON.parse(await approveJob(f.app, convId)) as {
      status: string;
      jobId: string;
    };
    assert.equal(dispatched.status, "dispatched");
    assert.match(dispatched.jobId, /^cj-[a-z0-9-]+$/);
    assert.deepEqual(dispatched, {
      status: "dispatched",
      jobId: dispatched.jobId,
      message: DISPATCH_MESSAGE,
    });
    assert.equal(f.calls[0]?.server, "executor");
    assert.equal(f.calls[0]?.tool, "execute");
    const execInput = JSON.parse(
      /machines\.exec\((\{.*\})\)/.exec(launched(f.calls).at(-1) ?? "")?.[1] ??
        "null",
    ) as {
      accountId: string;
      input: { id: string; cmd: string; stdin: string; timeoutSeconds: number };
    };
    assert.equal(execInput.accountId, "acc-test-1");
    assert.equal(execInput.input.id, "machine-test-1");
    assert.equal(execInput.input.timeoutSeconds, 15);
    assert.equal(
      execInput.input.cmd,
      "bash ~/bin/start-job.sh " + dispatched.jobId,
    );
    assert.doesNotMatch(execInput.input.cmd, /JOB_READONLY/);
    const body = JSON.parse(execInput.input.stdin) as {
      prompt: string;
      writes: boolean;
    };
    assert.equal(body.prompt, prompt);
    assert.equal(body.writes, true);
    const row = f.app.store.get<{ run_id: string; tool: string }>(
      "SELECT run_id, tool FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.equal(row?.run_id, dispatched.jobId);
    assert.equal(row?.tool, "internal.instabox.codeTask");
  } finally {
    await f.close();
  }
});

test("writes=true in a normal scheduled conversation still refuses approval", async () => {
  const f = await createFixture();
  try {
    const origin = await f.app.create("Scheduled write");
    markScheduled(f.app, origin);
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const result = await tool.execute(
      { repo: "example/app", agent: "pi", prompt: "Run job", writes: true },
      { conversationId: origin } as unknown as ToolExecutionApi,
      context,
    );
    assert.equal(result.isError, true);
    assert.equal(getText(result), SCHEDULED_REFUSAL);
    assert.equal(f.app.mcpCalls!.interactions(origin).length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(jobCount(f.app, origin), 0);
  } finally {
    await f.close();
  }
});

test("an Executor approval outcome still refuses if a normal conversation became scheduled", async () => {
  const f = await createFixture();
  try {
    const origin = await f.app.create("Scheduled during dispatch");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const pending = await tool.execute(
      { repo: "example/app", agent: "pi", prompt: "Run job", writes: true },
      { conversationId: origin } as unknown as ToolExecutionApi,
      context,
    );
    assert.equal(JSON.parse(getText(pending)).status, "approval_pending");
    markScheduled(f.app, origin);
    f.setCallDirectHandler(async () => ({
      status: "approval-required",
      requestId: "apr_executor_test",
    }));
    assert.equal(await approveJob(f.app, origin), SCHEDULED_REFUSAL);
    assert.equal(f.app.mcpCalls!.interactions(origin).length, 1);
  } finally {
    await f.close();
  }
});

test("a durable write job queues the approval card and result in the task's origin topic", async () => {
  const f = await createFixture();
  try {
    const origin = await deliveryTopic(f.app);
    const { run, prefix } = await taskRun(f.app, origin);
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const pending = await tool.execute(
      { repo: "example/app", agent: "pi", prompt: "Run job", writes: true },
      { conversationId: run } as unknown as ToolExecutionApi,
      context,
    );
    assert.equal(pending.isError, undefined, getText(pending));
    const receipt = JSON.parse(getText(pending));
    assert.equal(receipt.status, "approval_pending");
    assert.equal(receipt.message, prefix + APPROVAL_MESSAGE);
    assert.equal(f.app.mcpCalls!.interactions(run).length, 0);
    assert.equal(launched(f.calls).length, 0);
    const [interaction] = f.app.mcpCalls!.interactions(origin);
    assert.ok(interaction);
    const preview = `${prefix}Code task with write access\nrepo: example/app\nagent: pi\nbranch: (job default)\nprompt: Run job`;
    assert.equal(JSON.parse(interaction.payload).elicitation.message, preview);
    queueMcpApprovals(f.app);
    const card = f.app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id LIKE ?",
      `%${interaction.id}%`,
    );
    assert.equal(card?.messageThreadId, 11);
    assert.ok(card?.text.includes(preview));
    assert.match(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:markup:${card.id}`,
      )?.value ?? "",
      /"text":"Approve"/,
    );
    assert.equal(jobCount(f.app, origin), 0);

    const dispatched = JSON.parse(await approveJob(f.app, origin));
    assert.equal(dispatched.status, "dispatched");
    assert.equal(dispatched.message, prefix + DISPATCH_MESSAGE);
    assert.equal(jobCount(f.app, origin), 1);
    assert.equal(jobCount(f.app, run), 0);

    f.setCallDirectHandler(async () =>
      executorCompleted({
        path: `/data/home/jobs/${dispatched.jobId}/status.json`,
        type: "file",
        content: JSON.stringify({ state: "DONE", result: "Patch ready." }),
      }),
    );
    f.faux.setResponses([fauxAssistantMessage("Patch ready.")]);
    await expectJobDelivery(f.app, origin, `${prefix}Patch ready.`);

    markScheduled(f.app, origin);
    const refused = await tool.execute(
      { repo: "example/app", agent: "pi", prompt: "Run again", writes: true },
      { conversationId: run } as unknown as ToolExecutionApi,
      context,
    );
    assert.equal(refused.isError, true);
    assert.equal(getText(refused), prefix + SCHEDULED_REFUSAL);
    assert.equal(f.app.mcpCalls!.interactions(origin).length, 1);
  } finally {
    await f.close();
  }
});

const ROLE_CONFIG = `roles:
  coder:
    instructions: Keep the patch focused.
    readOnly: false
  reviewer:
    instructions: Check for regressions.
`;

test("a write role keeps the approval flow and sends its instructions with the job", async () => {
  const f = await createFixture({}, ROLE_CONFIG);
  try {
    const convId = await f.app.create("Write as coder");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const args = {
      repo: "example/app",
      agent: "pi",
      prompt: "Fix the parser.",
      writes: true,
    };
    const pending = await tool.execute(
      { ...args, role: "coder" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.equal(JSON.parse(getText(pending)).status, "approval_pending");
    assert.equal(f.app.mcpCalls!.interactions(convId).length, 1);
    assert.equal(launched(f.calls).length, 0);
    assert.equal(jobCount(f.app, convId), 0);
    assert.equal(
      JSON.parse(await approveJob(f.app, convId)).status,
      "dispatched",
    );
    assert.equal(launched(f.calls).length, 1);
    const execInput = JSON.parse(
      /machines\.exec\((\{.*\})\)/.exec(launched(f.calls)[0]!)?.[1] ?? "null",
    ) as { input: { stdin: string } };
    assert.deepEqual(JSON.parse(execInput.input.stdin), {
      ...args,
      prompt: "Fix the parser.\n\nKeep the patch focused.",
    });
    const agent = await (await f.app.conversation(convId)).agent(context);
    const listed = agent.tools.find((item) => item.name === tool.name);
    assert.ok(listed);
    assert.partialDeepStrictEqual(listed.parameters, {
      properties: { role: { type: "string" } },
    });
    assert.deepEqual((listed.parameters as { required: string[] }).required, [
      "repo",
      "agent",
      "prompt",
    ]);
  } finally {
    await f.close();
  }
});

test("read and unknown roles and write roles without writes=true create no approval or job", async () => {
  const f = await createFixture({}, ROLE_CONFIG);
  try {
    const convId = await f.app.create("Refuse roles");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const api = { conversationId: convId } as unknown as ToolExecutionApi;
    const args = {
      repo: "example/app",
      agent: "pi",
      prompt: "Fix the parser.",
    };
    for (const [role, writes, message] of [
      [
        "reviewer",
        true,
        'Sandbox code task role "reviewer" is read-only. Use the subagent tool for this role.',
      ],
      [
        "missing",
        true,
        'Unknown sandbox code task role "missing". Configured write roles: "coder".',
      ],
      ["coder", false, 'Sandbox code task role "coder" requires writes=true.'],
    ] as const) {
      const result = await tool.execute(
        { ...args, role, writes },
        api,
        context,
      );
      assert.equal(result.isError, true);
      assert.equal(getText(result), message);
    }
    assert.equal(f.app.mcpCalls!.interactions(convId).length, 0);
    assert.equal(jobCount(f.app, convId), 0);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("writes=true decline does not dispatch", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Deny");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    await tool.execute(
      {
        repo: "example/app",
        agent: "pi",
        prompt: "comente no PR",
        writes: true,
      },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    const interaction = f.app.mcpCalls!.interactions(convId)[0]!;
    assert.match(interaction.payload, /branch: \(job default\)/);
    await f.app.mcpCalls!.decide(convId, interaction.id, "decline");
    assert.equal(launched(f.calls).length, 0);
    assert.equal(jobCount(f.app, convId), 0);
    assert.equal(f.app.mcpCalls!.list(convId)[0]?.state, "abandoned");
  } finally {
    await f.close();
  }
});

test("validation rejects a disallowed repo, bad agent and empty prompt", async () => {
  assert.equal(isAllowed("example/repo", "example/*"), true);
  assert.equal(isAllowed("other/repo", "example/*"), false);
  assert.equal(isAllowed("example/..", "example/*"), false);
  assert.equal(isAllowed("example/.", "*"), false);
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const api = { conversationId: convId } as unknown as ToolExecutionApi;
    const cases = [
      { repo: "evil/repo", agent: "pi", prompt: "x" },
      { repo: "example/repo", agent: "nope", prompt: "x" },
      { repo: "example/repo", agent: "pi", prompt: "   " },
      { repo: "bad-format", agent: "pi", prompt: "x" },
    ];
    for (const args of cases) {
      const res = await tool.execute(args, api, context);
      assert.match(getText(res), /"error"/);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("deterministic dispatch failure closes the row", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    f.setCallDirectHandler(async () =>
      executorFailed({
        kind: "ToolCallFailed",
        message: "machine not running",
        response: { status: 400, code: "bad_request", retryable: false },
      }),
    );
    const res = await tool.execute(
      { repo: "example/repo", agent: "pi", prompt: "rode", writes: true },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.match(getText(res), /approval_pending/);
    assert.match(await approveJob(f.app, convId), /Failed to start the task/);
    const row = f.app.store.get<{ outcome: string | null }>(
      "SELECT outcome FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.equal(row?.outcome, "dispatch_error");
  } finally {
    await f.close();
  }
});

test("indeterminate timeout keeps the row open for the poller", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    f.setCallDirectHandler(async () => {
      throw new Error("TimeoutError: The operation timed out");
    });
    const res = await tool.execute(
      { repo: "example/repo", agent: "pi", prompt: "rode", writes: true },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.match(getText(res), /approval_pending/);
    assert.equal(await approveJob(f.app, convId), JOB_INDETERMINATE);
    const row = f.app.store.get<{ delivered_at: number | null }>(
      "SELECT delivered_at FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.equal(row?.delivered_at, null);
  } finally {
    await f.close();
  }
});

const FREESTYLE_CONFIG = [
  "async_jobs:",
  "  freestyle:",
  "    tool: freestyle.jobs.start",
  "    server: freestyle",
  "    dispatch:",
  "      mode: immediate",
  "    observe:",
  "      mode: poll",
  "      tool: freestyle.jobs.get",
  "      args:",
  '        id: "${id}"',
  "      statePath: state",
  "      resultPath: result",
  "sandbox_code_task:",
  "  tool: sandbox_code_task",
  "  job: freestyle.jobs.start",
  "  idPrefix: fs-",
  "  server: freestyle",
  "  goal: task",
  "  requires: []",
  "  allow: null",
  "  exec:",
  "    tool: freestyle.jobs.start",
  "    args:",
  "      accountId: null",
  "      input: null",
  '      task: "${payload}"',
  "  parameters:",
  "    type: object",
  "    required: [task]",
  "    properties:",
  "      task:",
  "        type: string",
  "",
].join("\n");

test("a config file swaps the sandbox without code changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, FREESTYLE_CONFIG);
  const f = await createFixture({
    CONFIG_FILE: configPath,
    DATA_DIR: root,
  });
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const res = await tool.execute(
      { task: "gerar" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    const output = JSON.parse(getText(res)) as {
      jobId: string;
      status: string;
    };
    assert.equal(output.status, "dispatched");
    assert.match(output.jobId, /^fs-/);
    assert.deepEqual(output, {
      jobId: output.jobId,
      status: "dispatched",
      message: DISPATCH_MESSAGE,
    });
    assert.deepEqual(f.calls[0], {
      server: "freestyle",
      tool: "freestyle.jobs.start",
      args: { task: JSON.stringify({ task: "gerar", writes: false }) },
    });
    const row = f.app.store.get<{ tool: string }>(
      "SELECT tool FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.equal(row?.tool, "freestyle.jobs.start");
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable read-only job registers and reports in the task's origin topic", async () => {
  const f = await createFixture({}, FREESTYLE_CONFIG);
  try {
    const origin = await deliveryTopic(f.app);
    const { run, prefix } = await taskRun(f.app, origin);
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const result = await tool.execute(
      { task: "Review the parser", writes: false },
      { conversationId: run } as unknown as ToolExecutionApi,
      context,
    );
    const dispatched = JSON.parse(getText(result));
    assert.equal(dispatched.status, "dispatched");
    assert.equal(dispatched.message, prefix + DISPATCH_MESSAGE);
    assert.equal(jobCount(f.app, origin), 1);
    assert.equal(jobCount(f.app, run), 0);
    assert.equal(f.app.mcpCalls!.interactions(origin).length, 0);

    f.setCallDirectHandler(async () =>
      executorCompleted({
        run_id: dispatched.jobId,
        state: "DONE",
        result: "Review ready.",
      }),
    );
    f.faux.setResponses([fauxAssistantMessage("Review ready.")]);
    await expectJobDelivery(f.app, origin, `${prefix}Review ready.`);
  } finally {
    await f.close();
  }
});

test("an Executor approval outcome for a durable job uses the origin topic and task prefix", async () => {
  const f = await createFixture({}, FREESTYLE_CONFIG);
  try {
    const origin = await deliveryTopic(f.app);
    const { run, prefix } = await taskRun(f.app, origin);
    f.setCallDirectHandler(async () => ({
      status: "approval-required",
      requestId: "apr_executor_task_test",
      executionId: "exec_task_test",
      message: "Confirm this sandbox action.",
    }));
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const result = await tool.execute(
      { task: "Review the parser" },
      { conversationId: run } as unknown as ToolExecutionApi,
      context,
    );
    assert.equal(result.isError, undefined, getText(result));
    const pending = JSON.parse(getText(result));
    assert.equal(pending.status, "approval_pending");
    assert.equal(pending.requestId, "apr_executor_task_test");
    assert.equal(
      pending.message,
      `${prefix}The call is paused for approval. The task has not started. Approve it using the card in this conversation. Do not repeat the request or say the job started.`,
    );
    assert.equal(jobCount(f.app, origin), 1);
    assert.equal(jobCount(f.app, run), 0);
    assert.equal(f.app.mcpCalls!.interactions(run).length, 0);
    const [interaction] = f.app.mcpCalls!.interactions(origin);
    assert.ok(interaction);
    const payload = JSON.parse(interaction.payload);
    assert.equal(payload.executionId, "exec_task_test");
    assert.equal(
      payload.elicitation.message,
      `${prefix}Confirm this sandbox action.`,
    );
  } finally {
    await f.close();
  }
});

test("the tool stays registered when the machine env vars are unset", async () => {
  const f = await createFixture({
    INSTABOX_MACHINE_ID: "",
    INSTABOX_ACCOUNT_ID: "",
  });
  try {
    const tool = createSandboxCodeTaskTool(f.app, f.env);
    assert.equal(tool?.name, "sandbox_code_task");
    const steer = sandboxTaskSteer(f.env);
    assert.match(steer ?? "", /sandbox_code_task/);
    const convId = await f.app.create("Test Conv");
    const agent = await (await f.app.conversation(convId)).agent(context);
    assert.equal(
      agent.tools.some((t: { name: string }) => t.name === "sandbox_code_task"),
      true,
    );
    assert.equal(await sectionText(f.app, "long-task"), steer);
  } finally {
    await f.close();
  }
});

test("a machine-not-found exec clears the cache and dispatches the machine found next", async () => {
  const f = await createFixture({
    INSTABOX_MACHINE_ID: "",
    INSTABOX_ACCOUNT_ID: "",
  });
  let lists = 0;
  let execs = 0;
  f.setCallDirectHandler(async (_server, tool, args) => {
    if (tool === "search")
      return {
        namespaces: [
          {
            path: "tools.instabox",
            accounts: "instabox: acc-live (example)",
          },
        ],
      };
    const code = String(args.code ?? "");
    if (code.includes("machines.list")) {
      lists += 1;
      return executorCompleted({
        machines: [
          {
            id: lists === 1 ? "m_old" : "m_new",
            name: "box",
            state: "running",
          },
        ],
      });
    }
    execs += 1;
    if (execs === 1)
      return executorFailed({
        message: "machine not found",
        response: { status: 404, code: "not_found" },
      });
    return executorCompleted({ stdout: "", stderr: "", exitCode: 0 });
  });
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const res = await tool.execute(
      { repo: "example/repo", agent: "pi", prompt: "rode", writes: true },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.match(getText(res), /approval_pending/);
    const output = JSON.parse(await approveJob(f.app, convId)) as {
      status: string;
    };
    assert.equal(output.status, "dispatched");
    assert.equal(lists, 2);
    assert.equal(execs, 2);
    const codes = f.calls
      .filter((call) => call.tool === "execute")
      .map((call) => String(call.args.code ?? ""));
    const launches = codes.filter((code) => code.includes("machines.exec"));
    assert.equal(launches.length, 2);
    assert.match(launches[0] ?? "", /m_old/);
    assert.match(launches[1] ?? "", /m_new/);
    assert.match(launches[1] ?? "", /acc-live/);
    assert.doesNotMatch(launches[1] ?? "", /m_old/);
    const row = f.app.store.get<{ delivered_at: number | null }>(
      "SELECT delivered_at FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.equal(row?.delivered_at, null);
  } finally {
    await f.close();
  }
});

test("repo allowlist is empty until config.yaml or the env override sets it", async () => {
  const empty = await mkdtemp(join(tmpdir(), "pi-sandbox-allow-empty-"));
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-allow-"));
  await writeFile(
    join(root, "config.yaml"),
    ["sandbox_code_task:", "  allow:", '    patterns: "other-org/*"', ""].join(
      "\n",
    ),
  );
  const plain = await createFixture({
    DATA_DIR: empty,
    INSTABOX_REPO_ALLOWLIST: undefined,
  });
  const custom = await createFixture({
    DATA_DIR: root,
    INSTABOX_REPO_ALLOWLIST: undefined,
  });
  const fromEnv = await createFixture({
    DATA_DIR: root,
    INSTABOX_REPO_ALLOWLIST: "env-org/only",
  });
  const run = async (
    f: Awaited<ReturnType<typeof createFixture>>,
    repo: string,
  ) => {
    const convId = await f.app.create("Allow");
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const res = await tool.execute(
      { repo, agent: "pi", prompt: "x", writes: true },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    return getText(res);
  };
  try {
    assert.match(await run(plain, "example/repo"), /not allowed/);
    assert.match(await run(plain, "other-org/repo"), /not allowed/);
    assert.match(await run(custom, "other-org/repo"), /"approval_pending"/);
    assert.match(await run(custom, "example/repo"), /not allowed/);
    assert.match(await run(fromEnv, "env-org/only"), /"approval_pending"/);
    assert.match(await run(fromEnv, "other-org/repo"), /not allowed/);
  } finally {
    await plain.close();
    await custom.close();
    await fromEnv.close();
    await rm(empty, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a configured sandbox task is on the model tool list and the prompt forbids polling it", async () => {
  const f = await createFixture();
  try {
    const tool = createSandboxCodeTaskTool(f.app, f.env)!;
    const steer = sandboxTaskSteer(f.env);
    assert.ok(steer);
    assert.match(steer, new RegExp(tool.name));
    assert.match(steer, /writes=true/);
    assert.match(steer, /Do not use this tool for read-only work/);
    assert.match(steer, /Never poll/);
    const convId = await f.app.create("Test Conv");
    const agent = await (await f.app.conversation(convId)).agent(context);
    const listed = agent.tools.find(
      (item: { name: string; description?: string }) => item.name === tool.name,
    );
    assert.ok(listed);
    assert.match(listed.description ?? "", /writes=true/);
    assert.match(listed.description ?? "", /Do not use it for read-only tasks/);
    const prompt = await sectionText(f.app, "long-task");
    assert.equal(prompt, steer);
  } finally {
    await f.close();
  }
});

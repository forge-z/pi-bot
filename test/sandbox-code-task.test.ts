import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
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
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-task-test-"));
  const models = createModels();
  models.setProvider(
    fauxProvider({
      provider: "faux",
      models: [{ id: "mock-model" }],
    }).provider,
  );

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
    ...envOverrides,
  };

  const app = await Runtime.open({
    dir,
    gateway,
    models,
    env,
  });

  return {
    app,
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

test("a config file swaps the sandbox without code changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "config.yaml");
  await writeFile(
    configPath,
    [
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
    ].join("\n"),
  );
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

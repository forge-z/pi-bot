import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import { McpGateway, mcpToolName } from "../src/mcp.js";
import { Runtime } from "../src/runtime.js";
import {
  SUBAGENT_CHILD_INSTRUCTIONS,
  SUBAGENT_MEDIA_OMITTED,
  SUBAGENT_WRITE_REFUSAL,
  subagentRule,
} from "../src/subagents.js";
import { summarizeConversationTreeUsage } from "../src/conversation-usage.js";

const ENABLED = "subagents:\n  enabled: true\n";
const SEARCH = mcpToolName("mock", "search");
const EXECUTE = mcpToolName("mock", "execute");
/** A large MCP read the child sees and the parent must never carry. */
const BIG_MARKER = "FEED-DUMP-";
const BIG_RESULT = `${BIG_MARKER}${"x".repeat(50_000)}`;

type Step = (
  ctx: Parameters<FauxResponseFactory>[0],
  options: Parameters<FauxResponseFactory>[1],
) => ReturnType<FauxResponseFactory>;

function sections(messages: readonly Message[]) {
  const system = messages.find((message) => message.role === "system") as
    { sections?: Record<string, unknown> } | undefined;
  return system?.sections ?? {};
}

function isChild(messages: readonly Message[]) {
  const instructions = sections(messages).instructions;
  return (
    typeof instructions === "string" &&
    instructions.includes(SUBAGENT_CHILD_INSTRUCTIONS)
  );
}

function textOf(message: Message | undefined) {
  if (!message) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part?.type === "text" ? (part.text ?? "") : "",
    )
    .join("");
}

/** The child's task: its first user message. */
function taskOf(messages: readonly Message[]) {
  return textOf(messages.find((message) => message.role === "user"));
}

function toolResults(messages: readonly Message[]) {
  return messages.filter((message) => message.role === "toolResult");
}

function call(
  name: string,
  args: Parameters<typeof fauxToolCall>[1],
  id: string,
) {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], {
    stopReason: "toolUse",
  });
}

interface Fixture {
  dir: string;
  app: Runtime;
  gateway: McpGateway;
  sent: { tool: string; args: unknown }[];
  parentRequests: Message[][];
  childRequests: { messages: Message[]; reasoning: unknown }[];
  failures: unknown[];
}

/**
 * One faux model serves the parent and every child. Child requests are routed
 * by their instructions section; parent requests take the next scripted step.
 */
async function open(options: {
  config?: string;
  parent: Step[];
  child?: Step;
  direct?: (
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  dir?: string;
}): Promise<Fixture> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "pi-subagents-")));
  const configFile = join(dir, "config.yaml");
  await writeFile(configFile, options.config ?? "");
  process.env.CONFIG_FILE = configFile;
  const gateway = new McpGateway([
    { name: "mock", url: "http://127.0.0.1:1/mcp", mode: "direct" },
  ]);
  gateway.catalog = async () => [
    {
      server: "mock",
      mode: "direct",
      tools: ["search", "execute"].map((name) => ({
        name,
        description: `${name} the feed`,
        inputSchema: { type: "object" },
        operation: "direct",
      })),
    },
  ];
  gateway.connectionBinding = async () => "binding";
  const sent: Fixture["sent"] = [];
  gateway.callDirect = (async (
    _server: string,
    tool: string,
    args: unknown,
    callOptions?: { signal?: AbortSignal },
  ) => {
    sent.push({ tool, args });
    if (options.direct) return options.direct(tool, args, callOptions?.signal);
    return { content: [{ type: "text", text: BIG_RESULT }] };
  }) as unknown as typeof gateway.callDirect;
  const parentRequests: Message[][] = [];
  const childRequests: Fixture["childRequests"] = [];
  const queue = [...options.parent];
  // An assertion inside a step surfaces as a model error; keep the real one.
  const failures: unknown[] = [];
  const route: FauxResponseFactory = async (ctx, streamOptions) => {
    try {
      const messages = structuredClone(ctx.messages) as Message[];
      if (isChild(messages)) {
        childRequests.push({ messages, reasoning: streamOptions?.reasoning });
        assert.ok(options.child, "unexpected child request");
        return await options.child(ctx, streamOptions);
      }
      parentRequests.push(messages);
      const step = queue.shift();
      assert.ok(step, "unexpected parent request");
      return await step(ctx, streamOptions);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  };
  const faux = fauxProvider({
    models: [{ id: "faux-1", reasoning: true }],
  });
  faux.setResponses(Array.from({ length: 60 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, gateway, models, effort: "high" });
  return { dir, app, gateway, sent, parentRequests, childRequests, failures };
}

async function close(fixture: Fixture) {
  await fixture.app.close();
  await fixture.gateway.close();
  await rm(fixture.dir, { recursive: true, force: true });
  if (fixture.failures.length) throw fixture.failures[0];
}

async function idle(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function children(app: Runtime, id: string) {
  const page = await app.harness.commit(
    (tx) =>
      tx.scanConversations(
        { ownerConversationId: Number(id) as ConversationId },
        100,
      ),
    context,
  );
  return page.items.map((item) => String(item.id));
}

function lastToolResultText(messages: readonly Message[]) {
  return textOf(toolResults(messages).at(-1));
}

test("off by default: no subagent tool and no subagents section", async () => {
  const fixture = await open({
    parent: [
      async (ctx) => {
        const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
        assert.equal(names.includes("subagent"), false);
        assert.equal("subagents" in sections(ctx.messages), false);
        return fauxAssistantMessage("ok");
      },
    ],
  });
  try {
    const id = await fixture.app.create();
    await fixture.app.submit(id, "turn", "oi", "web");
    await idle(fixture.app, id);
    assert.equal(fixture.parentRequests.length, 1);
  } finally {
    await close(fixture);
  }
});

test("one delegation returns only the child's final text, with a read-only tool set", async () => {
  const fixture = await open({
    config: `${ENABLED}  thinking: low\n`,
    parent: [
      async (ctx) => {
        const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
        assert.equal(names.includes("subagent"), true);
        assert.equal(sections(ctx.messages).subagents, subagentRule(3));
        return call(
          "subagent",
          { task: "Compare três leitores de RSS públicos" },
          "d1",
        );
      },
      async (ctx) => {
        const result = lastToolResultText(ctx.messages);
        assert.match(result, /Resumo: Leitor A, Leitor B e Leitor C/);
        assert.match(result, /untrusted_tool_result source="subagent"/);
        assert.equal(JSON.stringify(ctx.messages).includes(BIG_MARKER), false);
        return fauxAssistantMessage("Aqui está a comparação.");
      },
      async (ctx) => {
        assert.equal(JSON.stringify(ctx.messages).includes(BIG_MARKER), false);
        return fauxAssistantMessage("De nada.");
      },
    ],
    child: async (ctx) => {
      const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
      for (const absent of [
        "subagent",
        "progress",
        "notify",
        "tasks_list",
        "tasks_create",
        "ask_user",
        "send_attachment",
        "sandbox_code_task",
        "conversation_usage",
        "read_skill",
      ])
        assert.equal(names.includes(absent), false, absent);
      assert.equal(names.includes(SEARCH), true);
      if (toolResults(ctx.messages).length === 0)
        return call(SEARCH, { query: "rss" }, "c1");
      assert.match(lastToolResultText(ctx.messages), new RegExp(BIG_MARKER));
      return fauxAssistantMessage("Resumo: Leitor A, Leitor B e Leitor C.");
    },
  });
  try {
    const id = await fixture.app.create();
    await fixture.app.submit(id, "turn-1", "Compare leitores de RSS", "web");
    await idle(fixture.app, id);
    await fixture.app.submit(id, "turn-2", "Obrigado", "web");
    await idle(fixture.app, id);
    assert.equal(fixture.parentRequests.length, 3);
    assert.equal(fixture.childRequests.length, 2);
    assert.equal(
      fixture.childRequests.every((request) => request.reasoning === "low"),
      true,
    );
    assert.equal(fixture.sent.length, 1);
    assert.equal((await children(fixture.app, id)).length, 1);
  } finally {
    await close(fixture);
  }
});

test("tasks run in parallel, come back in order, and one failure keeps the others", async () => {
  let started = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => (release = resolve));
  const fixture = await open({
    config: `${ENABLED}  max_turns: 1\n`,
    parent: [
      async () =>
        call(
          "subagent",
          { tasks: ["a", "b", "c", "d"].map((task) => ({ task })) },
          "too-many",
        ),
      async (ctx) => {
        const last = toolResults(ctx.messages).at(-1) as {
          isError?: boolean;
        };
        assert.equal(last.isError, true);
        return call(
          "subagent",
          {
            tasks: [
              { task: "tarefa alfa" },
              { task: "tarefa beta" },
              { task: "tarefa gama" },
            ],
          },
          "three",
        );
      },
      async (ctx) => {
        const result = lastToolResultText(ctx.messages);
        const one = result.indexOf("## Task 1\nresposta alfa");
        const two = result.indexOf("## Task 2\nresposta beta");
        const three = result.indexOf(
          "## Task 3\n[task 3 returned no answer: turn_limit]",
        );
        assert.ok(one >= 0 && one < two && two < three, result);
        return fauxAssistantMessage("feito");
      },
    ],
    child: async (ctx) => {
      const task = taskOf(ctx.messages);
      if (toolResults(ctx.messages).length === 0) {
        started += 1;
        if (started === 3) release();
        // Every child is mid-request before any of them answers.
        await Promise.race([
          allStarted,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        assert.equal(started, 3);
      }
      if (task === "tarefa gama") return call(SEARCH, {}, "loop");
      return fauxAssistantMessage(`resposta ${task.split(" ")[1]}`);
    },
    direct: async () => ({ content: [{ type: "text", text: "item" }] }),
  });
  try {
    const id = await fixture.app.create();
    await fixture.app.submit(id, "turn", "Pesquise três coisas", "web");
    await idle(fixture.app, id);
    assert.equal(fixture.parentRequests.length, 3);
    assert.equal((await children(fixture.app, id)).length, 3);
  } finally {
    await close(fixture);
  }
});

test("a child sends reads, refuses writes before sending, and skips approval and media", async () => {
  const APPROVAL = {
    status: "approval-required",
    requestId: "apr_child",
    expiresAt: Date.now() + 60_000,
    invocation: { app: "notes", tool: "create", input: {} },
  };
  let dispatches = 0;
  const fixture = await open({
    config: ENABLED,
    parent: [
      async () => call("subagent", { task: "Leia as notas" }, "web-1"),
      async () => fauxAssistantMessage("ok web"),
      async () => call("subagent", { task: "Leia as notas" }, "task-1"),
      async () => fauxAssistantMessage("ok task"),
    ],
    child: async (ctx) => {
      const round = toolResults(ctx.messages).length;
      if (round === 0) return call(EXECUTE, { code: "delete all" }, "w");
      if (round === 1) {
        assert.equal(lastToolResultText(ctx.messages), SUBAGENT_WRITE_REFUSAL);
        return call(SEARCH, { query: "approval" }, "r1");
      }
      if (round === 2) return call(SEARCH, { query: "file" }, "r2");
      assert.equal(lastToolResultText(ctx.messages), SUBAGENT_MEDIA_OMITTED);
      return fauxAssistantMessage("Nada a relatar.");
    },
    direct: async (_tool, args) => {
      const query = (args as { query?: string }).query;
      if (query === "approval")
        return { content: [], structuredContent: APPROVAL };
      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: "file:///relatorio.pdf",
              mimeType: "application/pdf",
              blob: Buffer.from("%PDF-1.4 relatorio").toString("base64"),
            },
          },
        ],
      };
    },
  });
  const begin = fixture.app.pendingJobs.beginDispatch.bind(
    fixture.app.pendingJobs,
  );
  fixture.app.pendingJobs.beginDispatch = (...args) => {
    dispatches += 1;
    return begin(...args);
  };
  try {
    const id = await fixture.app.create();
    await fixture.app.submit(id, "turn", "Leia minhas notas", "web");
    await idle(fixture.app, id);
    await fixture.app.submit(id, "task:1", "Leia minhas notas", "task");
    await idle(fixture.app, id);
    assert.equal(fixture.parentRequests.length, 4);
    assert.deepEqual(
      fixture.sent.map((item) => item.tool),
      ["search", "search", "search", "search"],
    );
    for (const child of await children(fixture.app, id))
      assert.equal(fixture.app.mcpCalls.interactions(child).length, 0);
    assert.equal(fixture.app.mcpCalls.interactions(id).length, 0);
    assert.equal(dispatches, 0);
    assert.equal(fixture.app.store.all("SELECT 1 FROM pending_jobs").length, 0);
    assert.equal(fixture.app.store.all("SELECT 1 FROM deliveries").length, 0);
  } finally {
    await close(fixture);
  }
});

test("stopSubagents aborts a running child and the parent closes its turn", async () => {
  let callStarted!: () => void;
  const inCall = new Promise<void>((resolve) => (callStarted = resolve));
  const fixture = await open({
    config: ENABLED,
    parent: [
      async () => call("subagent", { task: "Leia tudo devagar" }, "slow"),
      async (ctx) => {
        assert.match(lastToolResultText(ctx.messages), /task 1 interrupted/);
        return fauxAssistantMessage("Parei.");
      },
    ],
    child: async () => call(SEARCH, {}, "hang"),
    direct: (_tool, _args, signal) => {
      callStarted();
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("not aborted")), 5000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    },
  });
  try {
    const id = await fixture.app.create();
    await fixture.app.submit(id, "turn", "Leia tudo", "web");
    await inCall;
    await fixture.app.stopSubagents(id);
    await idle(fixture.app, id);
    assert.equal(fixture.parentRequests.length, 2);
  } finally {
    await close(fixture);
  }
});

test("usage reports children apart, sums to the harness total, and never counts them twice", async () => {
  const fixture = await open({
    config: ENABLED,
    parent: [
      async () => call("subagent", { task: "Conte os itens" }, "u1"),
      async () => call("conversation_usage", {}, "u2"),
      async (ctx) => {
        const report = JSON.parse(
          lastToolResultText(ctx.messages),
        ) as ReturnType<typeof summarizeConversationTreeUsage>;
        assert.equal(report.subagents?.conversations, 1);
        assert.ok((report.subagents?.tokens.totalTokens ?? 0) > 0);
        assert.match(report.note, /subagents/);
        return fauxAssistantMessage("Consumo informado.");
      },
    ],
    child: async () => fauxAssistantMessage("Três itens."),
  });
  try {
    const id = await fixture.app.create();
    await fixture.app.submit(id, "turn", "Conte e diga o consumo", "web");
    await idle(fixture.app, id);
    assert.equal(fixture.parentRequests.length, 3);
    const own = await fixture.app.harness.snapshot(
      UsageDoc,
      Number(id) as ConversationId,
      context,
    );
    assert.equal(own?.tools.subagent, undefined);
    const childStates = await Promise.all(
      (await children(fixture.app, id)).map((child) =>
        fixture.app.harness.snapshot(
          UsageDoc,
          Number(child) as ConversationId,
          context,
        ),
      ),
    );
    const report = summarizeConversationTreeUsage(own, childStates);
    const total = await fixture.app.harness.usage(context);
    const harnessTokens = [
      ...Object.values(total.models),
      ...Object.values(total.tools),
    ].reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0);
    assert.equal(report.withSubagents?.tokens.totalTokens, harnessTokens);
    const line = await fixture.app.usageLine(id);
    assert.match(
      line,
      new RegExp(
        `^Usage: ${report.tokens.totalTokens.toLocaleString("en-US")} tokens · subagents: ${report.subagents!.tokens.totalTokens.toLocaleString("en-US")} tokens$`,
      ),
    );
  } finally {
    await close(fixture);
  }
});

test("restart skips children in recovery, and a purge removes them with the parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-"));
  const script = {
    config: ENABLED,
    parent: [
      async () => call("subagent", { task: "Resuma o feed" }, "p1"),
      async () => fauxAssistantMessage("Resumo pronto."),
    ] as Step[],
    child: (async () => fauxAssistantMessage("Feed resumido.")) as Step,
    dir,
  };
  let fixture = await open(script);
  let id: string;
  let childIds: string[];
  try {
    id = await fixture.app.create();
    await fixture.app.submit(id, "turn", "Resuma o feed", "web");
    await idle(fixture.app, id);
    childIds = await children(fixture.app, id);
    assert.equal(childIds.length, 1);
  } finally {
    await fixture.app.close();
    await fixture.gateway.close();
  }
  fixture = await open({ ...script, parent: [] });
  try {
    const listed = fixture.app.store
      .all<{ id: string }>("SELECT id FROM conversations")
      .map((row) => String(row.id));
    assert.deepEqual(listed, [id]);
    const archived = await fixture.app.deleteConversation(id);
    await fixture.app.purgeConversation(id, true, archived.deletedAt);
    for (const child of childIds) {
      const record = await fixture.app.harness.commit(
        (tx) => tx.conversation(Number(child) as ConversationId),
        context,
      );
      assert.equal(record, undefined);
    }
    assert.deepEqual(await children(fixture.app, id), []);
  } finally {
    await close(fixture);
  }
});

test(
  "a crash mid-child reuses the child, submits once, and answers the parent once",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-subagent-crash-"));
    const configFile = join(dir, "config.yaml");
    await writeFile(configFile, ENABLED);
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "test/subagent-crash-child.ts", dir],
      {
        cwd: process.cwd(),
        env: { ...process.env, CONFIG_FILE: configFile },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let fixture: Fixture | undefined;
    try {
      const parent = await new Promise<string>((resolve, reject) => {
        let output = "";
        let errors = "";
        const timeout = setTimeout(
          () => reject(new Error(`child timed out: ${errors}`)),
          10000,
        );
        proc.stderr.on("data", (chunk) => (errors += String(chunk)));
        proc.stdout.on("data", (chunk) => {
          output += String(chunk);
          const match = /PARENT (\d+)\n[\s\S]*CHILD_STARTED/.exec(output);
          if (match) {
            clearTimeout(timeout);
            resolve(match[1]!);
          }
        });
        proc.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`child exited ${code}: ${errors}`));
        });
      });
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill("SIGKILL");
      await exited;
      // The killed owner cannot release its lock; it would only go stale.
      await rm(join(dir, "owner.lock"), { recursive: true, force: true });
      fixture = await open({
        config: ENABLED,
        dir,
        parent: [
          async (ctx) => {
            const results = toolResults(ctx.messages);
            assert.equal(results.length, 1);
            assert.match(textOf(results[0]), /Leitor A, Leitor B, Leitor C/);
            return fauxAssistantMessage("Lista entregue.");
          },
        ],
        child: async () => fauxAssistantMessage("Leitor A, Leitor B, Leitor C"),
      });
      await idle(fixture.app, parent);
      assert.equal(fixture.parentRequests.length, 1);
      const owned = await children(fixture.app, parent);
      assert.equal(owned.length, 1);
      const inputs = await fixture.app.harness.commit(
        (tx) =>
          tx.scanEntries(
            { conversationId: Number(owned[0]) as ConversationId },
            100,
          ),
        context,
      );
      assert.equal(
        inputs.items.filter((entry) => entry.kind === "pi.user").length,
        1,
      );
    } finally {
      proc.kill("SIGKILL");
      if (fixture) await close(fixture);
      else await rm(dir, { recursive: true, force: true });
    }
  },
);

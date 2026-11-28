import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { Registry } from "@earendil-works/pi-durable";
import { Runtime, assistantClock } from "../src/runtime.js";
import { setupKey } from "../src/setup.js";
import { Store, type Delivery, type RequestRow } from "../src/store.js";
import { configureTelegram } from "../src/telegram-polling.js";
import { withTextModelFallback } from "../src/text-model-fallback.js";
const gateway = { catalog: async () => [] };
async function temp() {
  return mkdtemp(join(tmpdir(), "pi-agent-test-"));
}
function model(responses: FauxResponseStep[]) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}
async function wait(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("the conversation uses the saved fallback for a rate limit, then prefers the primary again", async () => {
  const dir = await temp();
  const { models, faux } = model([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "429 Too Many Requests",
    }),
    fauxAssistantMessage("Primary answer"),
  ]);
  const backup = fauxProvider({ provider: "backup" });
  backup.setResponses([fauxAssistantMessage("Fallback answer")]);
  models.setProvider(backup.provider);
  const app = await Runtime.open({
    dir,
    gateway,
    models,
    initialize: (store) =>
      store.run(
        "INSERT INTO meta VALUES (?,?)",
        setupKey("demo"),
        JSON.stringify({
          modelId: faux.getModel().id,
          fallbackModel: {
            provider: backup.provider.id,
            modelId: backup.getModel().id,
          },
        }),
      ),
  });
  try {
    const id = await app.create();
    await app.submit(id, "limited", "First question", "telegram", "42");
    await wait(app, id);
    await app.submit(id, "healthy", "Second question", "telegram", "42");
    await wait(app, id);
    assert.deepEqual(
      app.store
        .all<Delivery>("SELECT * FROM deliveries ORDER BY rowid")
        .map((row) => row.text.trimEnd()),
      ["Fallback answer", "Primary answer"],
    );
    assert.equal(faux.state.callCount, 2);
    assert.equal(backup.state.callCount, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hung model request times out and passes the same transcript to the fallback", async () => {
  const { models, faux } = model([() => new Promise(() => {})]);
  const backup = fauxProvider({ provider: "backup" });
  backup.setResponses([
    ({ messages }) => {
      assert.equal(messages.at(-1)?.role, "user");
      assert.equal(messages.at(-1)?.content, "Original question");
      return fauxAssistantMessage("Fallback answer");
    },
  ]);
  models.setProvider(backup.provider);
  const routed = withTextModelFallback(
    models,
    { provider: backup.provider.id, modelId: backup.getModel().id },
    50,
  );
  const result = await routed.completeSimple(faux.getModel(), {
    messages: [
      { role: "user", content: "Original question", timestamp: Date.now() },
    ],
  });
  assert.equal(result.provider, "backup");
  assert.deepEqual(result.content, [{ type: "text", text: "Fallback answer" }]);
  assert.equal(faux.state.callCount, 1);
  assert.equal(backup.state.callCount, 1);
});

test("cancelling an active model request does not call the fallback", async () => {
  const controller = new AbortController();
  const { models, faux } = model([
    () => {
      controller.abort();
      return fauxAssistantMessage("Aborted");
    },
  ]);
  const backup = fauxProvider({ provider: "backup" });
  models.setProvider(backup.provider);
  const routed = withTextModelFallback(models, {
    provider: backup.provider.id,
    modelId: backup.getModel().id,
  });
  const result = await routed.completeSimple(
    faux.getModel(),
    { messages: [] },
    { signal: controller.signal },
  );
  assert.equal(result.stopReason, "aborted");
  assert.equal(faux.state.callCount, 1);
  assert.equal(backup.state.callCount, 0);
});

test("the date line is the calendar day in TZ, with no clock time", () => {
  const now = new Date("2026-11-09T18:00:00Z");
  const fallback = assistantClock({}, now);
  assert.match(fallback, /America\/Sao_Paulo/);
  assert.match(fallback, /November 9, 2026/);
  assert.match(fallback, /tomorrow/);
  assert.doesNotMatch(fallback, /\d{2}:\d{2}/);
  const utc = assistantClock({ TZ: "UTC" }, now);
  assert.match(utc, /\(UTC\)/);
  assert.match(utc, /November 9, 2026/);
  assert.equal(
    assistantClock({ TZ: "UTC" }, new Date("2026-11-09T18:04:00Z")),
    utc,
  );
  assert.match(
    assistantClock({ TZ: "UTC" }, new Date("2026-11-10T00:00:00Z")),
    /November 10, 2026/,
  );
  assert.match(assistantClock({ TZ: "Not/AZone" }, now), /America\/Sao_Paulo/);
});

test("the system prompt has no per-turn clock section", async () => {
  const dir = await temp();
  const { models } = model([fauxAssistantMessage("ok")]);
  const app = await Runtime.open({
    dir,
    gateway,
    models,
    env: { TZ: "UTC" },
    now: () => Date.parse("2026-11-09T18:04:00Z"),
  });
  try {
    const keys = (
      app as unknown as {
        registry: {
          snapshot: () => {
            extension: (name: string) => { sections?: { key: string }[] };
          };
        };
      }
    ).registry
      .snapshot()
      .extension("personal-assistant")
      ?.sections?.map((item) => item.key);
    assert.deepEqual(keys, [
      "scheduling",
      "policy",
      "progress",
      "long-task",
      "operator-skills",
    ]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the assistant policy tells the model to drive durable tasks from ordinary speech", async () => {
  for (const phoneGateway of ["telegram", "whatsapp"] as const) {
    const dir = await temp();
    const { models } = model([fauxAssistantMessage("ok")]);
    const app = await Runtime.open({ dir, gateway, models, phoneGateway });
    try {
      const policy = (app as unknown as { registry: Registry }).registry
        .snapshot()
        .extension("personal-assistant")
        ?.sections?.find((item) => item.key === "policy");
      const text = String(
        await policy?.render(undefined as never, undefined as never),
      );
      for (const sentence of [
        "Drive durable tasks from what the user says in ordinary speech.",
        "call durable_task create with the user's goal instead of doing the work in this turn",
        "call durable_task steer with their words",
        "A durable task may dispatch a code job with writes=true.",
        "The approval card and the job result arrive in the chat where the task was created, prefixed with the task id.",
        "Never ask the user to type tool syntax or an argument name, and never tell the user a `durable_task action=...` command to paste.",
      ])
        assert.ok(text.includes(sentence), `${phoneGateway}: ${text}`);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Durable assistant answers persist formatted Telegram chunks before delivery and deduplicate after restart", async () => {
  const dir = await temp();
  const answer = `# Resumo\n\n**${"conteúdo & < > ".repeat(700)}**\n\n[Site](https://example.com)\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
  const { models, faux } = model([fauxAssistantMessage(answer)]);
  let app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    await app.submit(id, "formatted", "resuma", "telegram", "42");
    await wait(app, id);
    const rows = app.store.all<Delivery>(
      "SELECT * FROM deliveries ORDER BY rowid",
    );
    assert.ok(rows.length > 2);
    assert.ok(rows.every((row) => row.parseMode === "HTML"));
    assert.match(rows[0].text, /<b>Resumo<\/b>/);
    assert.match(rows[0].text, /&amp; &lt; &gt;/);
    assert.match(rows.at(-1)!.text, /<pre><code>const x = 1;<\/code><\/pre>/);
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    await app.submit(id, "formatted", "resuma", "telegram", "42");
    await wait(app, id);
    assert.deepEqual(
      app.store.all<Delivery>("SELECT * FROM deliveries ORDER BY rowid"),
      rows,
    );
    assert.equal(faux.state.callCount, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent web/Telegram inputs serialize and same requestId deduplicates across reopen", async () => {
  const dir = await temp();
  const { models, faux } = model(
    Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`answer-${i}`)),
  );
  let app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    const replies = await Promise.all([
      app.submit(id, "one", "first"),
      app.submit(id, "two", "second", "telegram", "123"),
      app.submit(id, "one", "first"),
    ]);
    assert.equal(replies[0].submissionId, replies[2].submissionId);
    await wait(app, id);
    assert.equal(faux.state.callCount, 2);
    await assert.rejects(app.submit(id, "one", "changed"), /different content/);
    const before = await app.snapshot(id);
    assert.equal(
      before.view.entries.filter((e) => e.kind === "pi.user").length,
      2,
    );
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    const retried = await app.submit(id, "one", "first");
    assert.equal(retried.submissionId, replies[0].submissionId);
    assert.equal(
      (await app.snapshot(id)).view.entries.filter((e) => e.kind === "pi.user")
        .length,
      2,
    );
    assert.equal(app.store.all("SELECT * FROM deliveries").length, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boot sends one durable-task notice to each affected topic and skips deleted conversations", async () => {
  const dir = await temp();
  const { models, faux } = model([]);
  let now = Date.now();
  const options = { dir, gateway, models, env: {}, now: () => now };
  let app = await Runtime.open({
    ...options,
    initialize: (store) =>
      configureTelegram(
        store,
        { token: "synthetic", users: ["42"], chats: ["-100123"] },
        { id: 123 },
      ),
  });
  try {
    const topic = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
      messageThreadId: 11,
    });
    const other = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
      messageThreadId: 12,
    });
    const deleted = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
      messageThreadId: 13,
    });
    const queued = app.durableTasks.create(topic, "Queued goal");
    const running = app.durableTasks.create(topic, "Running goal");
    app.store.run(
      "UPDATE durable_tasks SET state='running' WHERE id=?",
      running.id,
    );
    const otherTask = app.durableTasks.create(other, "Another topic's goal");
    const archived = app.durableTasks.create(deleted, "Archived goal");
    await app.deleteConversation(deleted);

    await app.close();
    app = await Runtime.open(options);
    const notices = () =>
      app.store.all<RequestRow>(
        "SELECT * FROM requests WHERE source='system' ORDER BY conversationId",
      );
    const recorded = notices();
    assert.deepEqual(
      recorded.map((row) => row.conversationId).sort(),
      [topic, other].sort(),
    );
    const deliveries = () =>
      app.store.all<Delivery>(
        "SELECT * FROM deliveries WHERE id LIKE 'durable-task-restart:%' ORDER BY messageThreadId",
      );
    const queuedDeliveries = deliveries();
    assert.deepEqual(
      queuedDeliveries.map((row) => row.messageThreadId),
      [11, 12],
    );
    for (const row of recorded) {
      assert.match(row.requestId, /^durable-task-restart:[a-f0-9]{64}$/);
      assert.equal(
        row.text,
        row.conversationId === topic
          ? "2 tarefas interrompidas\nMotivo: reinício do serviço"
          : `Tarefa ${otherTask.id.slice(0, 8)} interrompida\nMotivo: reinício do serviço`,
      );
      assert.equal(row.status, "done");
      assert.equal(row.submissionId, null);
      assert.ok(
        queuedDeliveries.some(
          (delivery) =>
            delivery.id === `${row.requestId}:0` &&
            delivery.state === "pending" &&
            delivery.chat === "-100123" &&
            delivery.messageThreadId ===
              (row.conversationId === topic ? 11 : 12) &&
            delivery.text.trimEnd() === row.text,
        ),
      );
    }
    assert.deepEqual(
      app.store.all(
        "SELECT * FROM requests WHERE status='pending' OR (source='system' AND status='deferred')",
      ),
      [],
    );
    const interruptedTasks = () =>
      [queued, running, otherTask, archived].map((task) =>
        app.durableTasks.get(task.conversationId, task.id),
      );
    const interrupted = interruptedTasks();
    for (const task of interrupted) {
      assert.equal(task?.state, "interrupted");
      assert.equal(task.lastError, "restart");
    }

    await app.close();
    now += 1000;
    app = await Runtime.open(options);
    assert.deepEqual(notices(), recorded);
    assert.deepEqual(deliveries(), queuedDeliveries);
    assert.deepEqual(interruptedTasks(), interrupted);
    assert.equal(faux.state.callCount, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("persisted in-flight actions and deliveries become uncertain, owner lock rejects second process", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, gateway });
  try {
    await assert.rejects(Runtime.open({ dir, gateway }), /already being held/);
    app.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES ('a','1','mock','write','{}','running')",
    );
    app.store.run(
      "INSERT INTO deliveries(id,chat,text,state) VALUES ('a','100','hello','sending')",
    );
    await app.close();
    const store = new Store(dir);
    try {
      assert.equal(
        store.get<{ state: string }>("SELECT state FROM actions")?.state,
        "uncertain",
      );
      assert.equal(
        store.get<{ state: string }>("SELECT state FROM deliveries")?.state,
        "uncertain",
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

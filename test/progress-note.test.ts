import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { deliveryAnswersUpdate } from "../src/reaction-ack.js";
import {
  admitProgress,
  PROGRESS_INTERVAL_MS,
  PROGRESS_MAX_NOTES,
  PROGRESS_RULE,
} from "../src/progress-note.js";
import { Runtime } from "../src/runtime.js";

const gateway = { catalog: async () => [] };

function progressRule(
  messages: readonly { role?: string; sections?: unknown }[],
) {
  const system = messages.find((message) => message.role === "system");
  const sections = system?.sections;
  if (!sections || typeof sections !== "object") return undefined;
  const value = (sections as Record<string, unknown>).progress;
  return typeof value === "string" ? value : undefined;
}

function progress(text: string, id: string) {
  return fauxAssistantMessage([fauxToolCall("progress", { text }, { id })], {
    stopReason: "toolUse",
  });
}

async function openApp(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  now?: () => number,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-progress-"));
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    gateway,
    models,
    ...(now ? { now } : {}),
  });
  return { dir, app };
}

function rows(app: Runtime) {
  return app.store.all<{ id: string; text: string; channel: string | null }>(
    "SELECT id,text,channel FROM deliveries ORDER BY rowid",
  );
}

/** The reply is queued in the monitor after the harness goes idle. */
async function settle(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = app.store.get<{ status: string }>(
      "SELECT status FROM requests WHERE conversationId=? ORDER BY rowid DESC LIMIT 1",
      id,
    )?.status;
    if (status && status !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("progress notes: first is free, then 30s apart, and three ends the task", () => {
  const start = 1_000;
  const first = admitProgress(undefined, start);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.budget.sent, 1);

  const early = admitProgress(first.budget, start + PROGRESS_INTERVAL_MS - 1);
  assert.deepEqual(early, { ok: false, reason: "interval" });

  const second = admitProgress(first.budget, start + PROGRESS_INTERVAL_MS);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const third = admitProgress(second.budget, start + PROGRESS_INTERVAL_MS * 2);
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.equal(third.budget.sent, PROGRESS_MAX_NOTES);
  const fourth = admitProgress(third.budget, start + PROGRESS_INTERVAL_MS * 10);
  assert.deepEqual(fourth, { ok: false, reason: "cap" });
});

test("a long task acks before the result and drops notes inside the rate limit", async () => {
  let now = Date.parse("2026-11-19T12:00:00Z");
  let flushes = 0;
  const seen: string[] = [];
  const { dir, app } = await openApp(
    [
      async (ctx) => {
        const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
        assert.equal(names.includes("progress"), true);
        assert.equal(names.includes("notify"), false);
        assert.equal(progressRule(ctx.messages), PROGRESS_RULE);
        seen.push("prompt");
        return progress("Checking the repo first.", "p1");
      },
      async () => {
        const queued = rows(app);
        assert.equal(queued.length, 1);
        assert.match(queued[0]!.text, /Checking the repo first/);
        assert.equal(queued[0]!.text.includes("Here is the result"), false);
        assert.equal(deliveryAnswersUpdate(queued[0]!.id, 7), false);
        assert.equal(flushes, 1);
        seen.push("acked");
        return progress("Still on the same file.", "p2");
      },
      async () => {
        assert.equal(
          rows(app).filter((row) => row.id.includes(":note:")).length,
          1,
        );
        assert.equal(flushes, 1);
        now += PROGRESS_INTERVAL_MS;
        return progress("Found the owners file.", "p3");
      },
      async () => {
        now += PROGRESS_INTERVAL_MS;
        return progress("Blocked on a missing token.", "p4");
      },
      async () => {
        now += PROGRESS_INTERVAL_MS;
        return progress("This fourth note should not send.", "p5");
      },
      async () => fauxAssistantMessage("Here is the result."),
    ],
    () => now,
  );
  app.flushTelegramPending = () => {
    flushes += 1;
  };
  try {
    const id = await app.create();
    await app.submit(
      id,
      "telegram:7",
      "Compare the two drafts and write up what changed.",
      "telegram",
      "42",
    );
    await settle(app, id);
    const queued = rows(app);
    const notes = queued.filter((row) => row.id.includes(":note:"));
    const answer = queued.filter((row) => !row.id.includes(":note:"));
    assert.deepEqual(seen, ["prompt", "acked"]);
    assert.deepEqual(
      notes.map((row) => row.text.replace(/<[^>]+>/g, "").trim()),
      [
        "Checking the repo first.",
        "Found the owners file.",
        "Blocked on a missing token.",
      ],
    );
    assert.equal(
      queued.some((row) =>
        /Still on the same file|fourth note/i.test(row.text),
      ),
      false,
    );
    assert.equal(answer.length, 1);
    assert.match(answer[0]!.text, /Here is the result/);
    assert.equal(answer[0]!.text.includes("Checking the repo first"), false);
    assert.ok(
      queued.findIndex((row) => row.id.includes(":note:")) <
        queued.findIndex((row) => !row.id.includes(":note:")),
    );
    for (const note of notes)
      assert.equal(deliveryAnswersUpdate(note.id, 7), false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a quick chat delivers only the answer", async () => {
  const { dir, app } = await openApp([
    async (ctx) => {
      const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
      assert.equal(names.includes("progress"), true);
      assert.equal(progressRule(ctx.messages), PROGRESS_RULE);
      return fauxAssistantMessage("Hello.");
    },
  ]);
  try {
    const id = await app.create();
    await app.submit(id, "telegram:8", "hi", "telegram", "42");
    await settle(app, id);
    const queued = rows(app);
    assert.equal(queued.length, 1);
    assert.match(queued[0]!.text, /Hello/);
    assert.equal(
      queued.some((row) => row.id.includes(":note:")),
      false,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a scheduled run that calls progress sends nothing", async () => {
  const { dir, app } = await openApp([
    async (ctx) => {
      const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
      assert.equal(names.includes("notify"), true);
      assert.equal(names.includes("progress"), true);
      return progress("Starting the digest.", "quiet");
    },
    () => fauxAssistantMessage("digest done"),
  ]);
  try {
    const id = await app.create();
    await app.submit(id, "task:1", "digest the inbox", "task");
    await settle(app, id);
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId='task:1'",
      )?.status,
      "done",
    );
    assert.equal(rows(app).length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a WhatsApp turn queues the note on that channel, apart from the answer", async () => {
  const { dir, app } = await openApp([
    () => progress("Opening the thread first.", "wa"),
    () => fauxAssistantMessage("Two drafts differ in the date."),
  ]);
  try {
    const id = await app.create();
    await app.submit(
      id,
      "wa-1",
      "Compare the two drafts.",
      "whatsapp",
      "fixture-chat@s.whatsapp.net",
    );
    await settle(app, id);
    const queued = rows(app);
    assert.equal(queued.length, 2);
    assert.equal(queued[0]!.channel, "whatsapp");
    assert.match(queued[0]!.text, /Opening the thread first/);
    assert.equal(queued[1]!.channel, "whatsapp");
    assert.match(queued[1]!.text, /Two drafts differ in the date/);
    assert.equal(queued[1]!.text.includes("Opening the thread first"), false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

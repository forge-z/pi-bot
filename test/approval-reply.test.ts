import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime, SYSTEM_REPLY_DELIVERY } from "../src/runtime.js";
import { runNotified } from "../src/task-telegram.js";
import { Telegram } from "../src/telegram.js";
import type { McpCall } from "../src/mcp-calls.js";

const THREAD = 11;

async function open() {
  const dir = await mkdtemp(join(tmpdir(), "pi-approval-reply-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { catalog: async () => [] },
  });
  const id = await app.create("Tópico da aprovação");
  app.store.run(
    "INSERT INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ token: "123456:fake-local-only", botId: 123456 }),
  );
  app.store.run(
    "INSERT INTO telegram_topic_conversations VALUES (?,?)",
    id,
    THREAD,
  );
  app.store.run("INSERT INTO telegram VALUES (?,?,?)", "42", id, "42");
  app.store.run("INSERT INTO telegram_grants VALUES (?,?,?)", "42", "42", id);
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    "telegram:connection",
    JSON.stringify({
      enabled: true,
      bot: { id: 123456 },
      userId: "42",
      chatId: "42",
      conversationId: id,
    }),
  );
  const sent: Array<{ chat: string; text: string; thread?: number }> = [];
  const transport = {
    send: async (
      chat: string,
      text: string,
      options?: { messageThreadId?: number },
    ) => {
      sent.push({ chat, text, thread: options?.messageThreadId });
      return { message_id: 800 + sent.length };
    },
  };
  const engine = () =>
    new Telegram(app, transport, ["42"], ["42"], "test_pi_bot", true, 123456);
  app.flushTelegramPending = async () => {
    await engine().flush();
  };
  return {
    app,
    faux,
    id,
    sent,
    engine,
    async settle() {
      await (await app.conversation(id)).waitForIdle(context);
      for (let n = 0; n < 100; n++) {
        if (!app.store.get("SELECT 1 FROM requests WHERE status='pending'"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function call(conversationId: string, id: string, state: string): McpCall {
  return {
    id,
    conversationId,
    server: "executor",
    tool: "execute",
    args: "{}",
    state,
    result: "task example-7 finished",
    binding: "test",
    updatedAt: 1,
  };
}

test("a reply after an interactive approval is delivered in the same chat", async () => {
  const f = await open();
  let seen = "";
  f.faux.setResponses([
    async (transcript: unknown) => {
      seen = JSON.stringify(transcript);
      return fauxAssistantMessage(
        "Report ready. https://example.test/report/12",
      );
    },
  ]);
  try {
    await f.app.recordMcpOutcome(call(f.id, "call-approve", "done"), {
      deliverReply: true,
    });
    await f.settle();
    await f.engine().flush();
    const request = f.app.store.get<{
      requestId: string;
      source: string;
      status: string;
    }>("SELECT requestId,source,status FROM requests");
    assert.equal(request?.source, "system");
    assert.equal(request?.status, "done");
    assert.ok(request?.requestId);
    assert.equal(runNotified(f.app.store, f.id, request.requestId), true);
    const rows = f.app.store.all<{ text: string; chat: string; state: string }>(
      "SELECT text,chat,state FROM deliveries",
    );
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]!.chat, "42");
    assert.match(rows[0]!.text, /Report ready/);
    assert.match(rows[0]!.text, /example\.test\/report\/12/);
    assert.equal(f.sent.length, 1, JSON.stringify(f.sent));
    assert.equal(f.sent[0]!.chat, "42");
    assert.equal(f.sent[0]!.thread, THREAD);
    assert.match(
      seen,
      new RegExp(SYSTEM_REPLY_DELIVERY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    await f.close();
  }
});

test("an ordinary system turn stays silent", async () => {
  const f = await open();
  let seen = "";
  f.faux.setResponses([
    async (transcript: unknown) => {
      seen = JSON.stringify(transcript);
      return fauxAssistantMessage("This ordinary note must not be delivered.");
    },
  ]);
  try {
    await f.app.recordMcpOutcome(call(f.id, "call-reconcile", "reconciled"));
    await f.settle();
    await f.engine().flush();
    const request = f.app.store.get<{ source: string; status: string }>(
      "SELECT source,status FROM requests",
    );
    assert.equal(request?.source, "system");
    assert.equal(request?.status, "done");
    assert.equal(f.app.store.all("SELECT 1 FROM deliveries").length, 0);
    assert.equal(f.sent.length, 0, JSON.stringify(f.sent));
    assert.ok(seen.length > 0);
    assert.equal(seen.includes(SYSTEM_REPLY_DELIVERY), false);
    assert.equal(
      f.app.store.get("SELECT 1 FROM meta WHERE key LIKE 'system-reply:%'"),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("a blank reply after an approval sends nothing", async () => {
  const f = await open();
  f.faux.setResponses([async () => fauxAssistantMessage("   \n\t  ")]);
  try {
    await f.app.recordMcpOutcome(call(f.id, "call-quiet", "done"), {
      deliverReply: true,
    });
    await f.settle();
    await f.engine().flush();
    const request = f.app.store.get<{ requestId: string; status: string }>(
      "SELECT requestId,status FROM requests",
    );
    assert.equal(request?.status, "done");
    assert.ok(request?.requestId);
    assert.equal(runNotified(f.app.store, f.id, request.requestId), false);
    assert.equal(f.app.store.all("SELECT 1 FROM deliveries").length, 0);
    assert.equal(f.sent.length, 0);
  } finally {
    await f.close();
  }
});

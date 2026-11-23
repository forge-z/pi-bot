import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { McpGateway, mcpToolName } from "../src/mcp.js";
import { Runtime } from "../src/runtime.js";
import type { TelegramApi } from "../src/telegram-api.js";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";
import { acceptWhatsAppMessage } from "../src/whatsapp-inbound.js";

const config = {
  token: "123:synthetic-only",
  users: ["42"],
  chats: ["-100123"],
};
const secrets = [
  "private-prompt",
  "sk-synthetic-key-only",
  "private-page-body",
  "private-reply",
];

async function waitForReceipt(app: Runtime, total: number) {
  for (let i = 0; i < 300; i++) {
    const row = app.store.get<{ total: number }>(
      "SELECT COUNT(*) AS total FROM turn_receipts",
    );
    if (row?.total === total) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected ${total} receipts`);
}

test("Telegram shows scoped receipts with aggregate usage, search outcomes, timing and approval metadata only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-turn-receipts-"));
  const gateway = new McpGateway([
    { name: "search-fixture", url: "https://example.test/mcp" },
  ]);
  gateway.connectionBinding = async () => "fixture";
  gateway.catalog = async () => [
    {
      server: "search-fixture",
      mode: "direct",
      tools: ["search", "execute"].map((name) => ({
        name,
        operation: "direct",
        inputSchema: { type: "object" },
      })),
    },
  ];
  gateway.callDirect = async (_server, name, args) =>
    name === "execute"
      ? {
          content: [],
          structuredContent: {
            status: "approval-required",
            requestId: "exec_fixture",
            invocation: {
              app: "fixture",
              tool: "write",
              input: { body: secrets[2] },
            },
          },
        }
      : {
          isError: args.fail === true,
          content: [{ type: "text", text: secrets[2] }],
        };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const call = (name: string, id: string, extra = {}) =>
    fauxAssistantMessage(
      fauxToolCall(
        mcpToolName("search-fixture", name),
        { query: secrets[1], ...extra },
        { id },
      ),
      { stopReason: "toolUse" },
    );
  faux.setResponses([
    call("search", "first"),
    call("search", "second", { fail: true }),
    call("execute", "approval"),
    fauxAssistantMessage(secrets[3]),
    fauxAssistantMessage("another answer"),
  ]);
  const app = await Runtime.open({
    dir,
    models,
    gateway,
    initialize: (store) => configureTelegram(store, config, { id: 123 }),
  });
  try {
    const polling = new TelegramPolling(
      app,
      { call: async () => ({}) } as unknown as TelegramApi,
      config,
      { id: 123 },
    );
    const send = (id: number, text: string, topic = 11) =>
      polling.engine.receive({
        update_id: id,
        message: {
          message_id: id,
          text,
          message_thread_id: topic,
          from: { id: 42 },
          chat: { id: -100123, type: "supergroup" },
        },
      });
    await send(1, secrets[0]!);
    await waitForReceipt(app, 1);
    const { conversationId, summary } = app.store.get<{
      conversationId: string;
      summary: string;
    }>("SELECT conversationId,summary FROM turn_receipts")!;
    const data = JSON.parse(summary);
    assert.deepEqual(
      data.tools.map(({ durationMs, ...tool }: Record<string, unknown>) => {
        assert.equal(typeof durationMs, "number");
        assert.ok(Number(durationMs) >= 0);
        return tool;
      }),
      [
        {
          name: "search-fixture/search",
          calls: 2,
          ok: 1,
          errors: 1,
          unverified: 0,
        },
        {
          name: "search-fixture/execute",
          calls: 1,
          ok: 0,
          errors: 0,
          unverified: 1,
        },
      ],
    );
    assert.deepEqual(data.approvals, { requested: 1, remembered: 0 });
    assert.equal(data.searches, 2);
    const turn = await app.snapshot(conversationId);
    const usage = turn.view.entries.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "assistant" ? [message.usage] : [],
      ),
    );
    assert.equal(usage.length, 4);
    assert.equal(
      data.inputTokens,
      usage.reduce((sum, u) => sum + u.input + u.cacheRead + u.cacheWrite, 0),
    );
    assert.equal(
      data.outputTokens,
      usage.reduce((sum, u) => sum + u.output, 0),
    );
    const price = usage.reduce((sum, u) => sum + u.cost.total, 0);
    assert.equal(
      data.usd,
      price || (data.inputTokens + data.outputTokens > 0 ? null : 0),
    );
    await send(2, "next");
    await waitForReceipt(app, 2);
    await send(3, "/recibo");
    await send(4, "/recibo 2");
    await send(5, "/recibo", 12);
    await send(6, "/recibo 0");
    const deliveries = app.store.all<{ text: string; messageThreadId: number }>(
      "SELECT text,messageThreadId FROM deliveries ORDER BY rowid",
    );
    assert.ok(
      deliveries.some((d) => d.text.includes("Nenhuma ferramenta chamada")),
    );
    const older = deliveries.find((d) =>
      d.text.includes("search-fixture/search: 2 chamada"),
    )!;
    assert.equal(older.messageThreadId, 11);
    for (const value of secrets) {
      assert.ok(!summary.includes(value));
      assert.ok(!older.text.includes(value));
    }
    assert.ok(
      deliveries.some(
        (d) => d.messageThreadId === 12 && d.text.includes("Nenhum recibo"),
      ),
    );
    assert.ok(deliveries.some((d) => d.text.includes("Uso: /recibo")));
    assert.ok(deliveries.some((d) => d.text.includes("another answer")));
    assert.ok(deliveries.every((d) => !d.text.includes("Recibo: ")));
    assert.equal(faux.state.callCount, 5);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp attaches the opt-in footer and can read the same receipt after reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-receipt-"));
  const configFile = join(dir, "config.yaml");
  await writeFile(configFile, "turn_receipt:\n  footer: true\n");
  const options = {
    dir,
    mode: "demo" as const,
    env: { CONFIG_FILE: configFile },
    gateway: { catalog: async () => [] },
  };
  let app = await Runtime.open(options);
  const chat = "15550001111@s.whatsapp.net";
  const send = (id: string, text: string) =>
    acceptWhatsAppMessage(app, {
      channel: "whatsapp",
      chatId: chat,
      senderId: chat,
      messageId: id,
      text,
    });
  try {
    await send("turn", "hello");
    await waitForReceipt(app, 1);
    assert.ok(
      app.store
        .all<{ text: string }>("SELECT text FROM deliveries")
        .some(({ text }) => /\n\nRecibo: 0 chamada\(s\).*\/recibo$/.test(text)),
    );
    await app.close();
    app = await Runtime.open(options);
    await send("inspect", "/recibo 1");
    assert.ok(
      app.store
        .all<{ text: string }>("SELECT text FROM deliveries")
        .some(({ text }) => text.startsWith("Recibo do último turno")),
    );
    assert.equal(
      app.store.get<{ total: number }>("SELECT COUNT(*) AS total FROM requests")
        ?.total,
      1,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { retryableError, Runtime } from "../src/runtime.js";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";
import type { TelegramUpdate } from "../src/telegram.js";

test("retrying messages stay ahead of their lane without blocking other lanes or callbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-retry-"));
  const config = {
    token: "123:synthetic-only",
    users: ["42"],
    chats: ["-100123"],
  };
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { catalog: async () => [] },
    initialize: (store) => configureTelegram(store, config, { id: 123 }),
  });
  app.tasks.start = () => {};
  const message = (id: number, chat: number, thread = 1): TelegramUpdate => ({
    update_id: id,
    message: {
      message_id: id,
      from: { id: 42, is_bot: false },
      chat: { id: chat, type: "supergroup" },
      message_thread_id: thread,
      text: "hello",
      date: 1,
    },
  });
  const updates: TelegramUpdate[] = [
    message(1, -100123),
    message(2, -100123),
    message(3, -100456),
    message(4, -100123, 2),
    {
      update_id: 5,
      callback_query: {
        id: "cb_5",
        from: { id: 42, is_bot: false },
        data: "noop",
        message: message(5, -100123).message,
      },
    },
  ];
  const processed: number[] = [];
  let attempts = 0;
  const polling = new TelegramPolling(
    app,
    {
      call: async (method, payload) => {
        if (method !== "getUpdates") return {};
        const offset = Number(payload?.offset ?? 0);
        return updates.filter((update) => update.update_id >= offset);
      },
    },
    config,
    { id: 123 },
  );
  polling.engine.receive = async (update) => {
    if (update.update_id === 1 && ++attempts === 1)
      throw retryableError(new Error("temporarily unavailable"));
    processed.push(update.update_id);
  };
  try {
    polling.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...processed].sort(), [3, 4, 5]);
    assert.equal(attempts, 1);
    assert.equal(
      app.store.get(
        "SELECT value FROM meta WHERE key=?",
        "telegram:offset:123",
      ),
      undefined,
    );
    for (let step = 0; step < 300 && !processed.includes(2); step++) {
      await delay(10);
    }
    assert.deepEqual(
      processed.filter((id) => id <= 2),
      [1, 2],
    );
    assert.equal(attempts, 2);
    assert.equal(
      app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        "telegram:offset:123",
      )?.value,
      "6",
    );
  } finally {
    await polling.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

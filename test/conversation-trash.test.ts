import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertAppPurgeSafe } from "../src/conversation-trash.js";
import { Runtime } from "../src/runtime.js";
import { configureTelegram } from "../src/telegram-polling.js";

test("a queued durable-task restart notice does not block conversation purge", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversation-trash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { dir, gateway: { catalog: async () => [] }, env: {} };
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
    const id = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
      messageThreadId: 11,
    });
    app.durableTasks.create(id, "Queued goal");

    await app.close();
    app = await Runtime.open(options);

    assert.ok(
      app.store.get(
        "SELECT 1 FROM requests r JOIN deliveries d ON d.id = r.requestId || ':0' WHERE r.conversationId=? AND r.requestId LIKE 'durable-task-restart:%' AND d.state='pending'",
        id,
      ),
    );
    assert.doesNotThrow(() => assertAppPurgeSafe(app.store, id));
  } finally {
    await app.close();
  }
});

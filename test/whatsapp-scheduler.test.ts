import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { bindChannelChat } from "../src/channel.js";
import { readConfig } from "../src/config.js";
import { startWhatsApp } from "../src/main.js";
import { Runtime } from "../src/runtime.js";
import { writePhoneGateway, writeStoredWhatsapp } from "../src/setup.js";
import { Store } from "../src/store.js";
import type { WaConnectionUpdate, WaSocket } from "../src/whatsapp.js";

const OWNER = "15551234567";
const JID = `${OWNER}@s.whatsapp.net`;
const NOTIFY = "Lembrete do WhatsApp.";

function readRows(dir: string, taskId: string) {
  const db = new DatabaseSync(join(dir, "app.sqlite"), { readOnly: true });
  try {
    const task = db
      .prepare(
        "SELECT nextRun, lastError, delivery, originSource FROM tasks WHERE id=?",
      )
      .get(taskId) as
      | {
          nextRun: number | null;
          lastError: string | null;
          delivery: string;
          originSource: string | null;
        }
      | undefined;
    const run = db
      .prepare(
        "SELECT state, error, scheduled FROM task_runs WHERE taskId=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(taskId) as
      { state: string; error: string | null; scheduled: number } | undefined;
    const delivery = db
      .prepare(
        "SELECT channel, chat, text, state FROM deliveries ORDER BY rowid DESC LIMIT 1",
      )
      .get() as
      | {
          channel: string | null;
          chat: string;
          text: string;
          state: string;
        }
      | undefined;
    return { task, run, delivery };
  } finally {
    db.close();
  }
}

function fakeSocket() {
  const connection: Array<(update: WaConnectionUpdate) => void> = [];
  const sent: Array<{ jid: string; text?: string }> = [];
  const socket = {
    ev: {
      on(event: string, listener: (value: never) => void) {
        if (event === "connection.update")
          connection.push(listener as (update: WaConnectionUpdate) => void);
      },
    },
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      sent.push({
        jid,
        text: typeof content.text === "string" ? content.text : undefined,
      });
      return { key: { id: `out-${sent.length}` } };
    },
    end() {},
  } as WaSocket;
  return {
    socket,
    sent,
    open() {
      for (const listener of connection) listener({ connection: "open" });
    },
  };
}

test("WhatsApp shutdown waits for the in-flight flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-flush-close-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const provider = faux.provider.id;
  const model = models.getModels(provider)[0];
  assert.ok(model, "faux catalog");
  let seed: Runtime | undefined;
  let booted: Awaited<ReturnType<typeof startWhatsApp>> | undefined;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const connection: Array<(update: WaConnectionUpdate) => void> = [];
  const socket = {
    ev: {
      on(event: string, listener: (value: never) => void) {
        if (event === "connection.update")
          connection.push(listener as (update: WaConnectionUpdate) => void);
      },
    },
    sendMessage: async () => {
      entered();
      await gate;
      return { key: { id: "held-1" } };
    },
    end() {},
  } as WaSocket;
  try {
    seed = await Runtime.open({
      dir,
      models,
      mode: "live",
      provider,
      modelId: model.id,
      phoneGateway: "whatsapp",
      gateway: { catalog: async () => [] },
    });
    writePhoneGateway(seed.store.db, "whatsapp");
    writeStoredWhatsapp(seed.store.db, [OWNER]);
    await seed.close();
    seed = undefined;
    const store = new Store(dir);
    booted = await startWhatsApp({
      dir,
      models,
      store,
      config: readConfig({ DATA_DIR: dir }, undefined, undefined, {
        gateway: "whatsapp",
      }),
      selection: { provider, modelId: model.id },
      socketFactory: () => socket,
    });
    for (const listener of connection) listener({ connection: "open" });
    store.queueTelegram(
      "hold",
      JID,
      "hold please",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    let saw = false;
    const began = started.then(() => {
      saw = true;
    });
    const deadline = Date.now() + 3000;
    while (!saw && Date.now() < deadline) {
      await Promise.race([
        began,
        new Promise((resolve) => setTimeout(resolve, 20)),
      ]);
    }
    assert.equal(saw, true);
    let closed = false;
    const closing = booted.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, false);
    release();
    await closing;
    const db = new DatabaseSync(join(dir, "app.sqlite"), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT state FROM deliveries WHERE id='hold:0'")
        .get() as { state: string } | undefined;
      assert.equal(row?.state, "sent");
    } finally {
      db.close();
    }
  } finally {
    release();
    await booted?.close();
    await seed?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp boot starts the scheduler and delivers notify to the chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-scheduler-"));
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("notify", { text: NOTIFY })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("ok"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const provider = faux.provider.id;
  const model = models.getModels(provider)[0];
  assert.ok(model, "faux catalog");
  const logs: string[] = [];
  const errorLog = console.error;
  const infoLog = console.info;
  console.error = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  console.info = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  let seed: Runtime | undefined;
  let booted: Awaited<ReturnType<typeof startWhatsApp>> | undefined;
  const sockets: Array<ReturnType<typeof fakeSocket>> = [];
  try {
    seed = await Runtime.open({
      dir,
      models,
      mode: "live",
      provider,
      modelId: model.id,
      phoneGateway: "whatsapp",
      gateway: { catalog: async () => [] },
    });
    writePhoneGateway(seed.store.db, "whatsapp");
    writeStoredWhatsapp(seed.store.db, [OWNER]);
    const conversationId = await seed.create("Agenda");
    bindChannelChat(seed.store, "whatsapp", JID, conversationId);
    const created = await seed.tasks.create(
      {
        title: "Lembrete",
        prompt: "Avise o chat",
        kind: "cron",
        schedule: "* * * * *",
        timezone: "UTC",
        conversationId,
      },
      "wa:create:1",
      {
        source: "whatsapp",
        conversationId,
        requestId: "wa-user-1",
      },
    );
    assert.equal(created.delivery, "web_telegram");
    assert.equal(created.originSource, "whatsapp");
    assert.equal(created.destinationChat, JID);
    // The first tick should already be due.
    const due = Date.now() - 1000;
    seed.store.run("UPDATE tasks SET nextRun=? WHERE id=?", due, created.id);
    await seed.close();
    seed = undefined;
    booted = await startWhatsApp({
      dir,
      models,
      store: new Store(dir),
      config: readConfig({ DATA_DIR: dir }, undefined, undefined, {
        gateway: "whatsapp",
      }),
      selection: { provider, modelId: model.id },
      socketFactory: () => {
        const next = fakeSocket();
        sockets.push(next);
        return next.socket;
      },
    });
    assert.equal(sockets.length, 1);
    sockets[0]!.open();
    const deadline = Date.now() + 8000;
    let seen = readRows(dir, created.id);
    while (Date.now() < deadline) {
      seen = readRows(dir, created.id);
      const delivered = sockets[0]!.sent.some(
        (row) => row.jid === JID && row.text?.includes(NOTIFY),
      );
      if (
        seen.task?.nextRun !== null &&
        seen.task !== undefined &&
        seen.task.nextRun > due &&
        seen.run?.scheduled === 1 &&
        seen.run.state === "done" &&
        delivered
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(seen.task);
    assert.equal(seen.task.originSource, "whatsapp");
    assert.ok(
      seen.task.nextRun !== null && seen.task.nextRun > due,
      `nextRun did not advance: ${JSON.stringify({ seen, sent: sockets[0]!.sent, logs })}`,
    );
    assert.equal(seen.run?.scheduled, 1);
    assert.equal(
      seen.run?.state,
      "done",
      JSON.stringify({ seen, sent: sockets[0]!.sent, logs }),
    );
    assert.equal(seen.run?.error, null);
    const sent = sockets[0]!.sent.find(
      (row) => row.jid === JID && row.text?.includes(NOTIFY),
    );
    assert.ok(
      sent,
      `notify was not delivered: ${JSON.stringify({ seen, sent: sockets[0]!.sent, logs })}`,
    );
    assert.equal(seen.delivery?.channel, "whatsapp");
    assert.equal(seen.delivery?.chat, JID);
    assert.equal(seen.delivery?.state, "sent");
    assert.match(seen.delivery?.text ?? "", /Lembrete do WhatsApp/);
  } finally {
    console.error = errorLog;
    console.info = infoLog;
    await booted?.close();
    await seed?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

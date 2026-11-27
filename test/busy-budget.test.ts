import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { Runtime } from "../src/runtime.js";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";
import type { TelegramApi } from "../src/telegram-api.js";

const config = {
  token: "123:synthetic-only",
  users: ["42"],
  chats: ["-100123"],
};

class Deferred<T = void> {
  promise: Promise<T>;
  resolve!: (val: T) => void;
  constructor() {
    this.promise = new Promise<T>((res) => {
      this.resolve = res;
    });
  }
}

interface Fixture {
  dir: string;
  app: Runtime;
  close: () => Promise<void>;
}

async function fixture(
  responses: FauxResponseStep[],
  options: {
    /** Written to $DATA_DIR/config.yaml before opening. */
    config?: string;
    catalog?: () => Promise<unknown[]>;
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pi-busy-budget-"));
  if (options.config) await writeFile(join(dir, "config.yaml"), options.config);
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const gateway = {
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    catalog: options.catalog ?? (async () => []),
  };
  const app = await Runtime.open({
    dir,
    models,
    // The budget config lives in $DATA_DIR/config.yaml, read through options.env.
    env: { DATA_DIR: dir },
    gateway,
    initialize: (store) => configureTelegram(store, config, { id: 123 }),
  });
  return {
    dir,
    app,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function polling(app: Runtime) {
  return new TelegramPolling(
    app,
    { call: async () => ({}) } as unknown as TelegramApi,
    config,
    { id: 123 },
  );
}

async function until(check: () => boolean, maxAttempts = 500) {
  for (let n = 0; n < maxAttempts; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(check());
}

async function receive(
  engine: ReturnType<typeof polling>["engine"],
  updateId: number,
  messageId: number,
  text: string,
) {
  await engine.receive({
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: 42, is_bot: false },
      chat: { id: -100123, type: "supergroup" },
      text,
      date: 1000 + updateId,
    },
  });
}

function deliveries(app: Runtime) {
  return app.store.all<{ text: string }>(
    "SELECT text FROM deliveries WHERE chat='-100123' ORDER BY rowid",
  );
}

async function waitIdle(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  await new Promise((r) => setTimeout(r, 50));
}

test("the busy notice names the running tool and its elapsed time, once per turn", async () => {
  const f = await fixture([fauxAssistantMessage("ok")]);
  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);
    // A tool that has been running for 15 seconds, without a real turn.
    const poked = f.app as unknown as {
      activeToolStarts: Map<string, number>;
      activeToolNames: Map<string, string>;
    };
    poked.activeToolStarts.set(convId, Date.now() - 15_000);
    poked.activeToolNames.set(convId, "mcp_tools");
    assert.equal(f.app.isTurnBusy(convId), true);

    const poll = polling(f.app);
    await receive(poll.engine, 1, 10, "another request");
    const first = deliveries(f.app).filter((d) => d.text.includes("/queue"));
    assert.equal(first.length, 1, "one busy notice");
    const notice = first[0].text;
    assert.match(notice, /mcp_tools/, "names the running tool");
    assert.match(notice, /15 seconds/, "names the elapsed time");
    assert.match(notice, /\/queue/, "offers /queue");
    assert.match(notice, /\/stop/, "offers /stop");

    // A second message in the same busy turn does not repeat the notice.
    await receive(poll.engine, 2, 11, "one more thing");
    assert.equal(
      deliveries(f.app).filter((d) => d.text.includes("/queue")).length,
      1,
      "at most one notice per turn",
    );
    await poll.close();
  } finally {
    await f.close();
  }
});

test("/queue stores the message and answers it in its own turn after the busy one ends", async () => {
  const barrier = new Deferred<void>();
  let catalogCalls = 0;
  const f = await fixture(
    [
      fauxAssistantMessage(
        { type: "toolCall", id: "c1", name: "mcp_tools", arguments: {} },
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Turn one done"),
      fauxAssistantMessage("Answer about the weather"),
    ],
    {
      catalog: async () => {
        catalogCalls += 1;
        if (catalogCalls === 1) await barrier.promise;
        return [];
      },
    },
  );
  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);
    const poll = polling(f.app);
    await receive(poll.engine, 1, 10, "start the long work");
    await until(() => f.app.isTurnBusy(convId));

    await receive(poll.engine, 2, 11, "/queue what is the weather?");
    assert.equal(
      f.app.store.get<{ text: string }>(
        "SELECT text FROM queued_messages WHERE conversationId=? AND requestId='telegram:2'",
        convId,
      )?.text,
      "what is the weather?",
      "queued message is persisted",
    );
    assert.ok(
      deliveries(f.app).some((d) => d.text.includes("Queued")),
      "the queue command confirms",
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM requests WHERE conversationId=? AND requestId='telegram:2'",
        convId,
      ),
      undefined,
      "the queued message did not start while the turn was busy",
    );

    barrier.resolve();
    await until(
      () =>
        !!f.app.store.get(
          "SELECT 1 FROM requests WHERE conversationId=? AND requestId='telegram:2'",
          convId,
        ),
    );
    await waitIdle(f.app, convId);

    assert.equal(
      f.app.store.get<{ text: string }>(
        "SELECT text FROM requests WHERE conversationId=? AND requestId='telegram:2'",
        convId,
      )?.text,
      "what is the weather?",
      "the queued message is admitted with the command prefix removed",
    );
    assert.ok(
      deliveries(f.app).some((d) =>
        d.text.includes("Answer about the weather"),
      ),
      "the queued message is answered after the busy turn ends",
    );
    assert.ok(
      deliveries(f.app).some((d) => d.text.includes("Turn one done")),
      "the first turn still answers",
    );
    const snapshot = await f.app.snapshot(convId);
    assert.equal(
      snapshot.view.entries.filter((e) => e.kind === "pi.assistant").length,
      3,
      "two turns: tool call + answer, then the queued message's own answer",
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM queued_messages WHERE conversationId=?",
        convId,
      ),
      undefined,
      "the queued row is consumed",
    );
    await poll.close();
  } finally {
    await f.close();
  }
});

test("/queue with nothing busy behaves as a normal message", async () => {
  const f = await fixture([fauxAssistantMessage("normal answer")]);
  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);
    const poll = polling(f.app);
    await receive(poll.engine, 1, 10, "/queue just checking in");
    await waitIdle(f.app, convId);

    assert.equal(
      f.app.store.get<{ text: string }>(
        "SELECT text FROM requests WHERE conversationId=? AND requestId='telegram:1'",
        convId,
      )?.text,
      "just checking in",
      "the message reaches the model without the command prefix",
    );
    assert.ok(
      deliveries(f.app).some((d) => d.text.includes("normal answer")),
      "it is answered like any message",
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM queued_messages WHERE conversationId=?",
        convId,
      ),
      undefined,
      "nothing is stored",
    );
    await poll.close();
  } finally {
    await f.close();
  }
});

test("budget expiry injects the note once and refuses a non-job tool call", async () => {
  const barrier = new Deferred<void>();
  let catalogCalls = 0;
  const seen: string[] = [];
  const toolCall = (id: string) =>
    fauxAssistantMessage(
      { type: "toolCall", id, name: "mcp_tools", arguments: {} },
      { stopReason: "toolUse" },
    );
  const capture = (transcript: { messages: unknown[] }) =>
    seen.push(JSON.stringify(transcript.messages));
  const f = await fixture(
    [
      toolCall("c1"),
      async (transcript) => {
        capture(transcript);
        return toolCall("c2");
      },
      async (transcript) => {
        capture(transcript);
        return fauxAssistantMessage("budget final");
      },
    ],
    {
      config: "interactive_turn_budget_seconds: 1\n",
      catalog: async () => {
        catalogCalls += 1;
        if (catalogCalls === 1) await barrier.promise;
        return [];
      },
    },
  );
  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);
    void f.app.submit(
      convId,
      "req-1",
      "do the long thing",
      "telegram",
      "-100123",
    );
    await until(() => f.app.isTurnBusy(convId));
    // Let the 1-second budget run out while the first tool call is blocked.
    await new Promise((r) => setTimeout(r, 1500));
    barrier.resolve();
    await waitIdle(f.app, convId);

    assert.equal(seen.length, 2, "two later model requests were made");
    assert.equal(
      (seen[0].match(/Wrap up now/g) ?? []).length,
      1,
      "the budget note is injected once, after expiry",
    );
    assert.equal(
      seen[1].includes("Wrap up now"),
      false,
      "the note is not repeated on later requests",
    );
    assert.ok(
      seen[1].includes("Refused:"),
      "the non-job tool call is refused as a readable tool result",
    );
    assert.equal(catalogCalls, 1, "the refused call never ran");
    assert.ok(
      deliveries(f.app).some((d) => d.text.includes("budget final")),
      "the turn still ends with the model's reply",
    );
  } finally {
    await f.close();
  }
});

test("a cron run is not subject to the interactive budget", async () => {
  const barrier = new Deferred<void>();
  let catalogCalls = 0;
  const seen: string[] = [];
  const toolCall = (id: string) =>
    fauxAssistantMessage(
      { type: "toolCall", id, name: "mcp_tools", arguments: {} },
      { stopReason: "toolUse" },
    );
  const f = await fixture(
    [
      toolCall("c1"),
      async (transcript) => {
        seen.push(JSON.stringify(transcript.messages));
        return toolCall("c2");
      },
      async (transcript) => {
        seen.push(JSON.stringify(transcript.messages));
        return fauxAssistantMessage("task final");
      },
    ],
    {
      config: "interactive_turn_budget_seconds: 1\n",
      catalog: async () => {
        catalogCalls += 1;
        if (catalogCalls === 1) await barrier.promise;
        return [];
      },
    },
  );
  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);
    // A scheduled occurrence is admitted with source "task", like the cron runner does.
    void f.app.submit(convId, "task-run-1", "check the thing", "task");
    await until(() => f.app.isTurnBusy(convId));
    await new Promise((r) => setTimeout(r, 1500));
    barrier.resolve();
    await waitIdle(f.app, convId);

    assert.equal(catalogCalls, 2, "both tool calls ran; none was refused");
    assert.ok(
      seen.every(
        (text) => !text.includes("Wrap up now") && !text.includes("Refused:"),
      ),
      "no budget note and no refusal inside a scheduled run",
    );
  } finally {
    await f.close();
  }
});

test("a restart keeps a queued message and answers it", async () => {
  const first = await fixture([fauxAssistantMessage("unused")]);
  const owner = { chat: "-100123", user: "42" };
  let convId: string;
  {
    const poll = polling(first.app);
    try {
      convId = await first.app.telegramChats.ensure(owner);
      // Busy without a real turn, so the app can close cleanly.
      (
        first.app as unknown as { activeToolStarts: Map<string, number> }
      ).activeToolStarts.set(convId, Date.now() - 1000);
      await receive(
        poll.engine,
        1,
        10,
        "/queue remember this after the restart",
      );
      assert.equal(
        first.app.store.get<{ text: string }>(
          "SELECT text FROM queued_messages WHERE conversationId=? AND requestId='telegram:1'",
          convId,
        )?.text,
        "remember this after the restart",
        "the message is persisted before the restart",
      );
    } finally {
      await poll.close();
      await first.app.close();
    }
  }
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("Answered after restart")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const gateway = {
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    catalog: async () => [],
  };
  const app = await Runtime.open({
    dir: first.dir,
    models,
    gateway,
    initialize: (store) => configureTelegram(store, config, { id: 123 }),
  });
  try {
    await until(() =>
      app.store
        .all<{ text: string }>(
          "SELECT text FROM deliveries WHERE chat='-100123'",
        )
        .some((d) => d.text.includes("Answered after restart")),
    );
    assert.equal(
      app.store.get<{ text: string }>(
        "SELECT text FROM requests WHERE conversationId=? AND requestId='telegram:1'",
        convId!,
      )?.text,
      "remember this after the restart",
      "the queued message is admitted after the restart",
    );
    assert.equal(
      app.store.get(
        "SELECT 1 FROM queued_messages WHERE conversationId=?",
        convId!,
      ),
      undefined,
      "the queued row is consumed",
    );
  } finally {
    await app.close();
    await rm(first.dir, { recursive: true, force: true });
  }
});

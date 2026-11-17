import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import type { TelegramApi } from "../src/telegram-api.js";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";

const config = {
  token: "123:synthetic",
  users: ["42"],
  chats: ["-100123"],
};
const owner = { chat: "-100123", user: "42" };

function usage(partial: {
  input?: number;
  output?: number;
  totalTokens?: number;
  cost?: Partial<Usage["cost"]>;
}): Usage {
  const input = partial.input ?? 0;
  const output = partial.output ?? 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: partial.totalTokens ?? input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      ...partial.cost,
    },
  };
}

async function open(
  respond?: (transcript: {
    messages: readonly { role: string; content?: unknown }[];
  }) => ReturnType<typeof fauxAssistantMessage>,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-topic-"));
  const faux = fauxProvider({
    models: [
      {
        id: "faux-1",
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
  const seen: string[] = [];
  faux.setResponses(
    Array.from(
      { length: 40 },
      () =>
        async (transcript: {
          messages: readonly { role: string; content?: unknown }[];
        }) => {
          const rendered = JSON.stringify(transcript);
          seen.push(rendered);
          if (respond) return respond(transcript);
          const summary = rendered.includes("context summarization assistant");
          return fauxAssistantMessage(
            summary ? "Mock checkpoint: preserve the ledger." : "mock response",
          );
        },
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { catalog: async () => [] },
    initialize: (store) =>
      configureTelegram(store, config, { id: 123, username: "test_bot" }),
  });
  const sent: string[] = [];
  const api: TelegramApi = {
    call: async (method, payload) => {
      if (method === "sendMessage") {
        sent.push((payload as { text?: string }).text ?? "");
        return { message_id: sent.length };
      }
      return {};
    },
  };
  const polling = new TelegramPolling(app, api, config, {
    id: 123,
    username: "test_bot",
  });
  let updateId = 1;
  return {
    app,
    seen,
    sent,
    async send(text: string, thread = 11) {
      await polling.engine.receive({
        update_id: updateId++,
        message: {
          message_id: updateId,
          from: { id: 42, is_bot: false },
          chat: { id: -100123, type: "supergroup" },
          message_thread_id: thread,
          text,
          date: 1_700_000_000 + updateId,
        },
      });
      await polling.engine.flush();
    },
    async close() {
      await polling.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function seed(app: Runtime, id: string, key: string, value: Usage) {
  await app.harness.commit(async (tx) => {
    const doc = await tx.doc(UsageDoc, Number(id) as ConversationId);
    doc.models[key] = value;
  }, context);
}

test("/status reports this topic's tokens and cost, not another topic's", async () => {
  const f = await open();
  try {
    const first = await f.app.telegramChats.ensure({
      ...owner,
      messageThreadId: 11,
    });
    const second = await f.app.telegramChats.ensure({
      ...owner,
      messageThreadId: 22,
    });
    await f.send("/status", 11);
    assert.match(f.sent.at(-1) ?? "", /Usage: 0 tokens · \$0\.00/);
    await seed(
      f.app,
      first,
      "openai/priced",
      usage({
        input: 1000,
        output: 200,
        totalTokens: 1200,
        cost: { input: 0.3, output: 0.12, total: 0.42 },
      }),
    );
    await seed(
      f.app,
      second,
      "llm/legacy",
      usage({ input: 50, output: 10, totalTokens: 60 }),
    );
    await f.send("/status", 11);
    await f.send("/status", 22);
    const priced = f.sent.at(-2) ?? "";
    const unpriced = f.sent.at(-1) ?? "";
    assert.match(priced, /Usage: 1,200 tokens · \$0\.42/);
    assert.equal(priced.includes("60 tokens"), false);
    assert.match(unpriced, /Usage: 60 tokens/);
    assert.equal(unpriced.includes("$"), false);
    assert.equal(unpriced.includes("1,200"), false);
  } finally {
    await f.close();
  }
});

test("/compact refuses while the topic has pending work and does nothing on an empty topic", async () => {
  const f = await open();
  try {
    const id = await f.app.telegramChats.ensure({
      ...owner,
      messageThreadId: 11,
    });
    f.app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,status) VALUES (?,?,?,'telegram','pending')",
      id,
      "pending-1",
      "still working",
    );
    await f.send("/compact keep the names");
    assert.match(
      f.sent.at(-1) ?? "",
      /Wait for this topic to finish before compacting\./,
    );
    assert.equal(
      f.seen.some((text) => text.includes("context summarization assistant")),
      false,
    );
    f.app.store.run(
      "UPDATE requests SET status='done' WHERE conversationId=? AND requestId='pending-1'",
      id,
    );
    await f.send("/compact keep the names");
    assert.match(f.sent.at(-1) ?? "", /Nothing to compact in this topic\./);
  } finally {
    await f.close();
  }
});

test("/compact runs harness compaction for this topic and passes instructions", async () => {
  const f = await open();
  try {
    const first = await f.app.telegramChats.ensure({
      ...owner,
      messageThreadId: 11,
    });
    const second = await f.app.telegramChats.ensure({
      ...owner,
      messageThreadId: 22,
    });
    for (let n = 0; n < 4; n++) {
      await f.app.admit(
        first,
        `large-${n}`,
        `Entry ${n}: ${"unique-context ".repeat(1900)}`,
        { source: "telegram", ...owner, messageThreadId: 11 },
      );
      await (await f.app.conversation(first)).waitForIdle(context);
    }
    for (
      let n = 0;
      n < 50 &&
      f.app.store.get(
        "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
        first,
      );
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    await f.send("/compact Keep the ledger id");
    const reply = f.sent.at(-1) ?? "";
    assert.match(reply, /Compacted this topic\. Tokens: [\d,]+ → [\d,]+\./);
    assert.equal(
      f.seen.some((text) =>
        text.includes("Additional focus: Keep the ledger id"),
      ),
      true,
    );
    assert.equal((await f.app.snapshot(second)).view.entries.length, 0);
  } finally {
    await f.close();
  }
});

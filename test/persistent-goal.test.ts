import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { linkChat } from "./link-chat.js";
import { Telegram, type TelegramTransport } from "../src/telegram.js";
import {
  GOAL_MAX_BYTES,
  observePrMerged,
  parseGoalCommand,
  type GoalTarget,
} from "../src/goals.js";
import { commandGoal } from "../src/commands.js";
import { removeAppHistory } from "../src/conversation-trash.js";

const PR_URL = "https://api.github.com/repos/octocat/hello-world/pulls/7";
const target: GoalTarget = {
  owner: "octocat",
  repo: "hello-world",
  prNumber: 7,
};
const prBody = (over: Record<string, unknown> = {}) => ({
  number: 7,
  state: "open",
  merged: false,
  merged_at: null,
  base: { repo: { full_name: "OctoCat/Hello-World" } },
  ...over,
});
const mergedBody = prBody({
  state: "closed",
  merged: true,
  merged_at: "2025-01-01T00:00:00Z",
});

/** API-shaped responses served in order; a thrown Error simulates a network fault. */
function fakeFetch(
  responses: Array<{ status: number; body: unknown } | Error>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected goal fetch");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fetcher, calls };
}

/** The full Telegram command surface on a real Runtime and SQLite volume. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const options = { dir, models, gateway: { catalog: async () => [] } };
  let app = await Runtime.open(options);
  const anchor = await app.create("Web anchor");
  linkChat(app, "100", "42", anchor);
  app.store.run(
    "INSERT INTO meta VALUES ('telegram:connection',?)",
    JSON.stringify({
      enabled: true,
      bot: { id: 123 },
      userId: "42",
      chatId: "100",
      conversationId: anchor,
    }),
  );
  app.store.run(
    "INSERT INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ botId: 123, token: "123:synthetic-token" }),
  );
  const owner = { chat: "100", user: "42", messageThreadId: 11 };
  const topic = await app.telegramChats.ensure(owner);
  const views: string[] = [];
  const transport: TelegramTransport = {
    send: async (_chat: string, text: string) => {
      views.push(text);
      return { message_id: views.length };
    },
    editMessage: async () => true,
    answerCallback: async () => undefined,
  };
  const engine = () =>
    new Telegram(app, transport, ["42"], ["100"], "test_bot", true, 123);
  let bot = engine();
  let updateId = 1;
  const send = async (text: string) => {
    const id = updateId++;
    await bot.receive({
      update_id: id,
      message: {
        message_id: id,
        text,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        message_thread_id: 11,
      },
    });
    await bot.flush();
    return views.splice(0);
  };
  const inject = (
    fetcher: (url: string, init: RequestInit) => Promise<Response>,
  ) => {
    app.tasks.goalFetcher = fetcher;
  };
  const forceDue = () =>
    app.store.run("UPDATE tasks SET nextRun=0 WHERE kind='goal'");
  return {
    get app() {
      return app;
    },
    owner,
    topic,
    send,
    inject,
    forceDue,
    goalRows: () =>
      app.store.all<{
        taskId: string;
        conversationId: string;
        state: string;
        attempts: number;
        maxAttempts: number;
        nextRun: number | null;
        destinationChat: string | null;
        destinationUser: string | null;
        destinationBotId: string | null;
        destinationMessageThreadId: number | null;
        destinationReason: string | null;
        reason: string | null;
        lastResult: string | null;
      }>(
        `SELECT g.*,t.conversationId,t.nextRun,t.destinationChat,t.destinationUser,t.destinationBotId,t.destinationMessageThreadId,t.destinationReason
         FROM task_goals g JOIN tasks t ON t.id=g.taskId ORDER BY t.rowid`,
      ),
    goalRuns: () =>
      app.store.all<{
        id: string;
        state: string;
        requestId: string;
        error: string | null;
      }>(
        `SELECT r.* FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE t.kind='goal' ORDER BY r.rowid`,
      ),
    /** Terminal notifications of goal runs, joined with any queued delivery. */
    goalNotifications: () =>
      app.store.all<{
        id: string;
        state: string;
        chat: string | null;
        messageThreadId: number | null;
        reason: string | null;
        deliveryChat: string | null;
        deliveryState: string | null;
        deliveryText: string | null;
      }>(
        `SELECT n.id,n.state,n.chat,n.messageThreadId,n.reason,
           d.chat AS deliveryChat,d.state AS deliveryState,d.text AS deliveryText
         FROM task_notifications n
         JOIN task_runs r ON r.requestId=n.requestId
         JOIN tasks t ON t.id=r.taskId AND t.kind='goal'
         LEFT JOIN task_notification_parts p ON p.notificationId=n.id
         LEFT JOIN deliveries d ON d.id=p.deliveryId`,
      ),
    requests: () => app.store.all("SELECT * FROM requests"),
    async restart() {
      await bot.drain();
      await app.close();
      app = await Runtime.open(options);
      bot = engine();
    },
    async close() {
      await bot.drain();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const GOAL_CMD = "/goal pr octocat/hello-world#7 60 24";

// ---- Stateless observer ----------------------------------------------------

test("the observer makes one explicit canonical GET and trusts only a merged exact identity", async () => {
  const { fetcher, calls } = fakeFetch([{ status: 200, body: mergedBody }]);
  assert.deepEqual(await observePrMerged(target, fetcher), { kind: "merged" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, PR_URL);
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.ok(!("authorization" in (calls[0]!.init.headers ?? {})));
});

test("an oversize GitHub answer is never trusted as completion proof", async () => {
  // Valid JSON well beyond any honest PR payload: only a byte cap refuses it.
  const oversize = JSON.stringify(mergedBody) + " ".repeat(GOAL_MAX_BYTES + 1);
  const fetcher = async () => new Response(oversize, { status: 200 });
  const observation = await observePrMerged(target, fetcher);
  assert.equal(observation.kind, "retry");
});

test("non-200, network faults and mismatched identities stay transient", async () => {
  const cases: Array<{
    response: () => Promise<Response>;
    expected: string;
  }> = [
    {
      response: async () => new Response("bad gateway", { status: 502 }),
      expected: "retry",
    },
    {
      response: async () => {
        throw new Error("simulated timeout");
      },
      expected: "retry",
    },
    {
      response: async () =>
        new Response(JSON.stringify(prBody({ number: 8, merged: true }))),
      expected: "retry",
    },
    {
      response: async () =>
        new Response(
          JSON.stringify(
            prBody({
              merged: true,
              base: { repo: { full_name: "other/repo" } },
            }),
          ),
        ),
      expected: "retry",
    },
  ];
  for (const item of cases) {
    const observation = await observePrMerged(target, item.response);
    assert.equal(observation.kind, item.expected);
    if (observation.kind === "retry") assert.ok(observation.reason.length);
  }
});

test("a closed-unmerged PR is material evidence; an open PR is not", async () => {
  const closed = fakeFetch([
    { status: 200, body: prBody({ state: "closed" }) },
  ]);
  assert.deepEqual(await observePrMerged(target, closed.fetcher), {
    kind: "closed_unmerged",
  });
  const open = fakeFetch([{ status: 200, body: prBody() }]);
  assert.deepEqual(await observePrMerged(target, open.fetcher), {
    kind: "open",
  });
});

test("the command parser accepts the literal form and rejects malformed input", () => {
  assert.deepEqual(parseGoalCommand("pr octocat/hello-world#7 60 24"), {
    action: "create",
    target,
    intervalMin: 60,
    maxAttempts: 24,
  });
  assert.deepEqual(parseGoalCommand(""), { action: "help" });
  assert.deepEqual(parseGoalCommand("list"), { action: "list" });
  assert.deepEqual(parseGoalCommand("cancel 2"), {
    action: "cancel",
    index: 2,
  });
  for (const bad of [
    "pr",
    "pr not-a-target 60 24",
    "pr a/b#0 60 24",
    "pr a/b#7 60 24 extra",
    "pr octocat/hello-world#7 4 24",
    "pr octocat/hello-world#7 60 0",
    "tasks octocat/hello-world#7 60 24",
    "cancel",
    "cancel 0",
    "pr octocat/hello-world#99999999999999999999 60 24",
  ])
    assert.throws(() => parseGoalCommand(bad), /invalid/i, bad);
});

// ---- Creation, listing and cancellation ------------------------------------

test("a human /goal command freezes the exact incoming chat, user, bot and topic", async () => {
  const f = await fixture();
  try {
    const replies = await f.send(GOAL_CMD);
    assert.match(replies.at(-1)!, /goal saved/i);
    const rows = f.goalRows();
    assert.equal(rows.length, 1);
    const goal = rows[0]!;
    assert.equal(goal.state, "pending");
    assert.equal(goal.attempts, 0);
    assert.ok(goal.nextRun, "first check is scheduled");
    assert.equal(goal.conversationId, f.topic);
    assert.equal(goal.destinationChat, "100");
    assert.equal(goal.destinationUser, "42");
    assert.equal(goal.destinationBotId, "123");
    assert.equal(goal.destinationMessageThreadId, 11);
    const route = f.app.store.get<{
      chat: string;
      user: string;
      botId: string;
      messageThreadId: number;
    }>(
      "SELECT * FROM request_telegram_routes WHERE requestId='telegram:goal-create:1'",
    );
    assert.ok(route, "the origin route of this exact update is captured");
    assert.equal(route.chat, "100");
    assert.equal(route.user, "42");
    assert.equal(route.botId, "123");
    assert.equal(route.messageThreadId, 11);
  } finally {
    await f.close();
  }
});

test("a natural-language /goal creates the goal at the 60-minute floor", async () => {
  const f = await fixture();
  try {
    const replies = await f.send(
      "/goal acompanhe o https://github.com/forge-z/pi-bot/pulls a cada 60 minutos ate a PR #66 ser publicada.",
    );
    assert.match(replies.at(-1)!, /goal saved/i);
    assert.match(replies.at(-1)!, /every 60 minutes/);
    const rows = f.goalRows();
    assert.equal(rows.length, 1);
    const goal = rows[0]!;
    assert.equal(goal.state, "pending");
    assert.equal(goal.attempts, 0);
    assert.ok(goal.nextRun, "first check is scheduled");
    assert.equal(goal.conversationId, f.topic);
    assert.equal(goal.destinationChat, "100");
    assert.equal(goal.destinationUser, "42");
    assert.equal(goal.destinationMessageThreadId, 11);
    const stored = f.app.store.get<{
      owner: string;
      repo: string;
      prNumber: number;
      intervalMin: number;
      maxAttempts: number;
    }>("SELECT owner,repo,prNumber,intervalMin,maxAttempts FROM task_goals");
    assert.deepEqual(
      { ...stored },
      {
        owner: "forge-z",
        repo: "pi-bot",
        prNumber: 66,
        intervalMin: 60,
        maxAttempts: 200,
      },
    );
  } finally {
    await f.close();
  }
});

test("malformed or out-of-bounds /goal arguments are rejected", async () => {
  const f = await fixture();
  try {
    for (const bad of [
      "/goal pr",
      "/goal pr not-a-target 60 24",
      "/goal pr a/b#0 60 24",
      "/goal pr a/b#7 60 24 extra",
      "/goal pr octocat/hello-world#7 4 24",
      "/goal pr octocat/hello-world#7 60 0",
      "/goal tasks octocat/hello-world#7 60 24",
      "/goal pr octocat/hello-world#99999999999999999999 60 24",
    ]) {
      const replies = await f.send(bad);
      assert.ok(
        /invalid|use/i.test(replies.at(-1)!),
        `${bad} was accepted: ${replies.at(-1)}`,
      );
      assert.equal(f.goalRows().length, 0, `${bad} created a goal`);
    }
  } finally {
    await f.close();
  }
});

test("/goal list shows status and /goal cancel stops a goal without notifying", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const listed = await f.send("/goal list");
    assert.match(listed.at(-1)!, /pending/);
    assert.match(listed.at(-1)!, /octocat\/hello-world#7/);
    const cancelled = await f.send("/goal cancel 1");
    assert.match(cancelled.at(-1)!, /cancelled/i);
    const goal = f.goalRows()[0]!;
    assert.equal(goal.state, "cancelled");
    assert.equal(goal.nextRun, null);
    const fetches = fakeFetch([]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 0, "a cancelled goal never checks");
    assert.equal(f.goalNotifications().length, 0, "cancel does not notify");
  } finally {
    await f.close();
  }
});

// ---- The ordinary Tasks.tick executes goals ---------------------------------

test("the existing Tasks.tick runs a due goal check without Runtime.submit", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const requestsBefore = f.requests().length;
    const open = fakeFetch([{ status: 200, body: prBody() }]);
    f.inject(open.fetcher);
    await f.app.tasks.tick();
    assert.equal(open.calls.length, 1);
    assert.equal(open.calls[0]!.url, PR_URL);
    assert.equal(
      f.requests().length,
      requestsBefore,
      "a goal check must not submit a model turn",
    );
    assert.equal(f.goalNotifications().length, 0, "pending stays silent");
    const goal = f.goalRows()[0]!;
    assert.equal(goal.attempts, 1);
    assert.ok(goal.nextRun! > Date.now(), "next check is on the cadence");
    const run = f.goalRuns()[0]!;
    assert.equal(run.state, "done");
    assert.equal(run.requestId.startsWith("task:"), true);
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM task_runs WHERE id=?",
        run.id,
      )!.conversationId,
      f.topic,
      "the run keeps the SQLite identity of the goal task",
    );
  } finally {
    await f.close();
  }
});

test("pending state and run identity survive a restart; a merged PR completes once", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const open = fakeFetch([{ status: 200, body: prBody() }]);
    f.inject(open.fetcher);
    await f.app.tasks.tick();
    await f.restart();
    let goal = f.goalRows()[0]!;
    assert.equal(goal.state, "pending");
    assert.equal(goal.attempts, 1);
    f.forceDue();
    const merged = fakeFetch([{ status: 200, body: mergedBody }]);
    f.inject(merged.fetcher);
    await f.app.tasks.tick();
    goal = f.goalRows()[0]!;
    assert.equal(goal.state, "completed");
    assert.equal(goal.nextRun, null);
    const done = fakeFetch([]);
    f.inject(done.fetcher);
    await f.app.tasks.tick();
    assert.equal(done.calls.length, 0, "no further checks after completion");
    const notifications = f.goalNotifications();
    assert.equal(notifications.length, 1, "exactly one terminal notification");
    assert.equal(notifications[0]!.state, "queued");
    assert.equal(notifications[0]!.deliveryChat, "100");
    assert.equal(notifications[0]!.messageThreadId, 11);
    assert.match(notifications[0]!.deliveryText!, /merged/i);
    assert.equal(f.goalRuns().length, 2, "one run row per attempt");
  } finally {
    await f.close();
  }
});

test("a closed-but-unmerged PR blocks a goal with one honest notification", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const closed = fakeFetch([
      { status: 200, body: prBody({ state: "closed" }) },
    ]);
    f.inject(closed.fetcher);
    await f.app.tasks.tick();
    const goal = f.goalRows()[0]!;
    assert.equal(goal.state, "blocked");
    assert.equal(goal.nextRun, null);
    const notifications = f.goalNotifications();
    assert.equal(notifications.length, 1);
    assert.match(
      notifications[0]!.deliveryText!,
      /closed without being merged/i,
    );
    const again = fakeFetch([]);
    f.inject(again.fetcher);
    await f.app.tasks.tick();
    assert.equal(again.calls.length, 0);
    assert.equal(f.goalNotifications().length, 1);
  } finally {
    await f.close();
  }
});

test("transient failures retry silently; an exhausted budget blocks honestly", async () => {
  const f = await fixture();
  try {
    await f.send("/goal pr octocat/hello-world#7 60 2");
    const failing = fakeFetch([
      { status: 500, body: {} },
      new Error("simulated timeout"),
    ]);
    f.inject(failing.fetcher);
    await f.app.tasks.tick();
    let goal = f.goalRows()[0]!;
    assert.equal(goal.state, "pending");
    assert.equal(goal.attempts, 1);
    assert.equal(f.goalNotifications().length, 0, "transient stays silent");
    f.forceDue();
    await f.app.tasks.tick();
    goal = f.goalRows()[0]!;
    assert.equal(goal.state, "blocked");
    assert.equal(goal.nextRun, null);
    const notifications = f.goalNotifications();
    assert.equal(notifications.length, 1);
    const note = notifications[0]!.deliveryText!;
    assert.match(note, /2 checks/i);
    assert.match(note, /no definite answer/i);
    assert.doesNotMatch(
      note,
      /simulated|timeout/i,
      "no raw error text in chat",
    );
  } finally {
    await f.close();
  }
});

test("a cancellation that lands during a fetch discards the result", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    // The read resolves after the human already cancelled: late, discarded.
    const late = fakeFetch([{ status: 200, body: mergedBody }]);
    const fetcher = async (url: string, init: RequestInit) => {
      const response = await late.fetcher(url, init);
      f.app.tasks.cancelGoal(f.topic, 1);
      return response;
    };
    f.inject(fetcher);
    await f.app.tasks.tick();
    const goal = f.goalRows()[0]!;
    assert.equal(goal.state, "cancelled");
    assert.equal(f.goalNotifications().length, 0, "no terminal message");
    const run = f.goalRuns().at(-1)!;
    assert.match(run.error!, /discarded/i);
    const fetches = fakeFetch([]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("an interrupted in-flight attempt is closed without replay; the budget still binds", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const goal = f.goalRows()[0]!;
    // Reconstruct the exact crash state: the attempt was reserved and the run
    // marked in-flight (startedAt), then the process died before settling.
    f.app.store.run(
      `INSERT INTO task_runs(id,taskId,scheduledAt,state,requestId,scheduled,conversationId,delivery,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,startedAt)
       SELECT 'crash-run',id,?,'checking','task:crash-sim',1,conversationId,delivery,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,?
       FROM tasks WHERE id=?`,
      Date.now(),
      Date.now(),
      goal.taskId,
    );
    f.app.store.run(
      "UPDATE task_goals SET attempts=1 WHERE taskId=?",
      goal.taskId,
    );
    f.app.store.run(
      "UPDATE tasks SET nextRun=? WHERE id=?",
      Date.now() + 3_600_000,
      goal.taskId,
    );
    await f.restart();
    const fetches = fakeFetch([{ status: 200, body: prBody() }]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    assert.equal(
      fetches.calls.length,
      0,
      "an interrupted attempt is not replayed",
    );
    let after = f.goalRows()[0]!;
    assert.equal(after.state, "pending", "the remaining budget still applies");
    assert.equal(after.attempts, 1);
    const run = f.app.store.get<{ state: string; error: string }>(
      "SELECT state,error FROM task_runs WHERE id='crash-run'",
    )!;
    assert.equal(run.state, "failed");
    assert.match(run.error!, /interrupted/i);
    // The next scheduled attempt reads normally.
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 1);
    after = f.goalRows()[0]!;
    assert.equal(after.state, "pending");
    assert.equal(after.attempts, 2);
  } finally {
    await f.close();
  }
});

test("a crash on the last budgeted attempt blocks without any further GET", async () => {
  const f = await fixture();
  try {
    await f.send("/goal pr octocat/hello-world#7 60 1");
    const goal = f.goalRows()[0]!;
    f.app.store.run(
      `INSERT INTO task_runs(id,taskId,scheduledAt,state,requestId,scheduled,conversationId,delivery,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,startedAt)
       SELECT 'crash-last',id,?,'checking','task:crash-last',1,conversationId,delivery,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,?
       FROM tasks WHERE id=?`,
      Date.now(),
      Date.now(),
      goal.taskId,
    );
    f.app.store.run(
      "UPDATE task_goals SET attempts=1 WHERE taskId=?",
      goal.taskId,
    );
    f.app.store.run("UPDATE tasks SET nextRun=0 WHERE id=?", goal.taskId);
    await f.restart();
    const fetches = fakeFetch([]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    assert.equal(
      fetches.calls.length,
      0,
      "no more GET once the budget is spent",
    );
    const after = f.goalRows()[0]!;
    assert.equal(after.state, "blocked");
    assert.match(after.reason!, /interrupted/i);
    const notifications = f.goalNotifications();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!.deliveryText!, /interrupted/i);
  } finally {
    await f.close();
  }
});

test("a revoked destination prevents fetching and never claims delivery", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      f.topic,
    );
    const fetches = fakeFetch([{ status: 200, body: mergedBody }]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 0, "no read for a revoked route");
    const goal = f.goalRows()[0]!;
    assert.equal(goal.state, "blocked");
    assert.match(goal.reason!, /revoked|deleted/i);
    const notifications = f.goalNotifications();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.state, "skipped", "delivery is not claimed");
    assert.ok(notifications[0]!.reason, "the skip records why");
    assert.equal(notifications[0]!.deliveryChat, null);
  } finally {
    await f.close();
  }
});

// ---- Isolation from the ordinary task controls ------------------------------

test("generic task APIs and /crons cannot see, edit, run or delete a goal", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const goal = f.goalRows()[0]!;
    assert.equal(
      f.app.tasks.list().length,
      0,
      "a goal is not an ordinary schedule",
    );
    assert.equal(f.app.tasks.get(goal.taskId), undefined);
    for (const attempt of [
      () => f.app.tasks.edit(goal.taskId, { title: "x" }),
      () => f.app.tasks.update(goal.taskId, { enabled: false }),
      () => f.app.tasks.setEnabled(goal.taskId, true),
      () => f.app.tasks.runNow(goal.taskId),
      () => f.app.tasks.remove(goal.taskId),
    ])
      await assert.rejects(async () => attempt(), /not found/i);
    const crons = await f.send("/crons");
    assert.doesNotMatch(
      crons.at(-1)!,
      /hello-world/,
      "goals stay out of /crons",
    );
    assert.match(crons.at(-1)!, /Telegram schedules/);
  } finally {
    await f.close();
  }
});

test("a backlog of due goals is bounded per pass without consuming attempts", async () => {
  const f = await fixture();
  try {
    // GOAL_CHECKS_PER_TICK bounds one pass; the rest stays due, uncounted.
    for (const pr of [7, 8, 9])
      await f.send(`/goal pr octocat/hello-world#${pr} 60 24`);
    const fetches = fakeFetch([
      { status: 200, body: prBody() },
      { status: 200, body: prBody({ number: 8 }) },
      { status: 200, body: prBody({ number: 9 }) },
    ]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    assert.ok(
      fetches.calls.length < 3,
      "one pass does not run the whole backlog",
    );
    const checked = f.goalRows().filter((row) => row.attempts === 1).length;
    assert.equal(checked, fetches.calls.length);
    assert.ok(
      f.goalRows().some((row) => row.attempts === 0),
      "later due work is retained without an attempt",
    );
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 3, "the next pass drains the rest");
  } finally {
    await f.close();
  }
});

test("ordinary cron admission runs first, next to goal checks", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    await f.app.tasks.create({
      title: "Regular cron",
      prompt: "Instrução original",
      conversationId: f.topic,
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
    });
    f.app.store.run("UPDATE tasks SET nextRun=0");
    let submits = 0;
    f.app.submit = (async (conversationId: string, requestId: string) => {
      submits++;
      return { requestId, conversationId, submissionId: 1 };
    }) as unknown as typeof f.app.submit;
    const fetches = fakeFetch([{ status: 200, body: prBody() }]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    assert.equal(submits, 1, "the ordinary cron still submits exactly once");
    assert.equal(fetches.calls.length, 1, "the goal still gets its read");
    const cronRun = f.app.store.get<{
      state: string;
      startedAt: number | null;
    }>(
      `SELECT r.state,r.startedAt FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE t.kind='cron'`,
    );
    assert.ok(cronRun, "the cron occurrence was claimed");
    assert.ok(cronRun.startedAt, "the cron occurrence was admitted");
    assert.equal(
      f.app.tasks.list().length,
      1,
      "only the ordinary task is a schedule",
    );
  } finally {
    await f.close();
  }
});

test("goal checks never dispatch the model or executor", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const other = await f.app.telegramChats.ensure({
      ...f.owner,
      messageThreadId: 22,
    });
    assert.notEqual(other, f.topic);
    const replies = await f.send("/goal pr octocat/hello-world#8 60 24");
    assert.match(replies.at(-1)!, /goal saved/i);
    assert.equal(f.goalRows().length, 2);
    const before = f.requests().length;
    const fetches = fakeFetch([
      { status: 200, body: prBody() },
      { status: 200, body: prBody({ number: 8 }) },
    ]);
    f.inject(fetches.fetcher);
    f.forceDue();
    await f.app.tasks.tick();
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 2, "each due goal reads exactly once");
    assert.ok(
      fetches.calls.every((call) => call.url.startsWith(PR_URL.slice(0, -1))),
      "only the fixed canonical endpoint is read",
    );
    assert.equal(
      f.requests().length,
      before,
      "a goal check never creates a model turn",
    );
    assert.equal(f.goalNotifications().length, 0, "nothing pending was sent");
  } finally {
    await f.close();
  }
});

// ---- Verified regression cases (candidate probes) ----------------------------

test("an open PR on the final allowed read is terminal, not stranded pending", async () => {
  const f = await fixture();
  try {
    await f.send("/goal pr octocat/hello-world#7 60 1");
    const fake = fakeFetch([{ status: 200, body: prBody() }]);
    f.inject(fake.fetcher);
    await f.app.tasks.tick();
    await f.restart();
    const settled = f.goalRows()[0]!;
    assert.equal(
      settled.state,
      "blocked",
      "exhausted budget is terminal even when the last evidence is PR still open",
    );
    assert.equal(settled.nextRun, null);
    assert.match(settled.reason!, /still open after 1 check/i);
    const noGets = fakeFetch([]);
    f.inject(noGets.fetcher);
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(fake.calls.length, 1, "only the one allowed read");
    assert.equal(
      noGets.calls.length,
      0,
      "no additional GET after the exhausted settle",
    );
    assert.equal(f.goalRows()[0]!.state, "blocked");
    const notifications = f.goalNotifications();
    assert.equal(notifications.length, 1, "exactly one terminal notice");
    assert.match(notifications[0]!.deliveryText!, /still open after 1 check/i);
  } finally {
    await f.close();
  }
});

test("a goal read is not a scheduled model turn of the conversation", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    let seen: boolean | undefined;
    const fake = fakeFetch([{ status: 200, body: prBody() }]);
    f.inject(async (url, init) => {
      seen = f.app.tasks.inFlight(f.topic);
      return fake.fetcher(url, init);
    });
    await f.app.tasks.tick();
    assert.equal(
      seen,
      false,
      "inFlight() must not deny send_attachment and tasks_run_now during a goal read",
    );
  } finally {
    await f.close();
  }
});

test("an update replayed after goal commit cannot create a second goal", async () => {
  const f = await fixture();
  try {
    const access = { source: "telegram" as const, ...f.owner };
    const body = "pr octocat/hello-world#7 60 24";
    // A process died after the durable commit but before Telegram's
    // telegram:update receipt: the same authorized update is replayed.
    await commandGoal(f.app, f.topic, access, body, 123456);
    await commandGoal(f.app, f.topic, access, body, 123456);
    assert.equal(
      f.goalRows().length,
      1,
      "the replay confirms the committed goal instead of creating another",
    );
    // A distinct update is a legitimate new goal, never suppressed.
    await commandGoal(
      f.app,
      f.topic,
      access,
      "pr octocat/hello-world#8 60 24",
      123457,
    );
    assert.equal(f.goalRows().length, 2, "distinct updates still create goals");
    const fetches = fakeFetch([
      { status: 200, body: prBody() },
      { status: 200, body: prBody({ number: 8 }) },
    ]);
    f.inject(fetches.fetcher);
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 2, "each goal reads exactly once");
    assert.equal(
      f.goalNotifications().length,
      0,
      "two goals reading open fetch and notify nothing",
    );
  } finally {
    await f.close();
  }
});

// ---- At-rest safety and lifecycle --------------------------------------------

test("goal rows and runs stay inert for a pre-goal Tasks binary", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    // The pre-goal tick claims only enabled rows; a goal row is disabled at rest.
    assert.ok(
      !f.app.store.get(
        "SELECT 1 FROM tasks WHERE deleted=0 AND enabled=1 AND nextRun<=?",
        Date.now() + 60_000,
      ),
      "a pre-goal tick claims no goal row",
    );
    const fake = fakeFetch([{ status: 200, body: prBody() }]);
    let pendingInFlight: unknown = "unset";
    f.inject(async (url, init) => {
      pendingInFlight = f.app.store.get(
        "SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE t.kind='goal' AND r.state='pending'",
      );
      return fake.fetcher(url, init);
    });
    f.forceDue();
    await f.app.tasks.tick();
    assert.ok(
      !pendingInFlight,
      "a pre-goal dispatch (state='pending') submits no goal run",
    );
    assert.ok(
      !f.app.store.get(
        "SELECT 1 FROM tasks WHERE deleted=0 AND enabled=1 AND nextRun<=?",
        Date.now() + 60_000,
      ),
      "the goal row stays disabled between checks",
    );
  } finally {
    await f.close();
  }
});

test("a WhatsApp-gateway volume never fetches Telegram-only goals", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    f.app.options.phoneGateway = "whatsapp";
    const fetches = fakeFetch([{ status: 200, body: mergedBody }]);
    f.inject(fetches.fetcher);
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(
      fetches.calls.length,
      0,
      "no goal read while WhatsApp is the active gateway",
    );
    assert.equal(f.goalRows()[0]!.state, "pending");
    f.app.options.phoneGateway = undefined;
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 1, "the Telegram volume resumes checks");
    assert.equal(f.goalRows()[0]!.state, "completed");
  } finally {
    await f.close();
  }
});

test("purging a conversation removes its goal metadata with the row", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    assert.equal(f.goalRows().length, 1);
    removeAppHistory(f.app.store, f.topic, Date.now());
    assert.equal(
      f.app.store.all("SELECT * FROM task_goals").length,
      0,
      "no goal metadata is orphaned by the purge",
    );
    assert.equal(
      f.app.store.all("SELECT * FROM tasks WHERE kind='goal'").length,
      0,
    );
  } finally {
    await f.close();
  }
});

// ---- Archive and restore ------------------------------------------------------

test("archiving a conversation cancels its pending goals immediately; restore never reopens them", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    await f.send("/goal pr octocat/hello-world#8 60 24");
    // One real pass: #7 reads open and stays pending, #8 completes terminally.
    // Distinct due times: equal nextRun values would tie the tick's ORDER BY
    // and swap which goal reads which queued answer.
    f.app.store.run(
      "UPDATE tasks SET nextRun=0 WHERE id=?",
      f.goalRows()[0]!.taskId,
    );
    f.app.store.run(
      "UPDATE tasks SET nextRun=1 WHERE id=?",
      f.goalRows()[1]!.taskId,
    );
    const pass = fakeFetch([
      { status: 200, body: prBody() },
      {
        status: 200,
        body: prBody({
          number: 8,
          state: "closed",
          merged: true,
          merged_at: "2025-01-01T00:00:00Z",
        }),
      },
    ]);
    f.inject(pass.fetcher);
    await f.app.tasks.tick();
    assert.equal(f.goalRows()[0]!.state, "pending");
    assert.equal(f.goalRows()[1]!.state, "completed");
    const sameChat = await f.app.tasks.create({
      title: "Same chat cron",
      prompt: "Same chat cron",
      conversationId: f.topic,
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
    });
    const otherTopic = await f.app.telegramChats.ensure({
      ...f.owner,
      messageThreadId: 33,
    });
    const otherChat = await f.app.tasks.create({
      title: "Other chat cron",
      prompt: "Other chat cron",
      conversationId: otherTopic,
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
    });
    // Park the other conversation's cron in the future so a real minute
    // boundary crossed by the ticks after restore cannot dispatch it.
    f.app.store.run(
      "UPDATE tasks SET nextRun=? WHERE id=?",
      Date.now() + 3_600_000,
      otherChat.id,
    );
    const otherBefore = f.app.store.get<{
      enabled: number;
      nextRun: number | null;
    }>("SELECT enabled,nextRun FROM tasks WHERE id=?", otherChat.id)!;
    // The pending goal is due again when the archive lands: the archive must
    // cancel it, not strand it pending with a null calendar.
    f.app.store.run(
      "UPDATE tasks SET nextRun=0 WHERE id=?",
      f.goalRows()[0]!.taskId,
    );
    const requestsBefore = f.requests().length;
    const notificationsBefore = f.goalNotifications().length;

    await f.app.deleteConversation(f.topic);

    // The archive cancels the pending goal in the same transaction.
    const archived = f.goalRows()[0]!;
    assert.equal(
      archived.state,
      "cancelled",
      "archive must cancel the pending goal",
    );
    assert.equal(archived.nextRun, null);
    assert.equal(archived.attempts, 1, "the archive consumed no extra read");
    assert.match(archived.reason!, /archiv/i);
    // The terminal goal of the same conversation is untouched.
    const terminal = f.goalRows()[1]!;
    assert.equal(terminal.state, "completed");
    assert.equal(terminal.nextRun, null);
    // The ordinary schedule keeps the legacy archive rule: disabled, no calendar.
    const sameRow = f.app.store.get<{
      enabled: number;
      nextRun: number | null;
    }>("SELECT enabled,nextRun FROM tasks WHERE id=?", sameChat.id)!;
    assert.equal(sameRow.enabled, 0);
    assert.equal(sameRow.nextRun, null);
    // Other conversations keep their calendars untouched.
    const otherAfter = f.app.store.get<{
      enabled: number;
      nextRun: number | null;
    }>("SELECT enabled,nextRun FROM tasks WHERE id=?", otherChat.id)!;
    assert.equal(otherAfter.enabled, 1);
    assert.equal(otherAfter.nextRun, otherBefore.nextRun);

    f.app.restoreConversation(f.topic);

    // Restore reopens nothing and re-enables nothing.
    const restored = f.goalRows()[0]!;
    assert.equal(
      restored.state,
      "cancelled",
      "restore must not reopen a cancelled goal",
    );
    assert.equal(restored.nextRun, null);
    const restoredCron = f.app.store.get<{
      enabled: number;
      nextRun: number | null;
    }>("SELECT enabled,nextRun FROM tasks WHERE id=?", sameChat.id)!;
    assert.equal(
      restoredCron.enabled,
      0,
      "restore keeps the legacy rule for ordinary schedules",
    );
    assert.equal(restoredCron.nextRun, null);

    // Zero new reads, zero model turns, zero queued messages.
    const fetches = fakeFetch([]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 0, "no goal read after restore");
    assert.equal(f.requests().length, requestsBefore, "no model turn created");
    assert.equal(
      f.goalNotifications().length,
      notificationsBefore,
      "no new goal message was queued",
    );
  } finally {
    await f.close();
  }
});

test("a merged GET that lands after the archive is discarded without a terminal message", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    f.forceDue();
    const requestsBefore = f.requests().length;
    // The archive lands while the one real GET is in flight.
    let stateDuringFetch: string | undefined;
    const late = fakeFetch([{ status: 200, body: mergedBody }]);
    f.inject(async (url, init) => {
      await f.app.deleteConversation(f.topic);
      stateDuringFetch = f.goalRows()[0]!.state;
      return late.fetcher(url, init);
    });
    await f.app.tasks.tick();
    assert.equal(
      stateDuringFetch,
      "cancelled",
      "the archive must cancel the in-flight goal's check",
    );
    const goal = f.goalRows()[0]!;
    assert.equal(
      goal.state,
      "cancelled",
      "a late merged read must not complete the goal",
    );
    assert.equal(goal.nextRun, null);
    const run = f.goalRuns().at(-1)!;
    assert.equal(run.state, "failed");
    assert.match(run.error!, /discarded/i);
    assert.equal(f.goalNotifications().length, 0, "no terminal message");
    assert.equal(f.requests().length, requestsBefore, "no model turn created");

    f.app.restoreConversation(f.topic);
    const fetches = fakeFetch([]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    assert.equal(fetches.calls.length, 0, "restore does not reopen the check");
    assert.equal(f.goalRows()[0]!.state, "cancelled");
    assert.equal(f.goalNotifications().length, 0);
  } finally {
    await f.close();
  }
});

// ---- Schema identity guard ---------------------------------------------------

test("a base-shaped INSERT without state cannot admit a goal run", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const goalId = f.goalRows()[0]!.taskId;
    // The pre-goal claim() INSERT omits state and relies on the table default
    // 'pending'; the schema guard must refuse exactly that admission shape.
    assert.throws(
      () =>
        f.app.store.run(
          "INSERT INTO task_runs(id,taskId,scheduledAt,requestId,scheduled) SELECT 'legacy-insert',id,0,'task:legacy-insert',1 FROM tasks WHERE id=?",
          goalId,
        ),
      /admitted as checking/i,
      "a base-shaped INSERT must be refused",
    );
    assert.ok(
      !f.app.store.get(
        "SELECT 1 FROM task_runs WHERE taskId=? AND state='pending'",
        goalId,
      ),
      "no pending goal run row was created",
    );
    assert.equal(
      f.goalRows()[0]!.state,
      "pending",
      "the goal itself is untouched",
    );
  } finally {
    await f.close();
  }
});

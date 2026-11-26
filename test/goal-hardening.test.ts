import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { linkChat } from "./link-chat.js";
import {
  Telegram,
  TelegramSendRefused,
  type TelegramTransport,
  type TelegramUpdate,
} from "../src/telegram.js";
import { cleanCommands, TelegramPolling } from "../src/telegram-polling.js";
import {
  GOAL_HELP,
  GOAL_INTERVAL_MAX,
  GOAL_INTERVAL_MIN,
  observePrMerged,
  parseGoalCommand,
  type GoalTarget,
} from "../src/goals.js";
import { commandGoal } from "../src/commands.js";

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
const mergedBody = (number = 7) =>
  prBody({
    number,
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Same real Runtime + SQLite + Telegram surface as persistent-goal.test.ts. */
async function fixture(chatId = 100, privateDm = true) {
  const chat = String(chatId);
  const dir = await mkdtemp(join(tmpdir(), "pi-goal-hardening-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const options = { dir, models, gateway: { catalog: async () => [] } };
  let app = await Runtime.open(options);
  const anchor = await app.create("Web anchor");
  linkChat(app, chat, "42", anchor);
  app.store.run(
    "INSERT INTO meta VALUES ('telegram:connection',?)",
    JSON.stringify({
      enabled: true,
      bot: { id: 123 },
      userId: "42",
      chatId: chat,
      conversationId: anchor,
    }),
  );
  app.store.run(
    "INSERT INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ botId: 123, token: "123:synthetic-token" }),
  );
  const owner = { chat, user: "42", messageThreadId: 11 };
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
    new Telegram(app, transport, ["42"], [chat], "test_bot", privateDm, 123);
  let bot = engine();
  let updateId = 1;
  const receive = (
    message: Partial<NonNullable<TelegramUpdate["message"]>>,
  ) => {
    const id = updateId++;
    return bot.receive({
      update_id: id,
      message: {
        message_id: id,
        from: { id: 42 },
        chat: { id: chatId, type: privateDm ? "private" : "supergroup" },
        message_thread_id: 11,
        ...message,
      },
    });
  };
  const flush = async () => {
    await bot.flush();
    return views.splice(0);
  };
  const send = async (text: string) => {
    await receive({ text });
    return flush();
  };
  return {
    get app() {
      return app;
    },
    owner,
    topic,
    transport,
    receive,
    flush,
    send,
    revokeGrant() {
      app.store.run(
        "DELETE FROM telegram_grants WHERE conversationId=?",
        topic,
      );
    },
    restoreGrant() {
      app.store.run(
        "INSERT INTO telegram_grants VALUES (?,?,?)",
        owner.chat,
        owner.user,
        topic,
      );
    },
    inject(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
      app.tasks.goalFetcher = fetcher;
    },
    forceDue: () =>
      app.store.run("UPDATE tasks SET nextRun=0 WHERE kind='goal'"),
    goalRows: () =>
      app.store.all<{
        taskId: string;
        state: string;
        attempts: number;
        maxAttempts: number;
        intervalMin: number;
        nextRun: number | null;
        reason: string | null;
        lastResult: string | null;
      }>(
        `SELECT g.*,t.nextRun FROM task_goals g JOIN tasks t ON t.id=g.taskId ORDER BY t.rowid`,
      ),
    goalNotifications: () =>
      app.store.all<{ state: string; deliveryText: string | null }>(
        `SELECT n.state,d.text AS deliveryText
         FROM task_notifications n
         JOIN task_runs r ON r.requestId=n.requestId
         JOIN tasks t ON t.id=r.taskId AND t.kind='goal'
         LEFT JOIN task_notification_parts p ON p.notificationId=n.id
         LEFT JOIN deliveries d ON d.id=p.deliveryId
         ORDER BY n.rowid`,
      ),
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
const NL = (interval: string) =>
  `acompanhe https://github.com/forge-z/pi-bot/pull/66 ${interval}`;

// ---- R1: interval floor 60 --------------------------------------------------

test("R1: the interval floor is 60: 5 and 59 refused, 60 and 1440 accepted", () => {
  assert.equal(GOAL_INTERVAL_MIN, 60);
  assert.equal(GOAL_INTERVAL_MAX, 1440);
  for (const minutes of [5, 59])
    assert.throws(
      () => parseGoalCommand(`pr octocat/hello-world#7 ${minutes} 24`),
      /60 to 1440/,
      `structured ${minutes}`,
    );
  for (const minutes of [60, 1440])
    assert.equal(
      parseGoalCommand(`pr octocat/hello-world#7 ${minutes} 24`).action,
      "create",
      `structured ${minutes}`,
    );
  for (const phrase of ["a cada 5 minutos", "a cada 59 minutos"])
    assert.throws(() => parseGoalCommand(NL(phrase)), /60 to 1440/, phrase);
  for (const [phrase, minutes] of [
    ["a cada 60 minutos", 60],
    ["a cada 1 hora", 60],
    ["a cada 1440 minutos", 1440],
  ] as const) {
    const command = parseGoalCommand(NL(phrase));
    assert.equal(command.action, "create", phrase);
    if (command.action === "create") assert.equal(command.intervalMin, minutes);
  }
});

test("R1: user-facing texts state the new 60-1440 range, never the old one", () => {
  assert.match(GOAL_HELP, /60-1440/);
  assert.doesNotMatch(GOAL_HELP, /5-1440|a cada 5 minutos/);
  assert.throws(
    () => parseGoalCommand(NL("sem intervalo")),
    (error: Error) =>
      /60 to 1440/.test(error.message) &&
      !/5 to 1440|every 5 minutes|a cada 5 minutos/.test(error.message),
  );
});

test("R1: Tasks.createGoal refuses 59 directly; a stored 5-minute goal keeps its cadence", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.app.tasks.createGoal(
        f.topic,
        {
          source: "telegram",
          conversationId: f.topic,
          requestId: "telegram:goal-create:9001",
        },
        target,
        59,
        24,
      ),
      /cadence/i,
    );
    await f.send(GOAL_CMD);
    // A goal created under the old floor: its stored interval is honoured.
    f.app.store.run("UPDATE task_goals SET intervalMin=5");
    f.inject(fakeFetch([{ status: 200, body: prBody() }]).fetcher);
    const before = Date.now();
    await f.app.tasks.tick();
    const goal = f.goalRows()[0]!;
    assert.equal(goal.state, "pending");
    assert.equal(goal.attempts, 1);
    assert.equal(goal.intervalMin, 5);
    assert.ok(goal.nextRun! >= before + 5 * 60_000);
    assert.ok(goal.nextRun! <= Date.now() + 5 * 60_000);
  } finally {
    await f.close();
  }
});

// ---- R3/R4: observer kinds ----------------------------------------------------

test("R3/R4: observePrMerged maps 403 and 429 to rate_limited and 404 to not_found", async () => {
  for (const [status, kind] of [
    [403, "rate_limited"],
    [429, "rate_limited"],
    [404, "not_found"],
    [500, "retry"],
  ] as const) {
    const fetcher = async () =>
      new Response(JSON.stringify({ message: "x" }), { status });
    const observation = await observePrMerged(target, fetcher);
    assert.equal(observation.kind, kind, `HTTP ${status}`);
  }
});

// ---- R3: rate limit does not burn attempts ----------------------------------

test("R3: rate-limited passes leave attempts unchanged and notify exactly once", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const fetches = fakeFetch([
      { status: 403, body: { message: "API rate limit exceeded" } },
      { status: 429, body: { message: "Too Many Requests" } },
    ]);
    f.inject(fetches.fetcher);
    let before = Date.now();
    await f.app.tasks.tick();
    let goal = f.goalRows()[0]!;
    assert.equal(goal.state, "pending");
    assert.equal(goal.attempts, 0, "a rate-limited read is not an attempt");
    assert.ok(goal.nextRun! >= before + 60 * 60_000, "rescheduled at interval");
    f.forceDue();
    before = Date.now();
    await f.app.tasks.tick();
    goal = f.goalRows()[0]!;
    assert.equal(fetches.calls.length, 2);
    assert.equal(goal.state, "pending");
    assert.equal(goal.attempts, 0);
    assert.ok(goal.nextRun! >= before + 60 * 60_000);
    const notes = f.goalNotifications();
    assert.equal(notes.length, 1, "one notice while it stays rate limited");
    assert.match(notes[0]!.deliveryText!, /rate limit/i);
    assert.match(notes[0]!.deliveryText!, /octocat\/hello-world#7/);
    // Leaving the state and entering it again is a new, single notice.
    f.forceDue();
    f.inject(
      fakeFetch([
        { status: 200, body: prBody() },
        { status: 403, body: {} },
        { status: 403, body: {} },
      ]).fetcher,
    );
    await f.app.tasks.tick();
    assert.equal(f.goalRows()[0]!.attempts, 1, "a real read still counts");
    assert.equal(f.goalNotifications().length, 1);
    f.forceDue();
    await f.app.tasks.tick();
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(f.goalRows()[0]!.attempts, 1);
    assert.equal(f.goalNotifications().length, 2, "re-entry notifies once");
  } finally {
    await f.close();
  }
});

test("P2: an ambiguous retry keeps the same rate-limit notice; a valid open read rearms it", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const script = fakeFetch([
      { status: 403, body: {} },
      new Error("simulated timeout"),
      { status: 429, body: {} },
      { status: 200, body: prBody() },
      { status: 429, body: {} },
    ]);
    f.inject(script.fetcher);
    for (let i = 0; i < 3; i++) {
      f.forceDue();
      await f.app.tasks.tick();
    }
    assert.equal(f.goalRows()[0]!.attempts, 1, "only the timeout is charged");
    assert.equal(
      f.goalNotifications().length,
      1,
      "403 and 429 across a timeout share a notice",
    );
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(
      f.goalNotifications().length,
      1,
      "a valid open response is silent",
    );
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(script.calls.length, 5);
    assert.equal(f.goalRows()[0]!.attempts, 2, "the open response also counts");
    assert.equal(
      f.goalNotifications().length,
      2,
      "rate limiting after recovery notifies again",
    );
  } finally {
    await f.close();
  }
});

test("R3: a rate limit on the last budgeted slot does not exhaust the goal", async () => {
  const f = await fixture();
  try {
    await f.send("/goal pr octocat/hello-world#7 60 1");
    f.inject(fakeFetch([{ status: 429, body: {} }]).fetcher);
    await f.app.tasks.tick();
    const goal = f.goalRows()[0]!;
    assert.equal(goal.state, "pending");
    assert.equal(goal.attempts, 0);
  } finally {
    await f.close();
  }
});

test("R3: the rate-limit column is an additive migration over an old task_goals", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    // Rebuild the previous shape: the column the new code adds is absent.
    f.app.store.db.exec("ALTER TABLE task_goals DROP COLUMN rateLimitedAt");
    await f.restart();
    const columns = f.app.store
      .all<{ name: string }>("PRAGMA table_info(task_goals)")
      .map((c) => c.name);
    for (const name of [
      "taskId",
      "owner",
      "repo",
      "prNumber",
      "intervalMin",
      "maxAttempts",
      "attempts",
      "state",
      "reason",
      "lastResult",
      "rateLimitedAt",
    ])
      assert.ok(columns.includes(name), name);
    assert.equal(f.goalRows()[0]!.state, "pending", "old row stays readable");
    // The previous code's INSERT shape still works against the new table.
    f.app.store.run(
      "INSERT INTO task_goals(taskId,owner,repo,prNumber,intervalMin,maxAttempts) VALUES (?,?,?,?,?,?)",
      "old-shape",
      "a",
      "b",
      1,
      60,
      1,
    );
    await f.restart();
    assert.ok(
      f.app.store.get("SELECT 1 FROM task_goals WHERE taskId='old-shape'"),
    );
  } finally {
    await f.close();
  }
});

// ---- R4: 404 blocks immediately ------------------------------------------------

test("R4: a 404 blocks the goal on the first pass with a legible reason", async () => {
  const f = await fixture();
  try {
    await f.send("/goal pr octocat/hello-world#7 60 200");
    const fetches = fakeFetch([
      { status: 404, body: { message: "Not Found" } },
    ]);
    f.inject(fetches.fetcher);
    await f.app.tasks.tick();
    const goal = f.goalRows()[0]!;
    assert.equal(goal.state, "blocked");
    assert.equal(goal.attempts, 1);
    assert.equal(goal.nextRun, null);
    assert.match(goal.reason!, /does not exist/i);
    assert.match(goal.reason!, /renamed/i);
    assert.match(goal.reason!, /private/i);
    const notes = f.goalNotifications();
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.deliveryText!, /goal blocked/i);
    assert.match(notes[0]!.deliveryText!, /does not exist/i);
    const after = fakeFetch([]);
    f.inject(after.fetcher);
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(after.calls.length, 0, "no further reads after the block");
  } finally {
    await f.close();
  }
});

// ---- R5: duplicate guard ---------------------------------------------------

test("R5: a second pending goal for the same PR in the same chat is refused", async () => {
  const f = await fixture();
  try {
    await f.send("/goal pr octocat/hello-world#8 60 24");
    assert.match((await f.send(GOAL_CMD)).at(-1)!, /goal saved/i);
    const replies = await f.send("/goal pr OctoCat/Hello-World#7 120 10");
    const reply = replies.at(-1)!;
    assert.match(reply, /goal 2\b/i, reply);
    assert.match(reply, /\/goal cancel 2\b/, reply);
    assert.equal(f.goalRows().length, 2, "no duplicate was saved");
    // The natural-language form is guarded too.
    const natural = await f.send(
      "/goal acompanhe https://github.com/octocat/hello-world/pull/7 a cada 2 horas",
    );
    assert.match(natural.at(-1)!, /\/goal cancel 2\b/);
    assert.equal(f.goalRows().length, 2);
    // Once the existing goal is no longer pending, a new one is allowed.
    await f.send("/goal cancel 2");
    assert.match((await f.send(GOAL_CMD)).at(-1)!, /goal saved/i);
    assert.equal(f.goalRows().length, 3);
  } finally {
    await f.close();
  }
});

test("R5: replaying the same inbound update still confirms, not refuses", async () => {
  const f = await fixture();
  try {
    const access = { source: "telegram" as const, ...f.owner };
    const body = "pr octocat/hello-world#7 60 24";
    const first = await commandGoal(f.app, f.topic, access, body, 777);
    const replay = await commandGoal(f.app, f.topic, access, body, 777);
    assert.match(first, /goal saved/i);
    assert.equal(replay, first, "the replay answers exactly as the original");
    assert.equal(f.goalRows().length, 1);
    await assert.rejects(
      commandGoal(f.app, f.topic, access, body, 778),
      /\/goal cancel 1\b/,
    );
    assert.equal(f.goalRows().length, 1);
  } finally {
    await f.close();
  }
});

// ---- R2: /goal check N ------------------------------------------------------

test("R2: the parser reads /goal check N and never treats check as a target", () => {
  assert.deepEqual(parseGoalCommand("check 2"), { action: "check", index: 2 });
  for (const bad of [
    "check",
    "check 0",
    "check two",
    "check 1 2",
    "check https://github.com/forge-z/pi-bot/pull/66 a cada 1 hora",
    "check forge-z/pi-bot#66 every 2 hours",
  ])
    assert.throws(() => parseGoalCommand(bad), /invalid/i, bad);
});

test("R2: /goal check reports each observation kind without counting an attempt", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    const scheduled = f.goalRows()[0]!.nextRun;
    const cases: Array<[{ status: number; body: unknown } | Error, RegExp]> = [
      [{ status: 200, body: prBody() }, /still open/i],
      [{ status: 403, body: {} }, /rate limit/i],
      [{ status: 429, body: {} }, /rate limit/i],
      [new Error("simulated timeout"), /could not be reached/i],
      [{ status: 500, body: {} }, /GitHub answered 500/],
      [{ status: 200, body: prBody({ state: "closed" }) }, /closed without/i],
    ];
    for (const [response, expected] of cases) {
      const fetches = fakeFetch([response]);
      f.inject(fetches.fetcher);
      const reply = (await f.send("/goal check 1")).at(-1)!;
      assert.equal(fetches.calls.length, 1, "exactly one immediate read");
      assert.match(reply, expected);
      assert.match(reply, /octocat\/hello-world#7/);
      // Telegram views end every message with a blank line; the reply itself is one line.
      assert.doesNotMatch(reply.trim(), /\n/, "one line");
      assert.doesNotMatch(reply, /simulated/, "no raw error text");
      const goal = f.goalRows()[0]!;
      assert.equal(goal.attempts, 0, `${expected} must not count`);
      assert.equal(goal.state, "pending");
      assert.equal(goal.nextRun, scheduled, "the schedule is untouched");
    }
    assert.equal(f.goalNotifications().length, 0, "the reply is the answer");

    // Merged closes the goal as met.
    await f.send("/goal pr octocat/hello-world#8 60 24");
    f.inject(fakeFetch([{ status: 200, body: mergedBody(8) }]).fetcher);
    const merged = (await f.send("/goal check 2")).at(-1)!;
    assert.match(merged, /merged/i);
    assert.doesNotMatch(merged.trim(), /\n/);
    let goal = f.goalRows()[1]!;
    assert.equal(goal.state, "completed");
    assert.equal(goal.attempts, 0);
    assert.equal(goal.nextRun, null);

    // Not found blocks the goal with the legible reason.
    f.inject(fakeFetch([{ status: 404, body: {} }]).fetcher);
    const missing = (await f.send("/goal check 1")).at(-1)!;
    assert.match(missing, /not found|does not exist/i);
    assert.doesNotMatch(missing.trim(), /\n/);
    goal = f.goalRows()[0]!;
    assert.equal(goal.state, "blocked");
    assert.equal(goal.attempts, 0);
    assert.equal(goal.nextRun, null);
    assert.match(
      goal.reason!,
      /does not exist, was renamed, or became private/,
    );
  } finally {
    await f.close();
  }
});

test("P1: grant revocation and regrant during chat ensure invalidates /goal check before any GET", async () => {
  const f = await fixture();
  const entered = gate();
  const release = gate();
  try {
    await f.send(GOAL_CMD);
    const before = f.goalRows()[0];
    const fetches = fakeFetch([{ status: 200, body: mergedBody() }]);
    f.inject(fetches.fetcher);
    const ensure = f.app.telegramChats.ensure.bind(f.app.telegramChats);
    f.app.telegramChats.ensure = async (...args) => {
      const id = await ensure(...args);
      entered.resolve();
      await release.promise;
      return id;
    };
    const check = f.send("/goal check 1");
    await Promise.race([
      entered.promise,
      check.then(() => assert.fail("ensure did not start")),
    ]);
    f.revokeGrant();
    f.restoreGrant();
    release.resolve();
    const replies = await check;
    assert.equal(
      fetches.calls.length,
      0,
      "stale authority cannot dispatch a GET",
    );
    assert.deepEqual(f.goalRows()[0], before);
    assert.match(replies.join(" "), /not authorized/i);
    assert.doesNotMatch(replies.join(" "), /merged|hello-world/i);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("P1: /goal check in an unbound topic does not create a conversation", async () => {
  const f = await fixture();
  try {
    const unbound = { ...f.owner, messageThreadId: 99 };
    const fetches = fakeFetch([]);
    f.inject(fetches.fetcher);
    await f.receive({ text: "/goal check 1", message_thread_id: 99 });
    assert.equal(f.app.telegramChats.selection(unbound), undefined);
    assert.equal(fetches.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("P1: a queued /goal check revalidates the grant before dispatch", async () => {
  const f = await fixture();
  const scheduledStarted = gate();
  const releaseScheduled = gate();
  const queued = gate();
  let fetches = 0;
  try {
    await f.send(GOAL_CMD);
    f.inject(async () => {
      if (++fetches === 1) {
        scheduledStarted.resolve();
        await releaseScheduled.promise;
        return Response.json(prBody());
      }
      return Response.json(mergedBody());
    });
    const tick = f.app.tasks.tick();
    await scheduledStarted.promise;
    const checkGoalNow = f.app.tasks.checkGoalNow.bind(f.app.tasks);
    f.app.tasks.checkGoalNow = (...args) => {
      const result = checkGoalNow(...args);
      queued.resolve();
      return result;
    };
    const check = f.send("/goal check 1");
    await Promise.race([
      queued.promise,
      check.then(() => assert.fail("manual check did not queue")),
    ]);
    f.revokeGrant();
    releaseScheduled.resolve();
    const replies = await check;
    await tick;
    assert.equal(fetches, 1, "only the scheduled GET may be dispatched");
    assert.equal(f.goalRows()[0]!.state, "pending");
    assert.match(replies.join(" "), /not authorized/i);
    assert.doesNotMatch(replies.join(" "), /merged|hello-world/i);
  } finally {
    releaseScheduled.resolve();
    await f.close();
  }
});

for (const invalidation of [
  "grant revocation and regrant",
  "forum close and reopen",
] as const) {
  test(`P1: ${invalidation} during the GET invalidates /goal check`, async () => {
    const f = await fixture();
    const started = gate();
    const release = gate();
    try {
      await f.send(GOAL_CMD);
      const before = f.goalRows()[0]!;
      f.inject(async () => {
        started.resolve();
        await release.promise;
        return Response.json(mergedBody());
      });
      const check = f.send("/goal check 1");
      await Promise.race([
        started.promise,
        check.then(() => assert.fail("GET did not start")),
      ]);
      if (invalidation === "grant revocation and regrant") {
        f.revokeGrant();
        f.restoreGrant();
      } else {
        assert.deepEqual(await f.receive({ forum_topic_closed: {} }), {
          observed: true,
        });
        assert.deepEqual(await f.receive({ forum_topic_reopened: {} }), {
          observed: true,
        });
      }
      release.resolve();
      const replies = await check;
      assert.deepEqual(
        f.goalRows()[0],
        before,
        "the GET result must not be persisted",
      );
      assert.match(replies.join(" "), /not authorized/i);
      assert.doesNotMatch(replies.join(" "), /merged|hello-world/i);
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

for (const eligible of [true, false]) {
  test(
    `P1: polling /goal check ${eligible ? "rejects fetched close/reopen" : "ignores unrelated, stale and duplicate events"}`,
    { timeout: 5000 },
    async () => {
      const f = await fixture(-100123, false);
      const started = gate();
      const release = gate();
      const fetched = gate();
      const releasePoll = gate();
      const acknowledged = gate();
      const message = (
        id: number,
        over: Partial<NonNullable<TelegramUpdate["message"]>>,
      ): TelegramUpdate => ({
        update_id: id,
        message: {
          message_id: id,
          from: { id: 42 },
          chat: { id: Number(f.owner.chat), type: "supergroup" },
          message_thread_id: 11,
          is_topic_message: true,
          date: 200,
          ...over,
        },
      });
      const check = message(10, { text: "/goal check 1" });
      const events = eligible
        ? [
            message(11, { forum_topic_closed: {} }),
            message(12, { forum_topic_reopened: {} }),
          ]
        : [
            message(2, { forum_topic_reopened: {}, date: 100 }), // already observed
            { ...check }, // already in flight
            message(11, { forum_topic_closed: {}, date: 99 }), // older than the saved state
            message(12, { forum_topic_closed: {}, from: { id: 43 } }),
            message(13, {
              forum_topic_closed: {},
              from: { id: 42, is_bot: true },
            }),
            message(14, { forum_topic_closed: {}, message_thread_id: 12 }),
            message(15, {
              forum_topic_closed: {},
              chat: { id: -100124, type: "supergroup" },
            }),
          ];
      const ack = events.at(-1)!.update_id + 1;
      const offset = () =>
        f.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='telegram:offset:123'",
        )?.value;
      const topicState = () =>
        f.app.store.get<{ closed: number; stateUpdateId: number }>(
          "SELECT closed,stateUpdateId FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=?",
          f.owner.chat,
          f.owner.user,
          f.owner.messageThreadId,
        );
      let polls = 0;
      let reads = 0;
      let offsetWhileQueued: unknown;
      const sent: Array<{
        text: string;
        chat_id: string;
        message_thread_id?: number;
      }> = [];
      const polling = new TelegramPolling(
        f.app,
        {
          call: async (method, payload) => {
            if (method === "sendMessage") {
              sent.push(payload as (typeof sent)[number]);
              return { message_id: sent.length };
            }
            if (method !== "getUpdates") return {};
            if (++polls === 1) return [check];
            if (polls === 2) {
              await started.promise;
              return events;
            }
            if (polls === 3) {
              offsetWhileQueued = payload?.offset;
              fetched.resolve();
              await releasePoll.promise;
            }
            if (payload?.offset === ack) acknowledged.resolve();
            return [];
          },
        },
        { users: [f.owner.user], chats: [f.owner.chat] },
        { id: 123 },
      );
      try {
        await f.send(GOAL_CMD);
        await f.receive({
          forum_topic_reopened: {},
          date: 100,
          is_topic_message: true,
        });
        const before = f.goalRows()[0];
        f.app.store.run("INSERT INTO meta VALUES ('telegram:offset:123','10')");
        f.inject(async () => {
          reads++;
          started.resolve();
          await release.promise;
          return Response.json(mergedBody());
        });
        // Keep the scheduled first observation out of this test of manual checks.
        f.app.tasks.start = () => {};
        polling.start();
        await fetched.promise;
        assert.equal(
          offsetWhileQueued,
          10,
          "fetched updates have not been acknowledged",
        );
        assert.equal(offset(), "10");
        assert.deepEqual(
          { ...topicState() },
          { closed: 0, stateUpdateId: 2 },
          "durable topic events remain in the lane",
        );
        release.resolve();
        releasePoll.resolve();
        await acknowledged.promise;
        assert.equal(
          offset(),
          String(ack),
          "offset advances after lane processing",
        );
        assert.deepEqual(
          { ...topicState() },
          { closed: 0, stateUpdateId: eligible ? 12 : 2 },
        );
        assert.equal(reads, 1);
        await polling.engine.flush();
        if (eligible) {
          assert.deepEqual(
            f.goalRows()[0],
            before,
            "fetched topic changes must veto the GET result",
          );
          assert.equal(
            f.app.store.get(
              "SELECT 1 FROM deliveries WHERE id GLOB 'telegram:clean:10:*' AND text LIKE '%hello-world%'",
            ),
            undefined,
          );
          assert.doesNotMatch(
            sent.map((reply) => reply.text).join(" "),
            /merged|hello-world/i,
          );
        } else {
          assert.equal(f.goalRows()[0]!.state, "completed");
          assert.equal(sent.length, 1);
          assert.equal(sent[0]!.chat_id, f.owner.chat);
          assert.equal(sent[0]!.message_thread_id, f.owner.messageThreadId);
          assert.match(sent[0]!.text, /octocat\/hello-world#7.*merged/i);
        }
      } finally {
        started.resolve();
        release.resolve();
        releasePoll.resolve();
        await polling.close();
        await f.close();
      }
    },
  );
}

test("P1: /goal check revalidates after the scheduler returns, before reply admission", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    f.inject(fakeFetch([{ status: 200, body: prBody() }]).fetcher);
    const checkGoalNow = f.app.tasks.checkGoalNow.bind(f.app.tasks);
    f.app.tasks.checkGoalNow = async (...args) => {
      const result = await checkGoalNow(...args);
      f.revokeGrant();
      return result;
    };
    const replies = await f.send("/goal check 1");
    assert.match(replies.join(" "), /not authorized/i);
    assert.doesNotMatch(replies.join(" "), /still open|hello-world/i);
  } finally {
    await f.close();
  }
});

test("P1: an admitted /goal check reply cannot send after the topic closes and reopens", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    f.inject(fakeFetch([{ status: 200, body: prBody() }]).fetcher);
    await f.receive({ text: "/goal check 1" });
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM deliveries WHERE state='pending' AND text LIKE '%still open%'",
      ),
    );
    assert.deepEqual(await f.receive({ forum_topic_closed: {} }), {
      observed: true,
    });
    assert.deepEqual(await f.receive({ forum_topic_reopened: {} }), {
      observed: true,
    });
    assert.deepEqual(await f.flush(), []);
  } finally {
    await f.close();
  }
});

test("P1: an admitted /goal check reply cannot send after the connection generation changes", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    f.inject(fakeFetch([{ status: 200, body: prBody() }]).fetcher);
    await f.receive({ text: "/goal check 1" });
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM deliveries WHERE state='pending' AND text LIKE '%still open%'",
      ),
    );
    // The exact chat/user/bot still matches, but the allowlist generation changed.
    f.app.store.run(
      "UPDATE meta SET value=json_set(value,'$.allowedUsers',json_array('42','43')) WHERE key='telegram:connection'",
    );
    assert.deepEqual(await f.flush(), []);
  } finally {
    await f.close();
  }
});

test("P1: a plain-text retry of /goal check needs the same authorization", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    f.inject(fakeFetch([{ status: 200, body: prBody() }]).fetcher);
    const sendModes: Array<string | undefined> = [];
    f.transport.send = async (_chat, _text, options) => {
      sendModes.push(options?.parseMode);
      if (options?.parseMode === "HTML") {
        f.revokeGrant();
        throw new TelegramSendRefused(
          400,
          0,
          "Bad Request: can't parse entities",
        );
      }
      return { message_id: 2 };
    };
    await f.send("/goal check 1");
    assert.deepEqual(
      sendModes,
      ["HTML"],
      "revocation must prevent the plain-text resend",
    );
  } finally {
    await f.close();
  }
});

test("R2: /goal check on a finished goal is refused without any read", async () => {
  const f = await fixture();
  try {
    await f.send(GOAL_CMD);
    await f.send("/goal cancel 1");
    const fetches = fakeFetch([]);
    f.inject(fetches.fetcher);
    const reply = (await f.send("/goal check 1")).at(-1)!;
    assert.match(reply, /finished/i);
    assert.equal(fetches.calls.length, 0);
    assert.equal(f.goalRows()[0]!.state, "cancelled");
    const unknown = (await f.send("/goal check 5")).at(-1)!;
    assert.match(unknown, /invalid goal number/i);
    assert.equal(fetches.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("R2: /goal check is listed in /goal help, the command menu and /help", async () => {
  assert.match(GOAL_HELP, /\/goal check <number>/);
  const menu = cleanCommands.find((c) => c.command === "goal")!;
  assert.match(menu.description, /check/i);
  assert.ok(menu.description.length <= 256);
  const f = await fixture();
  try {
    // Telegram views are HTML-escaped: `<number>` arrives as `&lt;number&gt;`.
    assert.match((await f.send("/goal")).join("\n"), /\/goal check &lt;number/);
    assert.match((await f.send("/help")).join("\n"), /\/goal check/);
  } finally {
    await f.close();
  }
});

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
import { Runtime } from "../src/runtime.js";
import { Telegram, type TelegramTransport } from "../src/telegram.js";
import { GOAL_ATTEMPTS_MAX, parseGoalCommand } from "../src/goals.js";
import { linkChat } from "./link-chat.js";

/** Explicit limits for free-objective goals: check limits and end times,
 * recognized, stored, enforced and named at the ending. Real Runtime, real
 * SQLite, faux model, no network. */

// Deterministic date resolution: America/Sao_Paulo is UTC-3 with no DST.
process.env.TZ = "America/Sao_Paulo";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 2026-06-15T12:00:00Z, before every date used in the parsing tests. */
const NOW = Date.UTC(2026, 5, 15, 12);
/** End of a calendar day in UTC-3: last ms before 03:00 UTC of the next day. */
const endOf = (year: number, month: number, day: number) =>
  Date.UTC(year, month - 1, day + 1, 3) - 1;

type FauxResponses = Parameters<
  ReturnType<typeof fauxProvider>["setResponses"]
>[0];

interface GoalTaskRow {
  id: string;
  title: string;
  prompt: string;
  kind: string;
  schedule: string;
  enabled: number;
  nextRun: number | null;
  lastError: string | null;
  goalState: string | null;
  goalEvidence: string | null;
  goalAttempts: number;
  goalMaxAttempts: number | null;
  goalEndAt: number | null;
  pr: number | null;
}

const quiet = (text = "Nothing observed yet.") => fauxAssistantMessage(text);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-goal-limits-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const options = { dir, models, gateway: { catalog: async () => [] } };
  const app = await Runtime.open(options);
  /** No network: a PR goal read in these tests must never leave the process. */
  app.tasks.goalFetcher = async () => {
    throw new Error("offline test: no GitHub read");
  };
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
  const bot = new Telegram(app, transport, ["42"], ["100"], "test_bot", true, 123);
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
  /** Wait until every admitted model turn has settled in the ledger. */
  const settle = async () => {
    for (let pass = 0; pass < 400; pass += 1) {
      const pending = app.store.all<{ conversationId: string }>(
        "SELECT DISTINCT conversationId FROM requests WHERE status='pending'",
      );
      if (!pending.length) return;
      for (const row of pending)
        await (await app.conversation(row.conversationId)).waitForIdle(context);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("model turns never settled");
  };
  const goals = () =>
    app.store.all<GoalTaskRow>(
      `SELECT t.*,(SELECT 1 FROM task_goals g WHERE g.taskId=t.id) AS pr
       FROM tasks t WHERE t.kind='goal' ORDER BY t.rowid`,
    );
  const generic = () => goals().filter((row) => !row.pr);
  const goalRuns = () =>
    app.store.all<{ id: string; taskId: string; state: string }>(
      `SELECT r.* FROM task_runs r JOIN tasks t ON t.id=r.taskId
       WHERE t.kind='goal' AND NOT EXISTS (SELECT 1 FROM task_goals g WHERE g.taskId=t.id)
       ORDER BY r.rowid`,
    );
  /** Every chat message produced by a goal run: notify parts and system notices. */
  const goalMessages = () =>
    app.store.all<{ id: string; text: string; chat: string }>(
      `SELECT d.id,d.text,d.chat FROM deliveries d
       JOIN task_runs r ON substr(d.id,1,length(r.conversationId||':'||r.requestId||':'))=r.conversationId||':'||r.requestId||':'
       JOIN tasks t ON t.id=r.taskId AND t.kind='goal'
       ORDER BY d.rowid`,
    );
  return {
    get app() {
      return app;
    },
    topic,
    send,
    settle,
    goals,
    generic,
    goalRuns,
    goalMessages,
    respond(responses: FauxResponses) {
      faux.setResponses(responses);
    },
    forceDue(id?: string) {
      if (id) app.store.run("UPDATE tasks SET nextRun=0 WHERE id=?", id);
      else
        app.store.run(
          "UPDATE tasks SET nextRun=0 WHERE kind='goal' AND enabled=1",
        );
    },
    /** One scheduled pass: admit, let the turn settle, then refresh. */
    async round() {
      await app.tasks.tick();
      await settle();
      await app.tasks.tick();
    },
    async close() {
      await bot.drain();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const objectiveCommand = (args: string, now = NOW) => {
  const command = parseGoalCommand(args, now);
  assert.equal(command.action, "objective", args);
  if (command.action !== "objective") throw new Error("unreachable");
  return command;
};

// ---- Accepted check-limit phrase forms ---------------------------------------

test("each accepted check-limit phrase form is recognized and leaves the objective clean", () => {
  const forms = [
    "no maximo 20 checagens",
    "no maximo 20 vezes",
    "ate 20 checagens",
    "20 checagens no maximo",
    "at most 20 checks",
    "max 20 checks",
  ] as const;
  for (const form of forms) {
    const command = objectiveCommand(`avise quando chover a cada 60 minutos ${form}`);
    assert.equal(command.maxAttempts, 20, form);
    assert.equal(command.objective, "avise quando chover", form);
    assert.equal(command.intervalMin, 60, form);
    assert.equal(command.endAt, undefined, `${form} sets no end time`);
  }
});

test("a check limit is bounded from 1 to GOAL_ATTEMPTS_MAX", () => {
  for (const bad of ["no maximo 0 checagens", "no maximo 201 checagens"])
    assert.throws(
      () => parseGoalCommand(`avise quando chover a cada 60 minutos ${bad}`, NOW),
      /1 to 200/,
      bad,
    );
  for (const [form, max] of [
    ["no maximo 1 checagens", 1],
    ["no maximo 200 checagens", GOAL_ATTEMPTS_MAX],
  ] as const) {
    const command = objectiveCommand(`avise quando chover a cada 60 minutos ${form}`);
    assert.equal(command.maxAttempts, max, form);
  }
});

// ---- Accepted end-time phrase forms -----------------------------------------

test("an ISO date resolves to the end of that day in the bot timezone", () => {
  const command = objectiveCommand(
    "avise quando chover a cada 60 minutos ate 2026-12-05",
  );
  assert.equal(command.endAt, endOf(2026, 12, 5));
  assert.equal(command.objective, "avise quando chover");
});

test("a day/month date resolves in Brazilian order, to the next occurrence", () => {
  const future = objectiveCommand("avise quando chover a cada 60 minutos ate 30/11");
  assert.equal(future.endAt, endOf(2026, 11, 30), "this year: Nov 30 is ahead of NOW");
  const past = objectiveCommand("avise quando chover a cada 60 minutos ate 31/01");
  assert.equal(past.endAt, endOf(2027, 1, 31), "Jan 31 passed: next year");
});

test("a por-duration resolves from now, in epoch milliseconds", () => {
  const dias = objectiveCommand("avise quando chover a cada 60 minutos por 3 dias");
  assert.equal(dias.endAt, NOW + 3 * DAY_MS);
  assert.equal(dias.objective, "avise quando chover");
  const horas = objectiveCommand("avise quando chover a cada 60 minutos por 48 horas");
  assert.equal(horas.endAt, NOW + 48 * HOUR_MS);
});

test("a check limit and an end time are stored together, separately from the objective", () => {
  const command = objectiveCommand(
    "avise quando chover a cada 60 minutos no maximo 5 checagens ate 2026-12-05",
  );
  assert.equal(command.maxAttempts, 5);
  assert.equal(command.endAt, endOf(2026, 12, 5));
  assert.equal(command.objective, "avise quando chover");
});

// ---- Refused phrases ---------------------------------------------------------

test("a phrase without a number is not a limit and never changes the objective", () => {
  const command = objectiveCommand(
    "avise quando chover muito a cada 60 minutos no maximo muitas checagens",
  );
  assert.equal(command.maxAttempts, GOAL_ATTEMPTS_MAX);
  assert.equal(command.endAt, undefined);
  assert.match(command.objective, /no maximo muitas checagens/);
});

test("a weekday name is not an end time; no date is invented", () => {
  const command = objectiveCommand(
    "avise quando chover a cada 60 minutos ate sexta",
  );
  assert.equal(command.endAt, undefined);
  assert.equal(command.maxAttempts, GOAL_ATTEMPTS_MAX);
  assert.match(command.objective, /ate sexta/);
});

test("an impossible date is not an end time and stays in the objective", () => {
  const command = objectiveCommand(
    "avise quando chover a cada 60 minutos ate 31/02",
  );
  assert.equal(command.endAt, undefined);
  assert.match(command.objective, /31\/02/);
});

test("two different end times are refused, never guessed", () => {
  assert.throws(
    () =>
      parseGoalCommand(
        "avise quando chover a cada 60 minutos ate 2026-12-05 por 3 dias",
        NOW,
      ),
    /conflicting end times/i,
  );
});

// ---- A goal without limits keeps today's behaviour ---------------------------

test("a goal without limits keeps today's shape and output", () => {
  const command = objectiveCommand("avise quando chover a cada 60 minutos");
  assert.equal(command.maxAttempts, GOAL_ATTEMPTS_MAX);
  assert.equal(command.endAt, undefined);
  assert.equal(command.objective, "avise quando chover");
});

test("/goal list of a goal without limits is exactly today's line", async () => {
  const f = await fixture();
  try {
    const saved = await f.send("/goal avise quando chover a cada 60 minutos");
    assert.match(saved.at(-1)!, /at most 200 checks/);
    assert.doesNotMatch(saved.at(-1)!, /until \d{4}/);
    const listed = (await f.send("/goal list")).at(-1)!;
    assert.match(
      listed,
      /1\. \[goal\] .*chover.* — pending — attempt 0\/200 — next check /,
    );
    assert.doesNotMatch(listed, /left/);
    f.respond([quiet("Ainda não.")]);
    await f.round();
    assert.equal(f.generic()[0]!.goalState, null, "still pending");
    assert.equal(f.goalMessages().length, 0, "silence while unmet");
    assert.match(
      (await f.send("/goal list")).at(-1)!,
      /attempt 1\/200 — next check /,
    );
  } finally {
    await f.close();
  }
});

// ---- The structured PR form still parses and keeps working -------------------

test("the structured PR form still parses and keeps working", async () => {
  const structured = parseGoalCommand("pr octocat/hello-world#7 60 24");
  assert.equal(structured.action, "create");
  if (structured.action === "create") {
    assert.deepEqual(structured.target, {
      owner: "octocat",
      repo: "hello-world",
      prNumber: 7,
    });
    assert.equal(structured.intervalMin, 60);
    assert.equal(structured.maxAttempts, 24);
  }
  const natural = parseGoalCommand(
    "acompanhe forge-z/pi-bot#66 a cada 60 minutos ate 10 checagens",
  );
  assert.equal(natural.action, "create");
  if (natural.action === "create") assert.equal(natural.maxAttempts, 10);

  const f = await fixture();
  try {
    const saved = await f.send("/goal pr octocat/hello-world#7 60 24");
    assert.match(saved.at(-1)!, /Goal saved/);
    assert.match((await f.send("/goal list")).at(-1)!, /octocat\/hello-world#7 — pending — attempt 0\/24 — next check/);
  } finally {
    await f.close();
  }
});

// ---- End by check limit ------------------------------------------------------

test("a goal ends at its explicit check limit with exactly one notification naming the limit", async () => {
  const f = await fixture();
  try {
    const saved = await f.send(
      "/goal avise quando chover a cada 60 minutos no maximo 2 checagens",
    );
    assert.match(saved.at(-1)!, /at most 2 checks/);
    let listed = (await f.send("/goal list")).at(-1)!;
    assert.match(listed, /attempt 0\/2/);
    assert.match(listed, /2 checks left/);
    const goal = f.generic()[0]!;
    assert.equal(goal.prompt, "avise quando chover", "the phrase is not the prompt");
    assert.equal(goal.goalMaxAttempts, 2);

    f.respond([quiet("Ainda não."), quiet("Ainda não.")]);
    await f.round();
    assert.equal(f.generic()[0]!.goalState, null, "one attempt left");
    assert.equal(f.goalMessages().length, 0);
    assert.match((await f.send("/goal list")).at(-1)!, /1 checks? left/);
    f.forceDue();
    await f.round();

    const ended = f.generic()[0]!;
    assert.equal(ended.goalAttempts, 2);
    assert.equal(ended.goalState, "blocked");
    assert.equal(ended.enabled, 0);
    assert.equal(ended.nextRun, null);
    assert.match(ended.lastError!, /2 checks/);
    assert.match(ended.lastError!, /check limit/i);
    const messages = f.goalMessages();
    assert.equal(messages.length, 1, "exactly one notification");
    assert.match(messages[0]!.text, /Goal blocked/);
    assert.match(messages[0]!.text, /avise quando chover/);
    assert.match(messages[0]!.text, /2 checks/);
    assert.match(messages[0]!.text, /check limit/i);

    f.forceDue(ended.id);
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 2, "no third round");
    assert.equal(f.goalMessages().length, 1, "still one notification");
    assert.match((await f.send("/goal check 1")).at(-1)!, /finished|ended/i);
    listed = (await f.send("/goal list")).at(-1)!;
    assert.match(listed, /blocked/);
    assert.equal(f.goalMessages().length, 1, "no late delivery");
  } finally {
    await f.close();
  }
});

// ---- End by date ------------------------------------------------------------

test("a goal ends at its explicit end time with exactly one notification naming the date", async () => {
  const f = await fixture();
  try {
    const saved = await f.send(
      "/goal avise quando chover a cada 60 minutos por 2 horas",
    );
    assert.match(saved.at(-1)!, /until \d{4}-\d{2}-\d{2}/);
    let goal = f.generic()[0]!;
    assert.ok(goal.goalEndAt! > Date.now() + 1.5 * HOUR_MS, "two hours ahead");
    assert.equal(goal.goalMaxAttempts, null, "no explicit check limit");
    const listed = (await f.send("/goal list")).at(-1)!;
    assert.match(listed, /attempt 0\/200/);
    assert.match(listed, /ends \d{4}-\d{2}-\d{2}, 2 hours left/);

    f.respond([quiet("Ainda não.")]);
    await f.round();
    assert.equal(f.generic()[0]!.goalAttempts, 1, "one check was made");
    assert.equal(f.goalMessages().length, 0);

    // The end time arrives: the tick ends the goal before any further check.
    f.app.store.run(
      "UPDATE tasks SET goalEndAt=? WHERE id=?",
      Date.now() - 1000,
      goal.id,
    );
    await f.app.tasks.tick();
    goal = f.generic()[0]!;
    assert.equal(goal.goalState, "blocked");
    assert.equal(goal.enabled, 0);
    assert.equal(goal.nextRun, null);
    assert.match(goal.lastError!, /expired/i);
    assert.match(goal.lastError!, /\d{4}-\d{2}-\d{2}/);
    assert.match(goal.lastError!, /after 1 checks/);
    const messages = f.goalMessages();
    assert.equal(messages.length, 1, "exactly one notification");
    assert.match(messages[0]!.text, /Goal blocked/);
    assert.match(messages[0]!.text, /expired/i);
    assert.match(messages[0]!.text, /\d{4}-\d{2}-\d{2}/);
    assert.match(messages[0]!.text, /after 1 checks/);

    await f.app.tasks.tick();
    assert.equal(f.goalMessages().length, 1, "no second notification");
    assert.match((await f.send("/goal check 1")).at(-1)!, /finished|ended/i);
    assert.equal(f.goalMessages().length, 1);
  } finally {
    await f.close();
  }
});

test("a bare date in the condition is not an end time and stays in the objective", () => {
  const command = objectiveCommand(
    "me avise quando a nota fiscal vencer 30/11 a cada 2 horas",
  );
  assert.equal(command.endAt, undefined, "only an explicit ate/until date ends a goal");
  assert.equal(command.objective, "me avise quando a nota fiscal vencer 30/11");
});

test("a numeric token inside the subject is not an end time", () => {
  const command = objectiveCommand(
    "acompanhe o preco 12/05 do produto a cada 3 horas",
  );
  assert.equal(command.endAt, undefined);
  assert.equal(command.objective, "acompanhe o preco 12/05 do produto");
});

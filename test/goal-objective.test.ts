import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { Telegram, type TelegramTransport } from "../src/telegram.js";
import { parseGoalCommand } from "../src/goals.js";
import { linkChat } from "./link-chat.js";

/** Generic persistent goals: a kind='goal' task whose model round ends the
 * goal through goal_reached. Real Runtime, real SQLite, faux model, no network. */

type FauxResponses = Parameters<
  ReturnType<typeof fauxProvider>["setResponses"]
>[0];
type FauxContext = { messages: Parameters<typeof getCurrentTools>[0] };

interface GoalTaskRow {
  id: string;
  title: string;
  prompt: string;
  kind: string;
  schedule: string;
  enabled: number;
  nextRun: number | null;
  lastError: string | null;
  destinationChat: string | null;
  destinationMessageThreadId: number | null;
  goalState: string | null;
  goalEvidence: string | null;
  goalAttempts: number;
  goalMaxAttempts: number | null;
  pr: number | null;
}

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });
const quiet = (text = "Nothing observed yet.") => fauxAssistantMessage(text);
const toolNames = (ctx: FauxContext) =>
  getCurrentTools(ctx.messages).map((tool) => tool.name);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-goal-objective-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const options = { dir, models, gateway: { catalog: async () => [] } };
  let app = await Runtime.open(options);
  /** No network: a PR goal read in these tests must never leave the process. */
  const offline = () => {
    app.tasks.goalFetcher = async () => {
      throw new Error("offline test: no GitHub read");
    };
  };
  offline();
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
    app.store.all<{
      id: string;
      taskId: string;
      state: string;
      status: string | null;
      scheduled: number;
      requestId: string;
    }>(
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
    faux,
    dir,
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
    async restart() {
      await bot.drain();
      await app.close();
      app = await Runtime.open(options);
      offline();
      bot = engine();
    },
    async close() {
      await bot.drain();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const OBJECTIVE = "avise quando o relatório mensal aparecer no drive";

// ---- Parsing and routing ---------------------------------------------------

test("a free objective parses into a generic goal; a PR target keeps the PR form", () => {
  assert.deepEqual(parseGoalCommand(`${OBJECTIVE} a cada 2 horas`), {
    action: "objective",
    objective: OBJECTIVE,
    intervalMin: 120,
    maxAttempts: 200,
  });
  assert.deepEqual(
    parseGoalCommand(
      "avise quando chover em SP a cada 60 min no máximo 5 vezes",
    ),
    {
      action: "objective",
      objective: "avise quando chover em SP",
      intervalMin: 60,
      maxAttempts: 5,
    },
  );
  // A link to another site is part of the objective, not a PR target.
  assert.deepEqual(
    parseGoalCommand(
      "avise quando https://status.example.com mostrar operacional a cada 90 minutos",
    ),
    {
      action: "objective",
      objective: "avise quando https://status.example.com mostrar operacional",
      intervalMin: 90,
      maxAttempts: 200,
    },
  );
  // Any public GitHub PR target keeps the deterministic PR goal.
  assert.deepEqual(
    parseGoalCommand("acompanhe forge-z/pi-bot#66 a cada 60 minutos"),
    {
      action: "create",
      target: { owner: "forge-z", repo: "pi-bot", prNumber: 66 },
      intervalMin: 60,
      maxAttempts: 200,
    },
  );
});

test("a free objective is refused without objective, without interval, out of range, or as an ambiguous PR", () => {
  assert.throws(
    () => parseGoalCommand("a cada 60 minutos"),
    /objective|what to watch/i,
  );
  assert.throws(
    () => parseGoalCommand("a cada 60 minutos no máximo 3 vezes"),
    /objective|what to watch/i,
  );
  assert.throws(() => parseGoalCommand("avise quando chover"), /interval/i);
  assert.throws(
    () => parseGoalCommand("avise quando chover a cada 59 minutos"),
    /60 to 1440/,
  );
  assert.throws(
    () => parseGoalCommand("avise quando chover a cada 30 min"),
    /60 to 1440/,
  );
  assert.throws(
    () => parseGoalCommand("avise quando chover a cada 25 horas"),
    /60 to 1440/,
  );
  // A PR mention without a repository is neither a valid PR goal nor a free one.
  assert.throws(
    () => parseGoalCommand("avise quando a PR #66 sair a cada 60 minutos"),
    /repository/i,
  );
  assert.throws(
    () => parseGoalCommand("avise quando o #66 sair a cada 60 minutos"),
    /repository/i,
  );
});

// ---- Schema and creation ----------------------------------------------------

test("an old database gains the goal columns additively and its rows stay intact as pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-goal-migration-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const options = { dir, models, gateway: { catalog: async () => [] } };
  try {
    let app = await Runtime.open(options);
    const conversation = await app.create("Old volume");
    const cron = await app.tasks.create({
      title: "Old cron",
      prompt: "Resuma o dia",
      kind: "cron",
      schedule: "0 9 * * *",
      timezone: "UTC",
      conversationId: conversation,
      delivery: "none",
    });
    // A generic goal row exactly as an explicit-column INSERT without the
    // new columns writes it.
    app.store.run(
      "INSERT INTO tasks(id,title,prompt,conversationId,kind,schedule,timezone,delivery,enabled,nextRun) VALUES ('legacy-goal','Legacy goal','avise quando X acontecer',?,'goal','every-60m','UTC','none',1,?)",
      conversation,
      Date.now() + 3_600_000,
    );
    await app.close();
    // Rewind the schema to the pre-feature shape.
    const raw = new DatabaseSync(join(dir, "app.sqlite"));
    const legacy = [
      "goalState",
      "goalEvidence",
      "goalAttempts",
      "goalMaxAttempts",
    ];
    const info = raw.prepare("PRAGMA table_info(tasks)").all();
    const present = info.map((row) => String(row.name));
    for (const column of legacy)
      if (present.includes(column))
        raw.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
    const before = raw
      .prepare(
        "SELECT id,title,prompt,conversationId,kind,schedule,timezone,delivery,enabled,nextRun,lastError FROM tasks ORDER BY rowid",
      )
      .all();
    raw.close();

    app = await Runtime.open(options);
    const columns = app.store
      .all<{ name: string; notnull: number }>("PRAGMA table_info(tasks)")
      .map((row) => row.name);
    assert.ok(columns.includes("goalState"), "goalState is added");
    assert.ok(columns.includes("goalEvidence"), "goalEvidence is added");
    assert.deepEqual(
      app.store.all(
        "SELECT id,title,prompt,conversationId,kind,schedule,timezone,delivery,enabled,nextRun,lastError FROM tasks ORDER BY rowid",
      ),
      before,
      "existing rows are untouched",
    );
    const rows = app.store.all<{ id: string; goalState: string | null }>(
      "SELECT id,goalState,goalEvidence FROM tasks ORDER BY rowid",
    );
    assert.ok(rows.every((row) => row.goalState === null));
    assert.equal(app.tasks.get(cron.id)?.kind, "cron", "the cron still reads");
    assert.match(
      app.tasks.goalList(conversation),
      /Legacy goal|avise quando X acontecer/,
    );
    assert.match(app.tasks.goalList(conversation), /pending/);
    await app.close();
    // Idempotent: a second open adds nothing and fails nothing.
    app = await Runtime.open(options);
    assert.equal(
      app.store
        .all<{ name: string }>("PRAGMA table_info(tasks)")
        .filter((row) => row.name === "goalState").length,
      1,
    );
    await app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Tasks.create accepts kind goal with the 60-minute floor and keeps it out of generic lists", async () => {
  const f = await fixture();
  try {
    const task = await f.app.tasks.create({
      title: "Relatório",
      prompt: OBJECTIVE,
      kind: "goal",
      schedule: "every-60m",
      timezone: "UTC",
      conversationId: f.topic,
      delivery: "web_telegram",
    });
    assert.equal(task.kind, "goal");
    assert.equal(task.enabled, true);
    assert.ok(task.nextRun! > Date.now() + 59 * 60_000);
    assert.equal(f.app.tasks.get(task.id), undefined, "not a /crons row");
    assert.ok(!f.app.tasks.list().some((row) => row.id === task.id));
    await assert.rejects(
      f.app.tasks.create({
        title: "Rápido demais",
        prompt: OBJECTIVE,
        kind: "goal",
        schedule: "every-30m",
        timezone: "UTC",
        conversationId: f.topic,
        delivery: "web_telegram",
      }),
      /60/,
    );
    await assert.rejects(
      f.app.tasks.create({
        title: "Tipo",
        prompt: OBJECTIVE,
        kind: "watch",
        schedule: "every-60m",
        timezone: "UTC",
        conversationId: f.topic,
      }),
      /type/i,
    );
  } finally {
    await f.close();
  }
});

test("/goal with a free objective creates a kind=goal task; a PR target keeps the PR goal", async () => {
  const f = await fixture();
  try {
    const saved = await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    assert.match(saved.at(-1)!, /goal saved/i);
    assert.match(saved.at(-1)!, /every 120 minutes/);
    let rows = f.goals();
    assert.equal(rows.length, 1);
    const goal = rows[0]!;
    assert.equal(goal.pr, null, "no PR metadata for a free objective");
    assert.equal(goal.prompt, OBJECTIVE, "the prompt is the objective");
    assert.equal(goal.schedule, "every-120m");
    assert.equal(goal.enabled, 1);
    assert.ok(goal.nextRun !== null, "the first check is scheduled");
    assert.equal(goal.goalState, null, "pending");
    assert.equal(goal.goalAttempts, 0);
    assert.equal(goal.destinationChat, "100");
    assert.equal(goal.destinationMessageThreadId, 11);
    assert.equal(f.app.store.all("SELECT 1 FROM task_goals").length, 0);

    const pr = await f.send(
      "/goal acompanhe forge-z/pi-bot#66 a cada 60 minutos",
    );
    assert.match(pr.at(-1)!, /forge-z\/pi-bot#66/);
    rows = f.goals();
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.pr, 1, "a PR target stays a deterministic PR goal");

    for (const [bad, expected] of [
      ["/goal avise quando chover a cada 30 minutos", /60 to 1440/],
      ["/goal avise quando chover", /interval/i],
      ["/goal a cada 60 minutos", /objective|what to watch/i],
      ["/goal avise quando a PR #66 sair a cada 60 minutos", /repository/i],
    ] as const) {
      const reply = (await f.send(bad)).at(-1)!;
      assert.match(reply, expected, bad);
      assert.equal(f.goals().length, 2, `${bad} created a goal`);
    }
  } finally {
    await f.close();
  }
});

// ---- The ordinary tick runs goal rounds --------------------------------------

test("the tick selects due goal tasks but admits only one goal check per tick", async () => {
  const f = await fixture();
  try {
    await f.send("/goal avise quando chover a cada 60 minutos");
    await f.send("/goal avise quando nevar a cada 60 minutos");
    await f.send("/goal avise quando ventar a cada 60 minutos");
    f.respond([quiet(), quiet(), quiet()]);
    const start = Date.now();
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 1, "one goal round in the first tick");
    await f.settle();
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 2, "the next tick admits the next one");
    await f.settle();
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 3);
    await f.settle();
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 3, "nothing is due any more");
    for (const goal of f.generic()) {
      assert.equal(goal.goalAttempts, 1);
      assert.equal(goal.enabled, 1, "a goal keeps its schedule like a cron");
      assert.ok(goal.nextRun! >= start + 59 * 60_000, "rescheduled");
    }
    assert.equal(
      new Set(f.goalRuns().map((run) => run.taskId)).size,
      3,
      "each goal ran once",
    );
  } finally {
    await f.close();
  }
});

test("a goal round without goal_reached delivers nothing and only reschedules", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    f.respond([quiet("O relatório ainda não apareceu.")]);
    const start = Date.now();
    await f.round();
    const [run] = f.goalRuns();
    assert.equal(run?.state, "done");
    assert.equal(run?.status, "silencioso");
    assert.equal(f.goalMessages().length, 0, "silence while unmet");
    const goal = f.generic()[0]!;
    assert.equal(goal.goalState, null);
    assert.equal(goal.enabled, 1);
    assert.equal(goal.goalAttempts, 1);
    assert.ok(goal.nextRun! >= start + 119 * 60_000, "next check in 2 hours");
    assert.equal(goal.goalEvidence, null);
  } finally {
    await f.close();
  }
});

test("goal_reached is offered only in a goal round and refused elsewhere without touching other tasks", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    const goal = f.generic()[0]!;
    f.app.store.run(
      "UPDATE tasks SET nextRun=? WHERE id=?",
      Date.now() + 3_600_000,
      goal.id,
    );
    const cron = await f.app.tasks.create({
      title: "Cron",
      prompt: "Resuma o dia",
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
      conversationId: f.topic,
      delivery: "none",
    });
    f.forceDue(cron.id);
    const tools: string[][] = [];
    const transcripts: string[] = [];
    f.respond([
      (ctx: FauxContext) => {
        tools.push(toolNames(ctx));
        return toolUse(
          fauxToolCall("goal_reached", { evidence: "fake: it happened" }),
        );
      },
      (ctx: FauxContext) => {
        transcripts.push(JSON.stringify(ctx.messages));
        return quiet("ok");
      },
    ]);
    await f.round();
    assert.ok(tools[0]!.includes("notify"), "a cron round may notify");
    assert.ok(
      !tools[0]!.includes("goal_reached"),
      "a cron round is not offered goal_reached",
    );
    assert.match(transcripts[0]!, /only available in a scheduled goal check/i);
    const after = f.generic()[0]!;
    assert.equal(after.goalState, null, "another task's goal is untouched");
    assert.equal(after.enabled, 1);
    assert.equal(after.goalEvidence, null);
    const cronRow = f.app.store.get<{
      enabled: number;
      goalState: string | null;
    }>("SELECT enabled,goalState FROM tasks WHERE id=?", cron.id)!;
    assert.equal(cronRow.enabled, 1, "the cron keeps running");
    assert.equal(cronRow.goalState, null);

    // A user turn is not a scheduled run at all.
    f.respond([
      (ctx: FauxContext) => {
        tools.push(toolNames(ctx));
        return toolUse(fauxToolCall("goal_reached", { evidence: "user" }));
      },
      (ctx: FauxContext) => {
        transcripts.push(JSON.stringify(ctx.messages));
        return quiet("");
      },
    ]);
    const web = await f.app.create("Web chat");
    await f.app.submit(web, "web:goal-probe", "oi", "web");
    await f.settle();
    assert.ok(!tools[1]!.includes("goal_reached"));
    assert.match(transcripts[1]!, /only available in a scheduled goal check/i);
    assert.equal(f.generic()[0]!.goalState, null);
  } finally {
    await f.close();
  }
});

test("goal_reached without evidence is refused and the goal stays pending", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    const transcripts: string[] = [];
    f.respond([
      toolUse(fauxToolCall("goal_reached", { evidence: "   " })),
      (ctx: FauxContext) => {
        transcripts.push(JSON.stringify(ctx.messages));
        return quiet("");
      },
    ]);
    await f.round();
    assert.match(transcripts[0]!, /needs evidence/i);
    const goal = f.generic()[0]!;
    assert.equal(goal.goalState, null);
    assert.equal(goal.enabled, 1);
    assert.equal(goal.goalEvidence, null);
    assert.equal(f.goalMessages().length, 0);
  } finally {
    await f.close();
  }
});

test("notify then goal_reached closes the goal once; a repeated call is a no-op", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    const tools: string[][] = [];
    const prompts: string[] = [];
    const transcripts: string[] = [];
    const evidence = "relatorio-novembro.pdf apareceu no Drive às 10:02";
    f.respond([
      (ctx: FauxContext) => {
        tools.push(toolNames(ctx));
        prompts.push(JSON.stringify(ctx.messages));
        return toolUse(
          fauxToolCall("notify", { text: `Meta atingida: ${evidence}` }),
          fauxToolCall("goal_reached", { evidence }),
        );
      },
      toolUse(fauxToolCall("goal_reached", { evidence: "second call" })),
      (ctx: FauxContext) => {
        transcripts.push(JSON.stringify(ctx.messages));
        return quiet("feito");
      },
    ]);
    await f.round();
    assert.ok(tools[0]!.includes("goal_reached"), "offered in a goal round");
    assert.ok(tools[0]!.includes("notify"));
    assert.match(prompts[0]!, /relatório mensal aparecer no drive/);
    assert.match(
      prompts[0]!,
      /call notify once with the evidence .*then call goal_reached/,
      "the round carries the contract",
    );
    assert.match(transcripts[0]!, /already recorded/i);
    const goal = f.generic()[0]!;
    assert.equal(goal.goalState, "met");
    assert.equal(goal.goalEvidence, evidence, "the first evidence is kept");
    assert.equal(goal.enabled, 0);
    assert.equal(goal.nextRun, null);
    const messages = f.goalMessages();
    assert.equal(messages.length, 1, "exactly one message: the notify");
    assert.match(messages[0]!.text, /Meta atingida/);
    assert.equal(messages[0]!.chat, "100");
    // The goal is over: no further round, even if a row looks due.
    f.forceDue(goal.id);
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 1);
    assert.match(f.app.tasks.goalList(f.topic), /met/);
    // A restart reads the terminal state back.
    await f.restart();
    assert.equal(f.generic()[0]!.goalState, "met");
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 1);
  } finally {
    await f.close();
  }
});

// ---- R4: silence guaranteed by code -------------------------------------------

test("R4: a goal round holds notify and delivers it only when goal_reached is called, once and in order", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    const seen: number[] = [];
    const transcripts: string[] = [];
    const evidence = "relatorio-novembro.pdf apareceu no Drive às 10:02";
    f.respond([
      toolUse(fauxToolCall("notify", { text: "Primeira: o relatório saiu." })),
      (ctx: FauxContext) => {
        seen.push(f.goalMessages().length);
        transcripts.push(JSON.stringify(ctx.messages));
        return toolUse(
          fauxToolCall("notify", { text: "Segunda: arquivo de novembro." }),
        );
      },
      () => {
        seen.push(f.goalMessages().length);
        return toolUse(fauxToolCall("goal_reached", { evidence }));
      },
      (ctx: FauxContext) => {
        seen.push(f.goalMessages().length);
        transcripts.push(JSON.stringify(ctx.messages));
        return toolUse(
          fauxToolCall("notify", { text: "Terceira: depois do fim." }),
        );
      },
      (ctx: FauxContext) => {
        transcripts.push(JSON.stringify(ctx.messages));
        return quiet("feito");
      },
    ]);
    await f.round();
    assert.deepEqual(
      seen,
      [0, 0, 2],
      "nothing reaches the chat before goal_reached; both held messages after it",
    );
    assert.match(transcripts[0]!, /held/i, "notify says it was held");
    const texts = f.goalMessages().map((message) => message.text);
    assert.equal(texts.length, 2, "each held message is delivered once");
    assert.match(texts[0]!, /Primeira/);
    assert.match(texts[1]!, /Segunda/, "in the order notify was called");
    assert.ok(
      !texts.some((text) => /Terceira/.test(text)),
      "a notify after goal_reached sends nothing",
    );
    assert.match(transcripts[2]!, /already reached|nothing more was sent/i);
    const goal = f.generic()[0]!;
    assert.equal(goal.goalState, "met");
    assert.equal(goal.goalEvidence, evidence);
    assert.equal(f.goalRuns()[0]!.status, "ok");
    await f.app.tasks.tick();
    assert.equal(f.goalMessages().length, 2, "no late delivery");
  } finally {
    await f.close();
  }
});

test("R4: a round that ends without goal_reached sends nothing and discards what it held, across rounds and restarts", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    f.respond([
      toolUse(fauxToolCall("notify", { text: "Talvez: vi algo parecido." })),
      quiet("Ainda não tenho certeza."),
    ]);
    await f.round();
    assert.equal(f.goalMessages().length, 0, "an unmet round is silent");
    assert.equal(f.goalRuns()[0]!.status, "silencioso");
    let goal = f.generic()[0]!;
    assert.equal(goal.goalState, null, "still pending");
    assert.equal(goal.enabled, 1);

    // A second unmet round in the same process holds and drops its own text.
    f.forceDue();
    f.respond([
      toolUse(fauxToolCall("notify", { text: "Talvez de novo." })),
      quiet(""),
    ]);
    await f.round();
    assert.equal(f.goalMessages().length, 0);

    // After a restart the next round reaches the goal with no notify of its
    // own: only the standard message goes out, never a held text from before.
    await f.restart();
    f.forceDue();
    const evidence = "relatorio-dezembro.pdf no Drive às 09:15";
    f.respond([
      toolUse(fauxToolCall("goal_reached", { evidence })),
      quiet("feito"),
    ]);
    await f.round();
    const texts = f.goalMessages().map((message) => message.text);
    assert.equal(texts.length, 1);
    assert.ok(!/Talvez/.test(texts[0]!), "nothing leaks from earlier rounds");
    assert.match(texts[0]!, /relatorio-dezembro\.pdf/);
    goal = f.generic()[0]!;
    assert.equal(goal.goalState, "met");
  } finally {
    await f.close();
  }
});

test("R4: goal_reached with nothing held sends one standard message with the evidence", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    const evidence = "relatorio-novembro.pdf apareceu no Drive às 10:02";
    f.respond([
      toolUse(fauxToolCall("goal_reached", { evidence })),
      toolUse(fauxToolCall("goal_reached", { evidence: "repetido" })),
      quiet("feito"),
    ]);
    await f.round();
    const texts = f.goalMessages().map((message) => message.text);
    assert.equal(texts.length, 1, "exactly one message, even on a repeat");
    assert.match(texts[0]!, /Goal reached/);
    assert.match(texts[0]!, /relatório mensal aparecer no drive/);
    assert.match(texts[0]!, /relatorio-novembro\.pdf apareceu no Drive/);
    assert.ok(!/repetido/.test(texts[0]!));
    assert.equal(f.goalMessages()[0]!.chat, "100");
    assert.equal(f.goalRuns()[0]!.status, "ok");
    assert.equal(f.generic()[0]!.goalState, "met");
  } finally {
    await f.close();
  }
});

test("R4: cron and once rounds still deliver notify immediately", async () => {
  const f = await fixture();
  try {
    const taskMessages = (taskId: string) =>
      f.app.store.all<{ text: string }>(
        `SELECT d.text FROM deliveries d
         JOIN task_runs r ON substr(d.id,1,length(r.conversationId||':'||r.requestId||':notify'))=r.conversationId||':'||r.requestId||':notify'
         WHERE r.taskId=? ORDER BY d.rowid`,
        taskId,
      );
    for (const [kind, schedule] of [
      ["cron", "0 9 * * *"],
      ["once", "2099-01-01T00:00:00Z"],
    ] as const) {
      const task = await f.app.tasks.create({
        title: `Aviso ${kind}`,
        prompt: "Avise que o lembrete disparou",
        kind,
        schedule,
        timezone: "UTC",
        conversationId: f.topic,
        delivery: "web_telegram",
      });
      f.forceDue(task.id);
      const seen: number[] = [];
      f.respond([
        toolUse(fauxToolCall("notify", { text: `Lembrete ${kind}` })),
        () => {
          seen.push(taskMessages(task.id).length);
          return quiet("ok");
        },
      ]);
      await f.round();
      assert.deepEqual(seen, [1], `${kind}: notify is delivered at once`);
      const texts = taskMessages(task.id).map((row) => row.text);
      assert.equal(texts.length, 1);
      assert.match(texts[0]!, new RegExp(`Lembrete ${kind}`));
      f.app.store.run("UPDATE tasks SET enabled=0 WHERE id=?", task.id);
    }
  } finally {
    await f.close();
  }
});

test("R4: /goal check follows the same rule in a manual round", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    f.app.store.run(
      "UPDATE tasks SET nextRun=? WHERE kind='goal'",
      Date.now() + 3_600_000,
    );
    f.respond([
      toolUse(fauxToolCall("notify", { text: "Talvez: algo parecido." })),
      quiet("Ainda não."),
    ]);
    await f.send("/goal check 1");
    await f.settle();
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 1);
    assert.equal(f.goalRuns()[0]!.scheduled, 0, "a manual round");
    assert.equal(f.goalMessages().length, 0, "an unmet manual round is silent");
    assert.equal(f.generic()[0]!.goalState, null);

    const seen: number[] = [];
    f.respond([
      toolUse(fauxToolCall("notify", { text: "Achei: relatório no Drive." })),
      () => {
        seen.push(f.goalMessages().length);
        return toolUse(
          fauxToolCall("goal_reached", { evidence: "relatorio.pdf, 11:40" }),
        );
      },
      () => {
        seen.push(f.goalMessages().length);
        return quiet("feito");
      },
    ]);
    await f.send("/goal check 1");
    await f.settle();
    await f.app.tasks.tick();
    assert.deepEqual(seen, [0, 1], "held until goal_reached, then delivered");
    const texts = f.goalMessages().map((message) => message.text);
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /Achei/);
    assert.ok(!texts.some((text) => /Talvez/.test(text)));
    assert.equal(f.generic()[0]!.goalState, "met");
  } finally {
    await f.close();
  }
});

// ---- Commands and guards ----------------------------------------------------

test("/goal list, check and cancel cover both kinds; a finished goal refuses check", async () => {
  const f = await fixture();
  try {
    await f.send("/goal pr octocat/hello-world#7 60 24");
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    let listed = (await f.send("/goal list")).at(-1)!;
    assert.match(
      listed,
      /1\. \[pr\] octocat\/hello-world#7 — pending — attempt 0\/24/,
    );
    assert.match(
      listed,
      /2\. \[goal\] .*relatório mensal.* — pending — attempt 0\/200/,
    );
    assert.match(listed, /next check/);

    // Neither goal is due: only the manual check may run a round.
    f.app.store.run(
      "UPDATE tasks SET nextRun=? WHERE kind='goal'",
      Date.now() + 3_600_000,
    );
    const before = f.generic()[0]!;
    f.respond([quiet("Ainda não.")]);
    const checked = (await f.send("/goal check 2")).at(-1)!;
    assert.match(checked, /Goal 2/);
    assert.match(checked, /not counted as an attempt/i);
    await f.settle();
    await f.app.tasks.tick();
    const runs = f.goalRuns();
    assert.equal(runs.length, 1, "check runs the round now");
    assert.equal(runs[0]!.scheduled, 0, "a manual round");
    assert.equal(runs[0]!.state, "done");
    let after = f.generic()[0]!;
    assert.equal(after.goalAttempts, 0, "no attempt consumed");
    assert.equal(after.nextRun, before.nextRun, "the schedule is untouched");
    assert.equal(f.goalMessages().length, 0);

    const cancelled = (await f.send("/goal cancel 2")).at(-1)!;
    assert.match(cancelled, /cancelled/i);
    after = f.generic()[0]!;
    assert.equal(after.goalState, "cancelled");
    assert.equal(after.enabled, 0);
    assert.equal(after.nextRun, null);
    const refused = (await f.send("/goal check 2")).at(-1)!;
    assert.match(refused, /finished|ended/i);
    assert.equal(f.goalRuns().length, 1, "a finished goal runs nothing");
    assert.match((await f.send("/goal cancel 2")).at(-1)!, /already ended/i);

    assert.match((await f.send("/goal cancel 1")).at(-1)!, /cancelled/i);
    assert.equal(
      f.app.store.get<{ state: string }>("SELECT state FROM task_goals")!.state,
      "cancelled",
    );
    listed = (await f.send("/goal list")).at(-1)!;
    assert.match(listed, /1\. \[pr\].* — cancelled/);
    assert.match(listed, /2\. \[goal\].* — cancelled/);
    f.forceDue();
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 1);
  } finally {
    await f.close();
  }
});

test("exhausted attempts block the goal with one legible message", async () => {
  const f = await fixture();
  try {
    await f.send(
      "/goal avise quando chover a cada 60 minutos no máximo 2 vezes",
    );
    assert.match((await f.send("/goal list")).at(-1)!, /attempt 0\/2/);
    f.respond([quiet(), quiet()]);
    await f.round();
    assert.equal(f.generic()[0]!.goalState, null, "one attempt left");
    assert.equal(f.goalMessages().length, 0);
    f.forceDue();
    await f.round();
    const goal = f.generic()[0]!;
    assert.equal(goal.goalAttempts, 2);
    assert.equal(goal.goalState, "blocked");
    assert.equal(goal.enabled, 0);
    assert.equal(goal.nextRun, null);
    assert.match(goal.lastError!, /2 checks/);
    const messages = f.goalMessages();
    assert.equal(messages.length, 1, "one blocked message");
    assert.match(messages[0]!.text, /Goal blocked/);
    assert.match(messages[0]!.text, /avise quando chover/);
    assert.match(messages[0]!.text, /2 checks/);
    f.forceDue(goal.id);
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 2, "no third round");
    assert.match((await f.send("/goal list")).at(-1)!, /blocked/);
    assert.match((await f.send("/goal check 1")).at(-1)!, /finished/i);
    assert.equal(f.goalMessages().length, 1, "still one message");
  } finally {
    await f.close();
  }
});

test("a WhatsApp-gateway volume runs no goal rounds", async () => {
  const f = await fixture();
  try {
    await f.send(`/goal ${OBJECTIVE} a cada 2 horas`);
    f.app.options.phoneGateway = "whatsapp";
    await f.app.tasks.tick();
    assert.equal(f.goalRuns().length, 0, "no goal round on WhatsApp");
    assert.equal(f.generic()[0]!.goalAttempts, 0);
    f.app.options.phoneGateway = undefined;
    f.respond([quiet()]);
    await f.round();
    assert.equal(f.goalRuns().length, 1, "the Telegram volume resumes");
  } finally {
    await f.close();
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Registry, ToolExecutionApi } from "@earendil-works/pi-durable";
import { DurableTaskError, DurableTasks } from "../src/durable-tasks.js";
import { loadHarnessConfig } from "../src/harness-config.js";
import { Runtime } from "../src/runtime.js";
import { Store, type RequestRow } from "../src/store.js";
import { Tasks } from "../src/tasks.js";

const gateway = { catalog: async () => [] };
const epoch = 1_800_000_000_000;

async function temp(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-durable-tasks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function storeFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-durable-tasks-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}

async function fixture(t: TestContext) {
  const store = await storeFixture(t);
  let now = epoch;
  return {
    store,
    tasks: new DurableTasks(store, () => now),
    setTime: (time: number) => {
      now = time;
    },
  };
}

test("durable tasks round-trip and creation replays keep the original row", async (t) => {
  const { tasks, setTime } = await fixture(t);
  const first = tasks.create("1", "First goal", "call:1");
  assert.match(first.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert.deepEqual(
    { ...first },
    {
      id: first.id,
      conversationId: "1",
      goal: "First goal",
      state: "queued",
      createdAt: epoch,
      updatedAt: epoch,
      lastError: null,
      creationKey: "call:1",
      runConversationId: null,
      attempts: 0,
      maxAttempts: 3,
      nextRun: null,
      deadlineAt: null,
      budgetTurns: 0,
    },
  );
  setTime(epoch + 1000);
  const second = tasks.create("1", "Second goal");
  assert.deepEqual(tasks.create("1", "First goal", "call:1"), first);
  assert.throws(
    () => tasks.create("1", "Changed goal", "call:1"),
    DurableTaskError,
  );
  assert.deepEqual(tasks.get("1", first.id), first);
  assert.deepEqual(tasks.list("1"), [second, first]);
});

test("durable tasks validate the goal before inserting", async (t) => {
  const { tasks } = await fixture(t);
  for (const goal of ["", " \n\t", "x".repeat(4001)])
    assert.throws(() => tasks.create("1", goal), DurableTaskError);
  assert.deepEqual(tasks.list("1"), []);
  assert.equal(tasks.create("1", "x".repeat(4000)).goal.length, 4000);
});

test("lookups, transitions and creation keys stay inside their conversation", async (t) => {
  const { tasks } = await fixture(t);
  const task = tasks.create("1", "Private goal", "same-key");
  const other = tasks.create("2", "Other goal", "same-key");
  assert.notEqual(other.id, task.id);
  assert.equal(tasks.get("2", task.id), undefined);
  assert.deepEqual(tasks.list("2"), [other]);
  assert.throws(() => tasks.transition("2", task.id, "interrupted"), {
    name: DurableTaskError.name,
    message: "Durable task not found",
  });
  assert.deepEqual(tasks.get("1", task.id), task);
});

test("a transition outside the current transition table is refused", async (t) => {
  const { tasks } = await fixture(t);
  const task = tasks.create("1", "Goal");
  assert.throws(() => tasks.transition("1", task.id, "done"), DurableTaskError);
  assert.deepEqual(tasks.get("1", task.id), task);
});

test("the resume scan interrupts only queued and running tasks and is then a no-op", async (t) => {
  const { tasks, store, setTime } = await fixture(t);
  const queued = tasks.create("1", "Queued goal");
  const running = tasks.create("2", "Running goal");
  store.run("UPDATE durable_tasks SET state='running' WHERE id=?", running.id);
  const untouched = [
    "done",
    "cancelled",
    "interrupted",
    "ready_for_review",
  ].map((state) => {
    const task = tasks.create("2", state);
    store.run(
      "UPDATE durable_tasks SET state=?,lastError='previous' WHERE id=?",
      state,
      task.id,
    );
    return tasks.get("2", task.id);
  });
  setTime(epoch + 1000);
  const changed = tasks.resumeOnBoot();
  assert.deepEqual(
    changed.map((task) => task.id).sort(),
    [queued.id, running.id].sort(),
  );
  for (const row of changed) {
    assert.equal(row.state, "interrupted");
    assert.equal(row.lastError, "restart");
    assert.equal(row.updatedAt, epoch + 1000);
    assert.deepEqual(tasks.get(row.conversationId, row.id), row);
  }
  for (const row of untouched) {
    assert.ok(row);
    assert.deepEqual(tasks.get("2", row.id), row);
  }
  setTime(epoch + 2000);
  assert.deepEqual(tasks.resumeOnBoot(), []);
  for (const row of changed)
    assert.deepEqual(tasks.get(row.conversationId, row.id), row);
});

test("runtime open adds durable_tasks to a pre-slice database and preserves unrelated rows", async (t) => {
  const dir = await temp(t);
  const old = new Store(dir);
  old.run("INSERT INTO meta VALUES ('migration-fixture', 'keep me')");
  assert.equal(
    old.get("SELECT 1 FROM sqlite_master WHERE name='durable_tasks'"),
    undefined,
  );
  old.close();

  const app = await Runtime.open({ dir, gateway, env: {} });
  try {
    assert.deepEqual(app.store.all("SELECT * FROM durable_tasks"), []);
    assert.equal(
      app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='migration-fixture'",
      )?.value,
      "keep me",
    );
  } finally {
    await app.close();
  }
});

test("the guarded migration adds creationKey to a table missing that column", async (t) => {
  const store = await storeFixture(t);
  store.db.exec(`
    CREATE TABLE durable_tasks (
      id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, goal TEXT NOT NULL,
      state TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      lastError TEXT
    );
    INSERT INTO durable_tasks VALUES ('old','1','Keep this goal','done',1,1,NULL);
  `);
  const tasks = new DurableTasks(store);
  assert.equal(tasks.get("1", "old")?.creationKey, null);
  assert.equal(tasks.get("1", "old")?.goal, "Keep this goal");
  assert.equal(tasks.get("1", "old")?.state, "done");
  assert.equal(tasks.get("1", "old")?.runConversationId, null);
  assert.equal(tasks.get("1", "old")?.attempts, 0);
  assert.equal(tasks.get("1", "old")?.maxAttempts, 3);
  assert.equal(tasks.get("1", "old")?.nextRun, null);
  assert.equal(tasks.get("1", "old")?.deadlineAt, null);
  assert.equal(tasks.get("1", "old")?.budgetTurns, 0);
  assert.equal(new DurableTasks(store).get("1", "old")?.creationKey, null);
});

async function executionFixture(
  t: TestContext,
  responses: FauxResponseStep[],
  config = "",
) {
  const dir = await temp(t);
  const CONFIG_FILE = join(dir, "config.yaml");
  await writeFile(CONFIG_FILE, `memory: { enabled: false }\n${config}\n`);
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses(responses);
  models.setProvider(faux.provider);
  let now = epoch;
  const options = {
    dir,
    gateway,
    models,
    env: { CONFIG_FILE },
    now: () => now,
  };
  const app = await Runtime.open(options);
  return {
    app,
    faux,
    options,
    setTime: (time: number) => {
      now = time;
    },
  };
}

async function waitFor(assertion: () => void) {
  for (let index = 0; index < 200; index++) {
    try {
      assertion();
      return;
    } catch (error) {
      if (index === 199) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function heldResponse() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const response: FauxResponseStep = async (_transcript, options) => {
    const signal = options?.signal;
    signal?.addEventListener("abort", release, { once: true });
    try {
      if (!signal?.aborted) await held;
      return fauxAssistantMessage("Finished");
    } finally {
      signal?.removeEventListener("abort", release);
    }
  };
  return { response, release };
}

const failure = fauxAssistantMessage("", {
  stopReason: "error",
  errorMessage: "Invalid request\nsecond line",
});

test("the scheduler claims one due durable task, skips credentials, and admits replay only once", async (t) => {
  const held = heldResponse();
  const { app, faux, setTime } = await executionFixture(t, [held.response]);
  const otherScheduler = new Tasks(app);
  try {
    const origin = await app.create();
    const future = app.durableTasks.create(origin, "Future goal");
    app.store.run(
      "UPDATE durable_tasks SET nextRun=? WHERE id=?",
      epoch + 1,
      future.id,
    );
    const first = app.durableTasks.create(origin, "First goal");
    const second = app.durableTasks.create(origin, "Second goal");
    const get = () => app.durableTasks.get(origin, first.id)!;
    app.store.credentialMutation = true;
    await app.tasks.tick();
    assert.equal(get().state, "queued");
    app.store.credentialMutation = false;

    await Promise.all([app.tasks.tick(), otherScheduler.tick()]);
    await app.tasks.tick();
    assert.equal(get().state, "running");
    assert.equal(get().attempts, 1);
    assert.equal(get().deadlineAt, epoch + 900_000);
    assert.equal(app.durableTasks.get(origin, second.id)?.attempts, 0);
    assert.equal(app.durableTasks.get(origin, future.id)?.attempts, 0);

    const run = get().runConversationId;
    assert.ok(run);
    assert.notEqual(run, origin);
    const requestId = `durable-task:${first.id}:1`;
    const requests = () => app.store.all<RequestRow>("SELECT * FROM requests");
    assert.deepEqual(
      requests().map(({ conversationId, requestId, source }) => [
        conversationId,
        requestId,
        source,
      ]),
      [[run, requestId, "task"]],
    );
    const originalSubmission = requests()[0]?.submissionId;
    assert.ok(originalSubmission);
    const replay = await app.submit(run, requestId, first.goal, "task");
    assert.equal(replay.submissionId, originalSubmission);
    await waitFor(() => assert.equal(faux.state.callCount, 1));
    setTime(epoch + 500);
    held.release();
    await waitFor(() => assert.equal(get().state, "done"));
    assert.equal(get().nextRun, null);
    assert.equal(get().lastError, null);
    assert.equal(get().updatedAt, epoch + 500);
    assert.equal(faux.state.callCount, 1);
    assert.equal(requests().length, 1);
  } finally {
    held.release();
    await otherScheduler.close();
    await app.close();
  }
});

test("retry waits for nextRun, reuses its execution conversation, and stops at maxAttempts", async (t) => {
  const { app, setTime } = await executionFixture(t, [failure, failure]);
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Retry this goal");
    const get = () => app.durableTasks.get(origin, task.id)!;
    app.store.run("UPDATE durable_tasks SET maxAttempts=2 WHERE id=?", task.id);
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().nextRun, epoch + 60_000));
    assert.equal(get().state, "queued");
    assert.equal(get().attempts, 1);
    assert.match(get().lastError ?? "", /Invalid request second line/);
    const run = get().runConversationId;
    assert.ok(run);
    assert.notEqual(run, origin);
    setTime(epoch + 59_999);
    await app.tasks.tick();
    assert.equal(get().attempts, 1);
    setTime(epoch + 60_000);
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().state, "interrupted"));
    assert.equal(get().attempts, 2);
    assert.equal(get().nextRun, null);
    assert.match(get().lastError ?? "", /Invalid request second line/);
    assert.equal(get().runConversationId, run);
    assert.deepEqual(
      app.store
        .all<RequestRow>("SELECT * FROM requests ORDER BY rowid")
        .map(({ conversationId, requestId }) => [conversationId, requestId]),
      [
        [run, `durable-task:${task.id}:1`],
        [run, `durable-task:${task.id}:2`],
      ],
    );
    assert.equal(app.store.all("SELECT * FROM conversations").length, 2);
  } finally {
    await app.close();
  }
});

test("wall clock expiry interrupts a live attempt and does not retry it", async (t) => {
  const held = heldResponse();
  const { app, faux } = await executionFixture(
    t,
    [held.response],
    "durable_tasks: { wall_clock_ms: 200 }",
  );
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Wait for the deadline");
    const get = () => app.durableTasks.get(origin, task.id)!;
    await app.tasks.tick();
    await waitFor(() => assert.equal(faux.state.callCount, 1));
    assert.equal(get().deadlineAt, epoch + 200);
    await waitFor(() => assert.equal(get().lastError, "budget_timeout"));
    assert.equal(get().state, "interrupted");
    assert.equal(get().nextRun, null);
    await app.tasks.tick();
    assert.equal(get().attempts, 1);
  } finally {
    held.release();
    await app.close();
  }
});

test("per-task turn budget overrides the startup default and stops further model calls", async (t) => {
  const toolCall = (id: string) =>
    fauxAssistantMessage(
      [fauxToolCall("durable_task", { action: "list" }, { id })],
      {
        stopReason: "toolUse",
      },
    );
  const { app, faux } = await executionFixture(
    t,
    [toolCall("allowed"), fauxAssistantMessage("Finished"), toolCall("budget")],
    "durable_tasks: { max_turns: 2 }",
  );
  try {
    const origin = await app.create();
    const defaultTask = app.durableTasks.create(
      origin,
      "Use the default limit",
    );
    const limited = app.durableTasks.create(origin, "Use the per-task limit");
    const get = () => app.durableTasks.get(origin, limited.id)!;
    app.store.run(
      "UPDATE durable_tasks SET budgetTurns=1 WHERE id=?",
      limited.id,
    );
    await app.tasks.tick();
    await waitFor(() =>
      assert.equal(app.durableTasks.get(origin, defaultTask.id)?.state, "done"),
    );
    assert.equal(faux.state.callCount, 2);
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().lastError, "budget_turns"));
    assert.equal(get().state, "interrupted");
    assert.equal(get().nextRun, null);
    assert.equal(get().attempts, 1);
    assert.equal(faux.state.callCount, 3);
  } finally {
    await app.close();
  }
});

test("late success cannot overwrite a terminal durable task", async (t) => {
  const held = heldResponse();
  const { app, faux } = await executionFixture(t, [held.response]);
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Wait before settling");
    await app.tasks.tick();
    await waitFor(() => assert.equal(faux.state.callCount, 1));
    const terminal = app.durableTasks.transition(
      origin,
      task.id,
      "interrupted",
      "manual stop",
    );
    held.release();
    await waitFor(() =>
      assert.equal(
        app.store.get<RequestRow>("SELECT * FROM requests WHERE source='task'")
          ?.status,
        "done",
      ),
    );
    await app.tasks.tick();
    assert.deepEqual(app.durableTasks.get(origin, task.id), terminal);
  } finally {
    held.release();
    await app.close();
  }
});

test("durable task config defaults absent fields and logs invalid overrides", async (t) => {
  const dir = await temp(t);
  const defaults = { maxTurns: 12, wallClockMs: 900_000 };
  const path = join(dir, "config.yaml");
  await writeFile(path, "{}");
  assert.deepEqual(
    loadHarnessConfig({ CONFIG_FILE: path }).durableTasks,
    defaults,
  );
  const invalid = join(dir, "invalid.yaml");
  await writeFile(
    invalid,
    "durable_tasks: { max_turns: 51, wall_clock_ms: 1.5 }",
  );
  const log = t.mock.method(console, "error", () => {});
  assert.deepEqual(
    loadHarnessConfig({ CONFIG_FILE: invalid }).durableTasks,
    defaults,
  );
  assert.deepEqual(
    log.mock.calls.map(({ arguments: args }) => args[0]),
    [
      "Pi-Agent: durable_tasks.max_turns is invalid. Using the default.",
      "Pi-Agent: durable_tasks.wall_clock_ms is invalid. Using the default.",
    ],
  );
});

test("boot interrupts a running durable task and does not replay or pick it again", async (t) => {
  const held = heldResponse();
  const run = await executionFixture(t, [held.response]);
  let app = run.app;
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Do not resume this goal");
    await app.tasks.tick();
    await waitFor(() => assert.equal(run.faux.state.callCount, 1));
    assert.equal(app.durableTasks.get(origin, task.id)?.state, "running");
    await app.close();
    const db = new Store(run.options.dir);
    try {
      assert.equal(new DurableTasks(db).get(origin, task.id)?.state, "running");
    } finally {
      db.close();
    }
    run.faux.appendResponses([fauxAssistantMessage("Unexpected replay")]);
    app = await Runtime.open(run.options);
    const interrupted = app.durableTasks.get(origin, task.id)!;
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.lastError, "restart");
    assert.equal(interrupted.attempts, 1);
    await app.tasks.tick();
    assert.ok(interrupted.runConversationId);
    await (
      await app.conversation(interrupted.runConversationId)
    ).waitForIdle(context);
    assert.equal(run.faux.state.callCount, 1);
    assert.deepEqual(app.durableTasks.get(origin, task.id), interrupted);
  } finally {
    held.release();
    await app.close();
  }
});

test("the registered durable_task tool scopes, bounds and deduplicates calls", async (t) => {
  const dir = await temp(t);
  let now = epoch;
  const options = { dir, gateway, env: {}, now: () => now };
  let app = await Runtime.open(options);
  try {
    const id = await app.create();
    const foreign = await app.create();
    const registry = (app as unknown as { registry: Registry }).registry;
    const tool = registry
      .snapshot()
      .tools()
      .find(({ tool }) => tool.name === "durable_task")?.tool;
    assert.ok(tool, "durable_task must be registered");
    assert.equal(tool.replay, "safe");
    assert.match(tool.description, /stored but no work starts/);
    async function call(
      conversationId: string,
      taskId: number,
      args: Record<string, string>,
      callId = `call-${taskId}`,
    ) {
      assert.ok(tool);
      // The registered execution wrapper and this tool only need the invocation identity.
      const api = {
        conversationId: Number(conversationId),
        taskId,
        callId,
      } as ToolExecutionApi;
      const result = await tool.execute(args, api, context);
      assert.ok("output" in result);
      const item = result.output?.[0];
      assert.ok(item?.type === "text");
      return item.text;
    }
    const create = { action: "create", goal: "First goal" };
    const created = await call(id, 1, create);
    const first = JSON.parse(created);
    assert.deepEqual(first, { id: first.id, state: "queued" });
    assert.match(first.id, /^[a-f0-9-]{36}$/);
    assert.equal(await call(id, 1, create), created);
    const own = JSON.parse(await call(id, 2, { action: "show", id: first.id }));
    assert.equal(own.goal, "First goal");
    assert.equal(
      await call(foreign, 3, { action: "show", id: first.id }),
      "Durable task not found",
    );
    assert.equal(await call(foreign, 4, { action: "list" }), "[]");
    assert.match(await call(id, 5, { action: "create" }), /goal/i);
    assert.match(await call(id, 6, { action: "show" }), /id/i);
    assert.equal(
      app.store.all("SELECT id FROM durable_tasks WHERE conversationId=?", id)
        .length,
      1,
    );

    await t.test(
      "two different goals in one turn create distinct tasks",
      async () => {
        const createSecond = { action: "create", goal: "Second goal" };
        const secondResult = await call(id, 1, createSecond, "call-1-second");
        const second = JSON.parse(secondResult);
        assert.deepEqual(second, { id: second.id, state: "queued" });
        assert.match(second.id, /^[a-f0-9-]{36}$/);
        assert.notEqual(second.id, first.id);
        assert.equal(app.durableTasks.get(id, second.id)?.goal, "Second goal");
        assert.equal(
          await call(id, 1, createSecond, "call-1-second"),
          secondResult,
        );
      },
    );

    const expectedIds: string[] = [];
    for (let index = 0; index < 21; index++) {
      now += 1000;
      const row = JSON.parse(
        await call(id, 10 + index, {
          action: "create",
          goal: `Goal ${index} ${"x".repeat(130)}`,
        }),
      );
      expectedIds.unshift(row.id);
    }
    const listed = JSON.parse(await call(id, 40, { action: "list" })) as {
      id: string;
      goal: string;
      age: string;
      state: string;
    }[];
    assert.deepEqual(
      listed.map((row) => row.id),
      expectedIds.slice(0, 20),
    );
    assert.deepEqual(listed[0], {
      id: expectedIds[0],
      goal: `Goal 20 ${"x".repeat(112)}`,
      age: "0s",
      state: "queued",
    });
    assert.equal(listed.at(-1)?.age, "19s");

    const archived = await app.create();
    app.durableTasks.create(archived, "Archived goal");
    await app.deleteConversation(archived);
    app.durableTasks.create(foreign, "Another conversation's goal");

    await app.close();
    app = await Runtime.open(options);
    assert.equal(
      app.store.get<{ state: string }>(
        "SELECT state FROM durable_tasks WHERE id=?",
        first.id,
      )?.state,
      "interrupted",
    );
    const noticeRequests = () =>
      app.store.all<RequestRow>(
        "SELECT * FROM requests WHERE source='system' ORDER BY conversationId",
      );
    const requests = noticeRequests();
    assert.deepEqual(
      requests.map((row) => row.conversationId).sort(),
      [id, foreign].sort(),
    );
    assert.ok(
      requests.every((row) =>
        /^durable-task-restart:[a-f0-9]{64}$/.test(row.requestId),
      ),
    );
    assert.equal(
      requests.find((row) => row.conversationId === id)?.text,
      "23 durable tasks were interrupted by a restart and remain interrupted.",
    );
    assert.equal(
      requests.find((row) => row.conversationId === foreign)?.text,
      "1 durable task was interrupted by a restart and remains interrupted.",
    );
    for (const request of requests) assert.equal(request.status, "done");

    await app.close();
    app = await Runtime.open(options);
    assert.deepEqual(noticeRequests(), requests);
  } finally {
    await app.close();
  }
});

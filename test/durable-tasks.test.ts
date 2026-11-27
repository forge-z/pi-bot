import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Registry, ToolExecutionApi } from "@earendil-works/pi-durable";
import { DurableTaskError, DurableTasks } from "../src/durable-tasks.js";
import { Runtime } from "../src/runtime.js";
import { Store, type RequestRow } from "../src/store.js";

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
  assert.equal(new DurableTasks(store).get("1", "old")?.creationKey, null);
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

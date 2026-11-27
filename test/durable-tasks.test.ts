import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
import { bindChannelChat } from "../src/channel.js";
import { assertAppPurgeSafe } from "../src/conversation-trash.js";
import {
  DurableTaskError,
  DurableTasks,
  type DurableTask,
} from "../src/durable-tasks.js";
import { loadHarnessConfig } from "../src/harness-config.js";
import { Runtime } from "../src/runtime.js";
import { Store, type Delivery, type RequestRow } from "../src/store.js";
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
      artifactPath: null,
      artifactSha256: null,
      artifactBytes: null,
      artifactVersion: 0,
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
  assertNoArtifact(tasks.get("1", "old")!);
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

function artifactDir(dir: string, taskId: string) {
  return join(dir, "artifacts", "durable", taskId);
}

function assertNoArtifact(task: DurableTask) {
  assert.equal(task.artifactPath, null);
  assert.equal(task.artifactSha256, null);
  assert.equal(task.artifactBytes, null);
  assert.equal(task.artifactVersion, 0);
}

function bindOrigin(app: Runtime, origin: string) {
  bindChannelChat(app.store, "whatsapp", "42", origin);
}

function assertTerminalNotice(app: Runtime, task: DurableTask, chat: string) {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        task.id,
        task.state === "done" ? task.artifactVersion : task.state,
      ]),
    )
    .digest("hex");
  const request = app.store.get<RequestRow>(
    "SELECT * FROM requests WHERE conversationId=? AND requestId=?",
    task.conversationId,
    `durable-task-terminal:${key}`,
  );
  assert.ok(request, "terminal notice must have a request ledger row");
  assert.equal(request.status, "done");
  assert.equal(request.source, "system");
  assert.equal(request.submissionId, null);
  const delivery = app.store.get<Delivery>(
    "SELECT * FROM deliveries WHERE id=?",
    `${request.requestId}:0`,
  );
  assert.ok(delivery, "terminal notice must be queued");
  assert.equal(delivery.channel, "whatsapp");
  assert.equal(delivery.chat, chat);
  assert.equal(delivery.text, request.text);
  assert.ok(request.text.includes(task.id));
  assert.ok(request.text.includes(task.goal.slice(0, 80)));
  assert.ok(request.text.includes(task.state));
  return { request, delivery };
}

type SettlementAccess = {
  settlement?: Promise<void>;
  settle(task: DurableTask, outcome: { kind: "done"; text: string }): void;
};

function settlementAccess(tasks: DurableTasks) {
  return tasks as unknown as SettlementAccess;
}

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
    const requests = () =>
      app.store.all<RequestRow>("SELECT * FROM requests WHERE source='task'");
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
  const { app, options, setTime } = await executionFixture(t, [
    failure,
    failure,
  ]);
  try {
    const origin = await app.create();
    bindOrigin(app, origin);
    const task = app.durableTasks.create(origin, "Retry this goal");
    const get = () => app.durableTasks.get(origin, task.id)!;
    app.store.run("UPDATE durable_tasks SET maxAttempts=2 WHERE id=?", task.id);
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().nextRun, epoch + 60_000));
    assert.equal(get().state, "queued");
    assert.equal(get().attempts, 1);
    assert.match(get().lastError ?? "", /Invalid request second line/);
    assert.equal(
      app.store.all("SELECT * FROM requests WHERE source='system'").length,
      0,
    );
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
    assertNoArtifact(get());
    await assert.rejects(readdir(artifactDir(options.dir, task.id)), {
      code: "ENOENT",
    });
    assert.deepEqual(
      app.store
        .all<RequestRow>(
          "SELECT * FROM requests WHERE source='task' ORDER BY rowid",
        )
        .map(({ conversationId, requestId }) => [conversationId, requestId]),
      [
        [run, `durable-task:${task.id}:1`],
        [run, `durable-task:${task.id}:2`],
      ],
    );
    assertTerminalNotice(app, get(), "42");
    assert.equal(app.store.all("SELECT * FROM conversations").length, 2);
  } finally {
    await app.close();
  }
});

test("wall clock expiry interrupts a live attempt and does not retry it", async (t) => {
  const held = heldResponse();
  const { app, faux, options } = await executionFixture(
    t,
    [held.response],
    "durable_tasks: { wall_clock_ms: 200 }",
  );
  try {
    const origin = await app.create();
    bindOrigin(app, origin);
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
    assertNoArtifact(get());
    await assert.rejects(readdir(artifactDir(options.dir, task.id)), {
      code: "ENOENT",
    });
    assertTerminalNotice(app, get(), "42");
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
  const { app, faux, options } = await executionFixture(
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
    assertNoArtifact(get());
    await assert.rejects(readdir(artifactDir(options.dir, limited.id)), {
      code: "ENOENT",
    });
  } finally {
    await app.close();
  }
});

test("late success cannot overwrite a terminal durable task", async (t) => {
  const held = heldResponse();
  const { app, faux, options } = await executionFixture(t, [held.response]);
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Wait before settling");
    await app.tasks.tick();
    const settlement = settlementAccess(app.durableTasks).settlement;
    assert.ok(settlement);
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
    await settlement;
    assert.deepEqual(app.durableTasks.get(origin, task.id), terminal);
    assertNoArtifact(terminal);
    await assert.rejects(readdir(artifactDir(options.dir, task.id)), {
      code: "ENOENT",
    });
    assert.deepEqual(
      app.store.all("SELECT * FROM requests WHERE source='system'"),
      [],
    );
  } finally {
    held.release();
    await app.close();
  }
});

test("success writes a private artifact with the settled answer and records its metadata", async (t) => {
  const answer = "The durable result.\n\nHere are the details.";
  const { app, options } = await executionFixture(t, [
    fauxAssistantMessage(answer),
  ]);
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Write a durable result");
    await app.tasks.tick();
    const get = () => app.durableTasks.get(origin, task.id)!;
    await waitFor(() => assert.equal(get().state, "done"));
    const path = join(artifactDir(options.dir, task.id), "1.md");
    const row = get();
    assert.equal(row.artifactPath, path);
    const data = await readFile(path);
    assert.equal(
      data.toString("utf8"),
      [
        `Task: ${task.id}`,
        "State: done",
        "Attempt: 1",
        `Finished: ${new Date(epoch).toISOString()}`,
        `Goal: ${task.goal}`,
        "",
        "---",
        "",
        answer,
        "",
      ].join("\n"),
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(artifactDir(options.dir, task.id))).mode & 0o777,
      0o700,
    );
    assert.deepEqual(await readdir(artifactDir(options.dir, task.id)), [
      "1.md",
    ]);
    assert.equal(
      row.artifactSha256,
      createHash("sha256").update(data).digest("hex"),
    );
    assert.equal(row.artifactBytes, data.byteLength);
    assert.equal(row.artifactVersion, 1);
  } finally {
    await app.close();
  }
});

test("the artifact body fits within 512 KiB and gives the original UTF-8 length when truncated", async (t) => {
  const answer = "🌱".repeat(140_000);
  const { app, options } = await executionFixture(t, [
    fauxAssistantMessage(answer),
  ]);
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Write a long result");
    await app.tasks.tick();
    await waitFor(() =>
      assert.equal(app.durableTasks.get(origin, task.id)?.state, "done"),
    );
    const artifact = await readFile(
      join(artifactDir(options.dir, task.id), "1.md"),
      "utf8",
    );
    const body = artifact.split("\n\n---\n\n")[1]!;
    assert.ok(Buffer.byteLength(body) <= 512 * 1024);
    assert.ok(body.length > 250_000);
    assert.doesNotMatch(body, /\uFFFD/);
    assert.match(body, /\n\[.*truncated.*560000 bytes.*\]\n$/i);
  } finally {
    await app.close();
  }
});

test("an artifact rename failure leaves no partial file or recorded metadata", async (t) => {
  const { app, options } = await executionFixture(t, [
    fauxAssistantMessage("Finished"),
  ]);
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(
      origin,
      "Block the artifact destination",
    );
    const dir = artifactDir(options.dir, task.id);
    const blockedPath = join(dir, "1.md");
    await mkdir(blockedPath, { recursive: true });
    app.store.run("UPDATE durable_tasks SET maxAttempts=1 WHERE id=?", task.id);
    await app.tasks.tick();
    const get = () => app.durableTasks.get(origin, task.id)!;
    await waitFor(() => assert.equal(get().state, "interrupted"));
    assertNoArtifact(get());
    assert.deepEqual(await readdir(dir), ["1.md"]);
    assert.ok((await stat(blockedPath)).isDirectory());
  } finally {
    await app.close();
  }
});

test("a later successful attempt advances the version and preserves the first file", async (t) => {
  const { app, options } = await executionFixture(t, [
    fauxAssistantMessage("First result"),
    fauxAssistantMessage("Second result"),
  ]);
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Run again");
    const dir = artifactDir(options.dir, task.id);
    const firstPath = join(dir, "1.md");
    const get = () => app.durableTasks.get(origin, task.id)!;
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().state, "done"));
    assert.equal(get().artifactVersion, 1);
    const firstContent = await readFile(firstPath, "utf8");
    const firstStat = await stat(firstPath);

    // Simulate a later retry at the database boundary. This slice has no requeue tool.
    app.store.run(
      "UPDATE durable_tasks SET state='queued' WHERE id=?",
      task.id,
    );
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().state, "done"));
    assert.equal(get().attempts, 2);
    assert.equal(get().artifactVersion, 2);
    assert.equal(get().artifactPath, join(dir, "2.md"));
    assert.match(await readFile(join(dir, "2.md"), "utf8"), /Second result/);
    assert.deepEqual((await readdir(dir)).sort(), ["1.md", "2.md"]);
    assert.match(firstContent, /First result/);
    assert.equal(await readFile(firstPath, "utf8"), firstContent);
    const currentStat = await stat(firstPath);
    assert.equal(currentStat.ino, firstStat.ino);
    assert.equal(currentStat.mtimeMs, firstStat.mtimeMs);
  } finally {
    await app.close();
  }
});

test("a terminal notice reaches the origin once without a model turn and is ignored on reboot and purge", async (t) => {
  const answer = "Private answer text that belongs in the file";
  const {
    app: first,
    options,
    faux,
  } = await executionFixture(t, [fauxAssistantMessage(answer)]);
  let app = first;
  try {
    const origin = await app.create();
    bindOrigin(app, origin);
    const goal = `${"a".repeat(80)}beyond the excerpt`;
    const task = app.durableTasks.create(origin, goal);
    const get = () => app.durableTasks.get(origin, task.id)!;
    const enqueue = t.mock.method(Store.prototype, "queueTelegram");
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().state, "done"));
    const row = get();
    const { request, delivery } = assertTerminalNotice(app, row, "42");
    assert.ok(request.text.includes(row.artifactPath!));
    assert.match(request.text, /\b\d+ B\b/);
    assert.ok(!request.text.includes("beyond the excerpt"));
    assert.ok(!request.text.includes(answer));
    assert.doesNotThrow(() => assertAppPurgeSafe(app.store, origin));
    assert.equal(faux.state.callCount, 1);
    const file = await stat(row.artifactPath!);
    const payload = await readFile(row.artifactPath!);

    settlementAccess(app.durableTasks).settle(row, {
      kind: "done",
      text: "Duplicate result",
    });
    assert.deepEqual(get(), row);
    assert.deepEqual(await readFile(row.artifactPath!), payload);
    assert.equal((await stat(row.artifactPath!)).ino, file.ino);

    await app.close();
    app = await Runtime.open(options);
    await app.tasks.tick();
    assert.deepEqual(
      app.store.all<RequestRow>(
        "SELECT * FROM requests WHERE conversationId=?",
        origin,
      ),
      [request],
    );
    assert.deepEqual(app.store.all<Delivery>("SELECT * FROM deliveries"), [
      delivery,
    ]);
    assert.equal(enqueue.mock.callCount(), 1);
    assert.equal(faux.state.callCount, 1);
  } finally {
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
    function registeredTool() {
      const registry = (app as unknown as { registry: Registry }).registry;
      return registry
        .snapshot()
        .tools()
        .find(({ tool }) => tool.name === "durable_task")?.tool;
    }
    const tool = registeredTool();
    assert.ok(tool, "durable_task must be registered");
    assert.equal(tool.replay, "safe");
    assert.match(tool.description, /stored but no work starts/);
    async function call(
      conversationId: string,
      taskId: number,
      args: Record<string, string>,
      callId = `call-${taskId}`,
    ) {
      const tool = registeredTool();
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
    assert.ok(!Object.hasOwn(own, "artifactPath"));
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

    const artifact = {
      artifactPath: join(artifactDir(dir, expectedIds[0]!), "1.md"),
      artifactSha256: "a".repeat(64),
      artifactBytes: 123,
      artifactVersion: 1,
    };
    app.store.run(
      "UPDATE durable_tasks SET state='done', artifactPath=?, artifactSha256=?, artifactBytes=?, artifactVersion=? WHERE id=?",
      artifact.artifactPath,
      artifact.artifactSha256,
      artifact.artifactBytes,
      artifact.artifactVersion,
      expectedIds[0]!,
    );
    const shown = JSON.parse(
      await call(id, 41, { action: "show", id: expectedIds[0]! }),
    );
    for (const [key, value] of Object.entries(artifact))
      assert.equal(shown[key], value);
    const withArtifact = JSON.parse(await call(id, 42, { action: "list" }))[0];
    assert.equal(withArtifact.id, expectedIds[0]);
    assert.equal(withArtifact.hasArtifact, true);
    assert.ok(!Object.hasOwn(withArtifact, "artifactPath"));
    assert.equal(
      await call(foreign, 43, { action: "show", id: expectedIds[0]! }),
      "Durable task not found",
    );
  } finally {
    await app.close();
  }
});

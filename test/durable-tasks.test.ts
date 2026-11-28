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
import { basename, join } from "node:path";
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

function registeredTool(app: Runtime) {
  const registry = (app as unknown as { registry: Registry }).registry;
  return registry
    .snapshot()
    .tools()
    .find(({ tool }) => tool.name === "durable_task")?.tool;
}

async function callDurableTask(
  app: Runtime,
  conversationId: string,
  taskId: number,
  args: Record<string, string | number>,
  callId = `call-${taskId}`,
) {
  const tool = registeredTool(app);
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
  return { text: item.text, isError: result.isError === true };
}

/** Full id of the task a create result names by its 8-character short id. */
function createdId(app: Runtime, conversationId: string, text: string) {
  const short = /^Task ([a-f0-9]{8}) created, /.exec(text)?.[1];
  assert.ok(short, text);
  const rows = app.store.all<{ id: string }>(
    "SELECT id FROM durable_tasks WHERE conversationId=? AND substr(id,1,8)=?",
    conversationId,
    short,
  );
  assert.equal(rows.length, 1);
  return rows[0]!.id;
}

/** The artifact path as a notice prints it: relative to the artifacts root. */
function noticePath(task: DurableTask) {
  return `artifacts/durable/${task.id}/${basename(task.artifactPath!)}`;
}

function assertTerminalNotice(app: Runtime, task: DurableTask, chat: string) {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        task.id,
        task.state === "ready_for_review" ? task.artifactVersion : task.state,
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
  if (task.state === "ready_for_review") {
    assert.match(request.text, /ready for review/);
    assert.match(
      request.text,
      new RegExp(`\\bversion ${task.artifactVersion}\\b`),
    );
    assert.match(
      request.text,
      new RegExp(
        `\\baccept\\b.*\\bartifactVersion: ${task.artifactVersion}\\b`,
      ),
    );
    assert.ok(request.text.includes(noticePath(task)));
    assert.ok(!request.text.includes(task.artifactPath!));
    assert.ok(request.text.includes(`(${task.artifactBytes} B)`));
  } else {
    assert.ok(request.text.includes(task.state));
  }
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
    await waitFor(() => assert.equal(get().state, "ready_for_review"));
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
      assert.equal(
        app.durableTasks.get(origin, defaultTask.id)?.state,
        "ready_for_review",
      ),
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
    await waitFor(() => assert.equal(get().state, "ready_for_review"));
    const path = join(artifactDir(options.dir, task.id), "1.md");
    const row = get();
    assert.equal(row.artifactPath, path);
    assert.equal(row.lastError, null);
    assert.equal(row.nextRun, null);
    assert.equal(row.deadlineAt, null);
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
      assert.equal(
        app.durableTasks.get(origin, task.id)?.state,
        "ready_for_review",
      ),
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

test("rejection followed by a successful rerun preserves the first file and adds only the version 2 notice", async (t) => {
  const { app, options, setTime } = await executionFixture(t, [
    fauxAssistantMessage("First result"),
    fauxAssistantMessage("Second result"),
  ]);
  try {
    const origin = await app.create();
    bindOrigin(app, origin);
    const task = app.durableTasks.create(origin, "Run again");
    const dir = artifactDir(options.dir, task.id);
    const firstPath = join(dir, "1.md");
    const get = () => app.durableTasks.get(origin, task.id)!;
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().state, "ready_for_review"));
    assert.equal(get().artifactVersion, 1);
    const firstNotice = assertTerminalNotice(app, get(), "42").request;
    const firstContent = await readFile(firstPath, "utf8");
    const firstStat = await stat(firstPath);

    const rejected = await callDurableTask(app, origin, 1, {
      action: "reject",
      id: task.id,
      reason: "Expand the answer",
    });
    assert.equal(rejected.isError, false, rejected.text);
    setTime(epoch + 59_999);
    await app.tasks.tick();
    assert.equal(get().attempts, 1);
    setTime(epoch + 60_000);
    await app.tasks.tick();
    await waitFor(() => assert.equal(get().state, "ready_for_review"));
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
    const secondNotice = assertTerminalNotice(app, get(), "42").request;
    assert.notEqual(secondNotice.requestId, firstNotice.requestId);
    assert.deepEqual(
      app.store.all<RequestRow>(
        "SELECT * FROM requests WHERE conversationId=? ORDER BY rowid",
        origin,
      ),
      [firstNotice, secondNotice],
    );
  } finally {
    await app.close();
  }
});

async function reviewFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-durable-tasks-"));
  let now = epoch;
  const app = await Runtime.open({ dir, gateway, env: {}, now: () => now });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = await app.create();
  const { id } = app.durableTasks.create(origin, "Review the result");
  app.store.run(
    `UPDATE durable_tasks SET state='ready_for_review', attempts=3,
       artifactPath='result.md', artifactSha256=?, artifactBytes=123,
       artifactVersion=2 WHERE id=?`,
    "a".repeat(64),
    id,
  );
  return {
    app,
    origin,
    id,
    get: () => app.durableTasks.get(origin, id)!,
    setTime: (time: number) => {
      now = time;
    },
  };
}

test("accept requires the current artifact version and cannot accept it twice", async (t) => {
  const { app, origin, id, get, setTime } = await reviewFixture(t);
  const review = get();
  const accept = { action: "accept", id, artifactVersion: 2 };

  const missing = await callDurableTask(app, origin, 1, {
    action: "accept",
    id,
  });
  assert.equal(missing.isError, true, missing.text);
  assert.match(missing.text, /artifactVersion/i);
  const stale = await callDurableTask(app, origin, 2, {
    ...accept,
    artifactVersion: 1,
  });
  assert.equal(stale.isError, true, stale.text);
  assert.match(stale.text, /current.*version.*\b2\b/i);
  assert.deepEqual(get(), review);

  setTime(epoch + 1_000);
  const accepted = await callDurableTask(app, origin, 3, accept);
  assert.equal(accepted.isError, false, accepted.text);
  assert.deepEqual(
    { ...get() },
    {
      ...review,
      state: "done",
      lastError: null,
      updatedAt: epoch + 1_000,
    },
  );

  const done = get();
  setTime(epoch + 2_000);
  const repeated = await callDurableTask(app, origin, 4, accept);
  assert.equal(repeated.isError, true, repeated.text);
  assert.match(repeated.text, /\bdone\b/);
  assert.deepEqual(get(), done);
});

test("accept refuses queued and running tasks and reports their state", async (t) => {
  const { app, origin } = await reviewFixture(t);
  const queued = app.durableTasks.create(origin, "Queued goal");
  const other = app.durableTasks.create(origin, "Running goal");
  const running = app.durableTasks.transition(origin, other.id, "running");
  for (const row of [queued, running]) {
    const refused = await callDurableTask(app, origin, 1, {
      action: "accept",
      id: row.id,
      artifactVersion: 0,
    });
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, new RegExp(`\\b${row.state}\\b`));
    assert.deepEqual(app.durableTasks.get(origin, row.id), row);
  }
});

test("reject requires a bounded reason and queues the same task for a minute later", async (t) => {
  const { app, origin, id, get, setTime } = await reviewFixture(t);
  const review = get();
  const reject = { action: "reject", id };
  for (const args of [
    reject,
    { ...reject, reason: "  " },
    { ...reject, reason: "x".repeat(201) },
  ]) {
    const invalid = await callDurableTask(app, origin, 1, args);
    assert.equal(invalid.isError, true, invalid.text);
    assert.match(invalid.text, /reason/i);
    assert.deepEqual(get(), review);
  }

  setTime(epoch + 1_000);
  const reason = "x".repeat(200);
  const rejected = await callDurableTask(app, origin, 2, { ...reject, reason });
  assert.equal(rejected.isError, false, rejected.text);
  const queued = get();
  assert.deepEqual(
    { ...queued },
    {
      ...review,
      state: "queued",
      nextRun: epoch + 61_000,
      lastError: `rejected: ${reason}`,
      updatedAt: epoch + 1_000,
    },
  );

  const refused = await callDurableTask(app, origin, 3, { ...reject, reason });
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /\bqueued\b/);
  assert.deepEqual(get(), queued);
});

test("accept and reject cannot see or change tasks in another conversation", async (t) => {
  const { app, id, get } = await reviewFixture(t);
  const foreign = await app.create();
  const review = get();
  const actions: Record<string, string | number>[] = [
    { action: "accept", id, artifactVersion: 2 },
    { action: "reject", id, reason: "Foreign change" },
  ];
  for (const [index, args] of actions.entries()) {
    const refused = await callDurableTask(app, foreign, index + 1, args);
    assert.equal(refused.isError, true, refused.text);
    assert.equal(refused.text, "Durable task not found");
    assert.deepEqual(get(), review);
  }
});

test("a review notice reaches the origin once and the task stays ready for review across ticks and restart", async (t) => {
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
    await waitFor(() => assert.equal(get().state, "ready_for_review"));
    const row = get();
    const { request, delivery } = assertTerminalNotice(app, row, "42");
    assert.ok(request.text.includes(` · ${noticePath(row)} (`));
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
    await app.tasks.tick();
    assert.deepEqual(get(), row);

    await app.close();
    app = await Runtime.open(options);
    assert.deepEqual(get(), row);
    await app.tasks.tick();
    assert.deepEqual(get(), row);
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
    const tool = registeredTool(app);
    assert.ok(tool, "durable_task must be registered");
    assert.equal(tool.replay, "safe");
    assert.match(tool.description, /stored but no work starts/);
    async function call(
      conversationId: string,
      taskId: number,
      args: Record<string, string>,
      callId = `call-${taskId}`,
    ) {
      return (await callDurableTask(app, conversationId, taskId, args, callId))
        .text;
    }
    const create = { action: "create", goal: "First goal" };
    const created = await call(id, 1, create);
    const first = { id: createdId(app, id, created) };
    assert.match(first.id, /^[a-f0-9-]{36}$/);
    assert.equal(await call(id, 1, create), created);
    const own = await call(id, 2, { action: "show", id: first.id });
    assert.match(own, /^Goal: First goal$/m);
    assert.doesNotMatch(own, /^Artifact/m);
    assert.equal(
      await call(foreign, 3, { action: "show", id: first.id }),
      "Durable task not found",
    );
    assert.equal(
      await call(foreign, 4, { action: "list" }),
      "No durable tasks in this conversation.",
    );
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
        const second = { id: createdId(app, id, secondResult) };
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
      const text = await call(id, 10 + index, {
        action: "create",
        goal: `Goal ${index} ${"x".repeat(130)}`,
      });
      expectedIds.unshift(createdId(app, id, text));
    }
    const [header, ...listed] = (await call(id, 40, { action: "list" })).split(
      "\n",
    );
    assert.equal(header, "20 tasks in this conversation:");
    assert.deepEqual(
      listed.map((line) => line.slice(0, 8)),
      expectedIds.slice(0, 20).map((taskId) => taskId.slice(0, 8)),
    );
    assert.equal(
      listed[0],
      `${expectedIds[0]!.slice(0, 8)} queued, 0s old, Goal 20 ${"x".repeat(52)}…`,
    );
    assert.match(listed.at(-1)!, /^[a-f0-9]{8} queued, 19s old, /);

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
    const shown = await call(id, 41, { action: "show", id: expectedIds[0]! });
    assert.match(
      shown,
      new RegExp(
        `^Artifact version 1, 123 B, artifacts/durable/${expectedIds[0]}/1\\.md$`,
        "m",
      ),
    );
    assert.ok(!shown.includes(artifact.artifactSha256));
    assert.ok(!shown.includes(dir));
    const withArtifact = (await call(id, 42, { action: "list" })).split(
      "\n",
    )[1];
    assert.match(
      withArtifact!,
      new RegExp(`^${expectedIds[0]!.slice(0, 8)} done, `),
    );
    assert.ok(!withArtifact!.includes("artifacts/"));
    assert.equal(
      await call(foreign, 43, { action: "show", id: expectedIds[0]! }),
      "Durable task not found",
    );
  } finally {
    await app.close();
  }
});

type SubmitCall = Parameters<Runtime["submit"]>;
type Draft = Parameters<
  Awaited<ReturnType<Runtime["conversation"]>>["submit"]
>[0];

/** Records every input draft the runtime hands to a conversation from now on. */
function recordInputs(app: Runtime) {
  const inputs: { conversationId: string; draft: Draft }[] = [];
  const wrapped = new WeakSet<object>();
  const open = app.conversation.bind(app);
  app.conversation = (async (id: string) => {
    const conversation = await open(id);
    if (!wrapped.has(conversation)) {
      wrapped.add(conversation);
      const submit = conversation.submit.bind(conversation);
      conversation.submit = (draft, ctx) => {
        if (draft.type === "input") inputs.push({ conversationId: id, draft });
        return submit(draft, ctx);
      };
    }
    return conversation;
  }) as Runtime["conversation"];
  return inputs;
}

async function steerFixture(t: TestContext) {
  const held = heldResponse();
  const transcripts: string[] = [];
  const steered: FauxResponseStep = (transcript) => {
    transcripts.push(JSON.stringify(transcript.messages));
    return fauxAssistantMessage("Steered result");
  };
  const fixture = await executionFixture(t, [held.response, steered]);
  const { app, faux } = fixture;
  t.after(async () => {
    held.release();
    await app.close();
  });
  const origin = await app.create();
  const task = app.durableTasks.create(origin, "Steerable goal");
  await app.tasks.tick();
  const get = () => app.durableTasks.get(origin, task.id)!;
  assert.equal(get().state, "running");
  await waitFor(() => assert.equal(faux.state.callCount, 1));
  const run = get().runConversationId!;
  assert.ok(run);
  assert.notEqual(run, origin);
  // Observe every submission issued after the claim, through the runtime the task uses.
  const calls: SubmitCall[] = [];
  const submit = app.submit.bind(app);
  app.submit = ((...args: SubmitCall) => {
    calls.push(args);
    return submit(...args);
  }) as Runtime["submit"];
  const inputs = recordInputs(app);
  const requests = (conversationId: string) =>
    app.store.all<RequestRow>(
      "SELECT * FROM requests WHERE conversationId=? ORDER BY rowid",
      conversationId,
    );
  return {
    ...fixture,
    held,
    transcripts,
    origin,
    task: get(),
    get,
    run,
    calls,
    inputs,
    requests,
  };
}

test("steer submits once into the running task's own conversation and never into the origin", async (t) => {
  const {
    app,
    faux,
    held,
    transcripts,
    origin,
    task,
    get,
    run,
    calls,
    inputs,
    requests,
  } = await steerFixture(t);
  const originBefore = requests(origin);
  const runBefore = requests(run);
  const message = "  Focus on the second section first.  ";
  const result = await callDurableTask(app, origin, 7, {
    action: "steer",
    id: task.id,
    message,
  });
  assert.equal(result.isError, false, result.text);
  assert.equal(
    result.text,
    `Message delivered to task ${task.id.slice(0, 8)}.`,
  );

  assert.equal(calls.length, 1);
  const [conversationId, requestId, text, source, chat, , , steer] = calls[0]!;
  assert.equal(conversationId, run);
  assert.equal(steer, true);
  assert.equal(text, message.trim());
  assert.equal(source, "task-steer");
  assert.equal(chat, null);
  assert.equal(
    requestId,
    `durable-task-steer:${createHash("sha256")
      .update(JSON.stringify([task.id, task.attempts, message.trim()]))
      .digest("hex")}`,
  );
  assert.notEqual(requestId, `durable-task:${task.id}:${task.attempts}`);
  // An explicit steer may only join a live run: an idle conversation must refuse it.
  assert.deepEqual(
    inputs.map(({ conversationId, draft }) => [
      conversationId,
      draft.type === "input" && draft.whenBusy,
      draft.type === "input" && draft.whenIdle,
    ]),
    [[run, "steer", "reject"]],
  );
  const added = requests(run).slice(runBefore.length);
  assert.deepEqual(
    added.map((row) => [row.requestId, row.source, row.text]),
    [[requestId, "task-steer", message.trim()]],
  );
  assert.ok(added[0]?.submissionId);
  // The epic property: the origin conversation gets no turn and no message.
  assert.ok(calls.every(([id]) => id !== origin));
  assert.deepEqual(requests(origin), originBefore);
  assert.deepEqual(originBefore, []);
  assert.deepEqual(app.store.all("SELECT * FROM deliveries"), []);
  assert.equal(faux.state.callCount, 1);
  // The execution request stays the scheduled turn of the run conversation.
  assert.equal(app.scheduledTurn(run), true);

  held.release();
  await waitFor(() => assert.equal(get().state, "ready_for_review"));
  assert.equal(faux.state.callCount, 2);
  assert.ok(transcripts[0]?.includes(message.trim()));
  assert.deepEqual(
    requests(origin).map((row) => row.source),
    ["system"],
    "only the terminal notice reaches the origin",
  );
});

test("steer is refused outside running and names the current state", async (t) => {
  const { app, origin, task, get, calls, requests } = await steerFixture(t);
  const running = get();
  for (const state of [
    "queued",
    "ready_for_review",
    "done",
    "interrupted",
    "cancelled",
  ]) {
    const other = app.durableTasks.create(origin, `Goal in ${state}`);
    app.store.run(
      "UPDATE durable_tasks SET state=? WHERE id=?",
      state,
      other.id,
    );
    const row = app.durableTasks.get(origin, other.id)!;
    const refused = await callDurableTask(app, origin, 8, {
      action: "steer",
      id: row.id,
      message: "Change course",
    });
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, new RegExp(`\\b${state}\\b`));
    assert.match(refused.text, /\brunning\b/);
    assert.deepEqual(app.durableTasks.get(origin, row.id), row);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(requests(origin), []);
  assert.deepEqual(get(), running);
  assert.equal(task.id, running.id);
});

test("steer cannot see a running task from another conversation", async (t) => {
  const { app, task, get, run, calls, requests } = await steerFixture(t);
  const foreign = await app.create();
  const before = get();
  const runBefore = requests(run);
  const refused = await callDurableTask(app, foreign, 9, {
    action: "steer",
    id: task.id,
    message: "Foreign steer",
  });
  assert.equal(refused.isError, true, refused.text);
  assert.equal(refused.text, "Durable task not found");
  assert.deepEqual(calls, []);
  assert.deepEqual(requests(foreign), []);
  assert.deepEqual(requests(run), runBefore);
  assert.deepEqual(get(), before);
});

test("a replayed steer deduplicates and two messages in one attempt both submit", async (t) => {
  const { app, origin, task, run, calls, requests } = await steerFixture(t);
  const runBefore = requests(run).length;
  const steer = { action: "steer", id: task.id, message: "First note" };
  const first = await callDurableTask(app, origin, 10, steer);
  const replay = await callDurableTask(app, origin, 10, {
    ...steer,
    message: " First note\n",
  });
  assert.equal(first.isError, false, first.text);
  assert.equal(replay.isError, false, replay.text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]![1], calls[1]![1]);
  assert.equal(requests(run).length, runBefore + 1);
  const second = await callDurableTask(app, origin, 11, {
    ...steer,
    message: "Second note",
  });
  assert.equal(second.isError, false, second.text);
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2]![1], calls[0]![1]);
  const steers = requests(run).filter((row) => row.source === "task-steer");
  assert.deepEqual(
    steers.map((row) => row.text),
    ["First note", "Second note"],
  );
  assert.equal(new Set(steers.map((row) => row.submissionId)).size, 2);
  assert.deepEqual(requests(origin), []);
});

test("steer leaves the task row unchanged", async (t) => {
  const { app, origin, task, get, run, calls, setTime } = await steerFixture(t);
  app.store.run(
    "UPDATE durable_tasks SET nextRun=?, lastError=? WHERE id=?",
    epoch + 5,
    "earlier error",
    task.id,
  );
  const before = get();
  const conversations = app.store.all("SELECT id FROM conversations");
  setTime(epoch + 1_000);
  const result = await callDurableTask(app, origin, 12, {
    action: "steer",
    id: task.id,
    message: "Keep going",
  });
  assert.equal(result.isError, false, result.text);
  assert.equal(
    result.text,
    `Message delivered to task ${task.id.slice(0, 8)}.`,
  );
  assert.deepEqual(
    calls.map(([conversationId, , text]) => [conversationId, text]),
    [[run, "Keep going"]],
  );
  const after = get();
  assert.deepEqual(after, before);
  assert.equal(after.state, "running");
  assert.equal(after.attempts, 1);
  assert.equal(after.deadlineAt, epoch + 900_000);
  assert.equal(after.nextRun, epoch + 5);
  assert.equal(after.lastError, "earlier error");
  assert.equal(after.updatedAt, before.updatedAt);
  assertNoArtifact(after);
  assert.deepEqual(
    app.store.all("SELECT id FROM conversations"),
    conversations,
  );
});

test("steer validates the message before submitting", async (t) => {
  const { app, origin, task, get, run, calls, requests } =
    await steerFixture(t);
  const before = get();
  const runBefore = requests(run);
  const steer = { action: "steer", id: task.id };
  for (const args of [
    steer,
    { ...steer, message: "" },
    { ...steer, message: " \n\t" },
    { ...steer, message: "x".repeat(4001) },
  ]) {
    const refused = await callDurableTask(app, origin, 13, args);
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, /message/i);
  }
  const missingId = await callDurableTask(app, origin, 14, {
    action: "steer",
    message: "No id",
  });
  assert.equal(missingId.isError, true, missingId.text);
  assert.match(missingId.text, /id/i);
  assert.deepEqual(calls, []);
  assert.deepEqual(requests(run), runBefore);
  assert.deepEqual(get(), before);

  const bounded = await callDurableTask(app, origin, 15, {
    ...steer,
    message: "x".repeat(4000),
  });
  assert.equal(bounded.isError, false, bounded.text);
  assert.equal(calls.length, 1);
});

test("T7: steer into a run that has already answered is refused as not running and starts no run", async (t) => {
  const { app, faux, held, origin, task, get, run, calls, inputs, requests } =
    await steerFixture(t);
  held.release();
  await waitFor(() => assert.equal(get().state, "ready_for_review"));
  await (await app.conversation(run)).waitForIdle(context);
  // The race window: the run answered, but the row has not left running yet.
  app.store.run("UPDATE durable_tasks SET state='running' WHERE id=?", task.id);
  const before = get();
  const callCount = faux.state.callCount;
  const runBefore = requests(run);
  const originBefore = requests(origin);
  const entriesBefore = (await app.snapshot(run)).view.entries.length;

  const refused = await callDurableTask(app, origin, 16, {
    action: "steer",
    id: task.id,
    message: "Too late",
  });
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /\brunning\b/);
  assert.match(refused.text, /finished/);
  assert.match(refused.text, /not delivered/);
  assert.deepEqual(
    inputs.map(({ conversationId, draft }) => [
      conversationId,
      draft.type === "input" && draft.whenIdle,
    ]),
    [[run, "reject"]],
  );
  assert.equal(calls.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.isTurnBusy(run), false);
  assert.equal(faux.state.callCount, callCount);
  assert.equal((await app.snapshot(run)).view.entries.length, entriesBefore);
  const { submissions } = await app.harness.inspect(context);
  assert.deepEqual(
    submissions.filter(({ conversationId }) => String(conversationId) === run),
    [],
  );
  assert.deepEqual(get(), before);
  // The refused steer is settled, so boot cannot replay it into a new run.
  assert.deepEqual(
    requests(run)
      .slice(runBefore.length)
      .map((row) => [row.source, row.text, row.status, row.submissionId]),
    [["task-steer", "Too late", "unanswered", null]],
  );
  assert.deepEqual(requests(origin), originBefore);
});

test("T8: boot withdraws pending task-steer requests and never places them", async (t) => {
  const held = heldResponse();
  const run = await executionFixture(t, [held.response]);
  let app: Runtime | undefined = run.app;
  const steerRows = (store: Store, conversationId: string) =>
    store
      .all<{ text: string; status: string }>(
        "SELECT text,status FROM requests WHERE conversationId=? AND source='task-steer' ORDER BY rowid",
        conversationId,
      )
      .map((row) => [row.text, row.status]);
  try {
    const origin = await app.create();
    const task = app.durableTasks.create(origin, "Steer then restart");
    await app.tasks.tick();
    await waitFor(() => assert.equal(run.faux.state.callCount, 1));
    const runId = app.durableTasks.get(origin, task.id)!.runConversationId!;
    assert.ok(runId);
    const steered = await callDurableTask(app, origin, 17, {
      action: "steer",
      id: task.id,
      message: "Admitted steer",
    });
    assert.equal(steered.isError, false, steered.text);
    assert.ok(
      !JSON.stringify((await app.snapshot(runId)).view.entries).includes(
        "Admitted steer",
      ),
      "the steer is still queued behind the held model call",
    );
    await app.close();
    app = undefined;
    const db = new Store(run.options.dir);
    try {
      // A crash between the requests insert and the harness admission leaves a row with no submission.
      db.run(
        "INSERT INTO requests(conversationId,requestId,text,source,chat) VALUES (?,?,?,'task-steer',NULL)",
        runId,
        `durable-task-steer:${"0".repeat(64)}`,
        "Orphan steer",
      );
      assert.deepEqual(steerRows(db, runId), [
        ["Admitted steer", "pending"],
        ["Orphan steer", "pending"],
      ]);
    } finally {
      db.close();
    }
    run.faux.appendResponses([
      fauxAssistantMessage("Unexpected steer run"),
      fauxAssistantMessage("Unexpected steer run"),
    ]);

    app = await Runtime.open(run.options);
    assert.equal(app.durableTasks.get(origin, task.id)?.state, "interrupted");
    assert.deepEqual(steerRows(app.store, runId), [
      ["Admitted steer", "unanswered"],
      ["Orphan steer", "unanswered"],
    ]);
    // The execution submission is the existing boot path's (stopped through abortTask).
    const { submissions } = await app.harness.inspect(context);
    assert.deepEqual(
      submissions.filter(
        ({ conversationId, requestId }) =>
          String(conversationId) === runId &&
          requestId?.startsWith("durable-task-steer:"),
      ),
      [],
    );
    await app.tasks.tick();
    await (await app.conversation(runId)).waitForIdle(context);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(run.faux.state.callCount, 1);
    const entries = JSON.stringify((await app.snapshot(runId)).view.entries);
    assert.ok(!entries.includes("Admitted steer"));
    assert.ok(!entries.includes("Orphan steer"));
    assert.equal(app.durableTasks.get(origin, task.id)?.state, "interrupted");
  } finally {
    held.release();
    await app?.close();
  }
});

test("T9: a chat message in an idle conversation still starts its own run, with no whenIdle", async (t) => {
  const { app, faux } = await executionFixture(t, [
    fauxAssistantMessage("Web answer"),
    fauxAssistantMessage("WhatsApp answer"),
  ]);
  t.after(() => app.close());
  const inputs = recordInputs(app);
  const web = await app.create();
  await app.submit(web, "chat-web-1", "Hello from the web");
  await waitFor(() => assert.equal(faux.state.callCount, 1));
  await (await app.conversation(web)).waitForIdle(context);
  // A channel message reaches submit with an explicit steer=true from admit.
  const chat = await app.create();
  bindOrigin(app, chat);
  await app.admit(chat, "chat-whatsapp-1", "Hello from WhatsApp", {
    source: "whatsapp",
    user: "42",
    chat: "42",
  });
  await waitFor(() => assert.equal(faux.state.callCount, 2));
  await (await app.conversation(chat)).waitForIdle(context);
  assert.deepEqual(
    inputs.map(({ conversationId, draft }) => [
      conversationId,
      draft.type === "input" && draft.whenBusy,
      "whenIdle" in draft,
    ]),
    [
      [web, "steer", false],
      [chat, "steer", false],
    ],
  );
  for (const [id, answer] of [
    [web, "Web answer"],
    [chat, "WhatsApp answer"],
  ] as const)
    assert.ok(
      JSON.stringify((await app.snapshot(id)).view.entries).includes(answer),
    );
});

async function formatFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-durable-tasks-"));
  let now = epoch;
  // env: {} pins the assistant zone to America/Sao_Paulo: epoch is 15/01 05:00 there.
  const app = await Runtime.open({ dir, gateway, env: {}, now: () => now });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = await app.create();
  return {
    app,
    dir,
    origin,
    call: async (taskId: number, args: Record<string, string | number>) => {
      const result = await callDurableTask(app, origin, taskId, args);
      assert.equal(result.isError, false, result.text);
      return result.text;
    },
    setTime: (time: number) => {
      now = time;
    },
  };
}

/** Puts a task into ready_for_review with an artifact under the runtime directory. */
function markReadyForReview(app: Runtime, dir: string, id: string, at: number) {
  app.store.run(
    `UPDATE durable_tasks SET state='ready_for_review', updatedAt=?, artifactPath=?,
       artifactSha256=?, artifactBytes=833, artifactVersion=1 WHERE id=?`,
    at,
    join(artifactDir(dir, id), "1.md"),
    "b".repeat(64),
    id,
  );
}

test("durable_task create returns one line naming the short id and state", async (t) => {
  const { app, origin, call } = await formatFixture(t);
  const text = await call(1, { action: "create", goal: "Write the report" });
  const [task] = app.durableTasks.list(origin);
  assert.equal(
    text,
    `Task ${task!.id.slice(0, 8)} created, queued. The scheduler runs it in its own conversation; use show to follow it.`,
  );
});

test("durable_task list with two tasks returns a header and one line per task, newest first", async (t) => {
  const { app, origin, call, setTime } = await formatFixture(t);
  const older = app.durableTasks.create(origin, "Short goal");
  setTime(epoch + 48_000);
  const goal = `Liste de 1 a 200 e uma frase para cada número, ${"y".repeat(40)}`;
  const newer = app.durableTasks.create(origin, goal);
  app.durableTasks.transition(origin, newer.id, "running");
  setTime(epoch + 60_000);
  assert.equal(
    await call(1, { action: "list" }),
    [
      "2 tasks in this conversation:",
      `${newer.id.slice(0, 8)} running, 12s old, ${[...goal].slice(0, 60).join("")}…`,
      `${older.id.slice(0, 8)} queued, 1m old, Short goal`,
    ].join("\n"),
  );
});

test("durable_task list without tasks returns a single line", async (t) => {
  const { call } = await formatFixture(t);
  assert.equal(
    await call(1, { action: "list" }),
    "No durable tasks in this conversation.",
  );
});

test("durable_task show with an artifact returns a small block with the relative path", async (t) => {
  const { app, dir, origin, call } = await formatFixture(t);
  const goal =
    "Liste de 1 a 200, um número por linha, com uma frase curta explicando cada um.";
  const task = app.durableTasks.create(origin, goal);
  markReadyForReview(app, dir, task.id, epoch + 61_000);
  assert.equal(
    await call(1, { action: "show", id: task.id }),
    [
      `Task ${task.id.slice(0, 8)}, ready for review`,
      `Goal: ${goal}`,
      "Created 15/01 05:00, updated 15/01 05:01",
      `Artifact version 1, 833 B, artifacts/durable/${task.id}/1.md`,
      "To close it: accept with artifactVersion 1.",
    ].join("\n"),
  );
});

test("durable_task show without an artifact omits the artifact line", async (t) => {
  const { app, origin, call } = await formatFixture(t);
  const task = app.durableTasks.create(origin, "Plain goal");
  assert.equal(
    await call(1, { action: "show", id: task.id }),
    [
      `Task ${task.id.slice(0, 8)}, queued`,
      "Goal: Plain goal",
      "Created 15/01 05:00, updated 15/01 05:00",
    ].join("\n"),
  );
});

test("durable_task accept returns one line", async (t) => {
  const { app, dir, origin, call } = await formatFixture(t);
  const task = app.durableTasks.create(origin, "Accept me");
  markReadyForReview(app, dir, task.id, epoch);
  assert.equal(
    await call(1, { action: "accept", id: task.id, artifactVersion: 1 }),
    `Task ${task.id.slice(0, 8)} done.`,
  );
});

test("durable_task reject returns one line", async (t) => {
  const { app, dir, origin, call } = await formatFixture(t);
  const task = app.durableTasks.create(origin, "Reject me");
  markReadyForReview(app, dir, task.id, epoch);
  assert.equal(
    await call(1, { action: "reject", id: task.id, reason: "Too short" }),
    `Task ${task.id.slice(0, 8)} back in the queue; it runs again in about a minute and the reason is recorded.`,
  );
});

test("durable_task steer returns one line", async (t) => {
  const { app, origin, task } = await steerFixture(t);
  const result = await callDurableTask(app, origin, 7, {
    action: "steer",
    id: task.id,
    message: "Shorter, please",
  });
  assert.equal(result.isError, false, result.text);
  assert.equal(
    result.text,
    `Message delivered to task ${task.id.slice(0, 8)}.`,
  );
});

test("no durable_task result line carries braces or the artifact hash", async (t) => {
  const { app, options, origin, task } = await steerFixture(t);
  const call = async (
    taskId: number,
    args: Record<string, string | number>,
  ) => {
    const result = await callDurableTask(app, origin, taskId, args);
    assert.equal(result.isError, false, result.text);
    return result.text;
  };
  const created = await call(1, { action: "create", goal: "Another goal" });
  const id = createdId(app, origin, created);
  const reviewed = app.durableTasks.create(origin, "Review goal");
  markReadyForReview(app, options.dir, reviewed.id, epoch);
  const outputs = [
    created,
    await call(2, { action: "list" }),
    await call(3, { action: "show", id }),
    await call(4, { action: "show", id: reviewed.id }),
    await call(5, { action: "steer", id: task.id, message: "Keep going" }),
    await call(6, { action: "reject", id: reviewed.id, reason: "Again" }),
  ];
  markReadyForReview(app, options.dir, reviewed.id, epoch);
  outputs.push(
    await call(7, { action: "accept", id: reviewed.id, artifactVersion: 1 }),
  );
  for (const line of outputs.flatMap((text) => text.split("\n"))) {
    assert.ok(!line.includes("{"), line);
    assert.ok(!line.includes("artifactSha256"), line);
    assert.ok(!line.includes("b".repeat(64)), line);
  }
});

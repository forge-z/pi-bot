import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  AssistantMessage,
  Context,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Store } from "../src/store.js";

const NOW = Date.parse("2026-11-26T03:00:00Z");
const FACT = "- Prefers tea";
const ORIGINAL = `${FACT}\n${FACT}\n`;
const DUPLICATE = {
  text: FACT,
  kind: "duplicate",
  reason: "The same fact appears twice.",
};

function pendingResponse() {
  let resolve!: (response: AssistantMessage) => void;
  const promise = new Promise<AssistantMessage>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function plan(
  replacement: string,
  removed: ToolCall["arguments"]["removed"] = [],
) {
  return fauxAssistantMessage(
    [fauxToolCall("consolidate_memory", { replacement, removed })],
    { stopReason: "toolUse" },
  );
}

async function fixture(t: TestContext, original = ORIGINAL) {
  // Load inside each test so the base-tree RED run reports all test names.
  const { runMemoryConsolidation } =
    await import("../src/memory-consolidate.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-consolidate-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const memory = join(dir, "memory", "MEMORY.md");
  const backups = join(dir, "memory", "backups");
  await mkdir(join(dir, "memory"));
  await writeFile(memory, original);
  const note = (file: string, content: string) =>
    writeFile(join(dir, "memory", file), content);
  const run = (
    model:
      | AssistantMessage
      | ((context: Context, signal: AbortSignal) => Promise<AssistantMessage>),
    overrides: { store?: Store; now?: () => number } = {},
  ) =>
    runMemoryConsolidation({
      dir,
      store,
      now: () => NOW,
      complete: typeof model === "function" ? model : async () => model,
      ...overrides,
    });
  async function unchanged() {
    assert.equal(await readFile(memory, "utf8"), original);
    assert.deepEqual(await readdir(join(dir, "memory")), ["MEMORY.md"]);
  }
  return { dir, memory, backups, note, run, unchanged };
}

test("writes nothing when the model throws or reports an error", async (t) => {
  const f = await fixture(t);
  const thrown = await f.run(async () => {
    throw new Error("fake model failure");
  });
  assert.equal(thrown.status, "noop");
  assert.equal(thrown.reason, "model_error");
  const reported = await f.run({
    ...plan(`${FACT}\n`, [DUPLICATE]),
    stopReason: "error",
  });
  assert.equal(reported.reason, "model_error");
  await f.unchanged();
});

test("times out after 120 seconds and discards a late model result", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = pendingResponse();
  let signal!: AbortSignal;
  const running = f.run(async (_, requestSignal) => {
    signal = requestSignal;
    return response.promise;
  });
  t.mock.timers.tick(119_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await running).reason, "timeout");
  assert.equal(signal.aborted, true);
  response.resolve(plan(`${FACT}\n`, [DUPLICATE]));
  await f.unchanged();
});

test("writes nothing when the backup cannot be created", async (t) => {
  const f = await fixture(t);
  await writeFile(f.backups, "a file blocks the backups directory");
  const result = await f.run(plan(`${FACT}\n`, [DUPLICATE]));
  assert.equal(result.status, "noop");
  assert.equal(result.reason, "backup_failed");
  assert.equal(result.backupPath, null);
  assert.equal(await readFile(f.memory, "utf8"), ORIGINAL);
  assert.equal(
    await readFile(f.backups, "utf8"),
    "a file blocks the backups directory",
  );
});

test("rejects a replacement over 8000 UTF-8 bytes", async (t) => {
  const f = await fixture(t, `${FACT}\n`);
  const result = await f.run(plan(`${FACT}\n- ${"é".repeat(4000)}\n`));
  assert.equal(result.status, "noop");
  assert.equal(result.reason, "over_cap");
  await f.unchanged();
});

test("merges an exact duplicate and reports the applied diff and model usage", async (t) => {
  const f = await fixture(t);
  const proposed = plan(`${FACT}\n`, [DUPLICATE]);
  const result = await f.run(proposed);
  assert.equal(result.status, "applied");
  assert.equal(result.bytesBefore, 28);
  assert.equal(result.bytesAfter, 14);
  assert.equal(result.removed, 1);
  assert.equal(result.added, 0);
  assert.deepEqual(result.usage, proposed.usage);
  assert.equal(await readFile(f.memory, "utf8"), `${FACT}\n`);
});

test("replaces a superseded fact with the newer fact from a daily note", async (t) => {
  const f = await fixture(t, `${FACT}\n`);
  const newer = "- Now prefers coffee instead of tea";
  const file = "2026-11-25.md";
  await f.note(file, `${newer}\n`);
  const result = await f.run(
    plan(`${newer}\n`, [
      {
        text: FACT,
        kind: "superseded",
        reason: "The newer preference explicitly replaces the older one.",
        replacement: newer,
        evidence: { file, text: newer },
      },
    ]),
  );
  assert.equal(result.status, "applied");
  assert.equal(result.removed, 1);
  assert.equal(result.added, 1);
  assert.equal(await readFile(f.memory, "utf8"), `${newer}\n`);
  assert.equal(
    await readFile(join(f.dir, "memory", file), "utf8"),
    `${newer}\n`,
  );
});

test("removes a contradicted fact when a supplied daily note is cited", async (t) => {
  const f = await fixture(t, `# Memory\n${FACT}\n`);
  const file = "2026-11-25.md";
  const correction = "- The earlier note about enjoying tea was a mistake.";
  await f.note(file, `${correction}\n`);
  const result = await f.run(
    plan("# Memory\n", [
      {
        text: FACT,
        kind: "contradicted",
        reason: "The user retracted the earlier claim.",
        evidence: { file, text: correction },
      },
    ]),
  );
  assert.equal(result.status, "applied");
  assert.equal(result.removed, 1);
  assert.equal(result.added, 0);
  assert.equal(await readFile(f.memory, "utf8"), "# Memory\n");
});

test("rejects a removed line with a missing or blank reason", async (t) => {
  const f = await fixture(t);
  for (const removal of [
    { text: FACT, kind: "duplicate" },
    { ...DUPLICATE, reason: " " },
  ]) {
    const result = await f.run(plan(`${FACT}\n`, [removal]));
    assert.equal(result.reason, "invalid_plan");
  }
  await f.unchanged();
});

test("refuses unlisted deletions, false duplicates and unsupported removal types", async (t) => {
  const f = await fixture(t, `${FACT}\n- Prefers coffee\n`);
  for (const removed of [
    [],
    [DUPLICATE],
    [{ ...DUPLICATE, kind: "outdated" }],
    [
      {
        ...DUPLICATE,
        kind: "contradicted",
        evidence: {
          file: "2026-11-25.md",
          text: "- Does not like tea",
        },
      },
    ],
    [{ ...DUPLICATE, kind: "superseded", replacement: "- Prefers juice" }],
  ]) {
    const result = await f.run(plan("- Prefers coffee\n", removed));
    assert.equal(result.reason, "invalid_plan");
  }
  await f.unchanged();
});

test("skips a concurrent run from a second SQLite connection before calling its model", async (t) => {
  const f = await fixture(t);
  const other = new Store(f.dir, { initialize: false });
  t.after(() => other.close());
  const response = pendingResponse();
  const first = f.run(async () => response.promise);
  try {
    let calls = 0;
    const second = await f.run(
      async () => {
        calls++;
        return plan(`${FACT}\n`, [DUPLICATE]);
      },
      { store: other },
    );
    assert.equal(second.status, "skipped");
    assert.equal(second.reason, "locked");
    assert.equal(calls, 0);
    await f.unchanged();
  } finally {
    response.resolve(plan(`${FACT}\n`, [DUPLICATE]));
    assert.equal((await first).status, "applied");
  }
});

test("takes over a lease older than 30 minutes without letting the old owner write", async (t) => {
  const f = await fixture(t);
  const response = pendingResponse();
  const first = f.run(async () => response.promise);
  try {
    const second = await f.run(plan(`${FACT}\n`, [DUPLICATE]), {
      now: () => NOW + 30 * 60_000 + 1,
    });
    assert.equal(second.status, "applied");
  } finally {
    response.resolve(plan(`${FACT}\n`, [DUPLICATE]));
    assert.equal((await first).reason, "lost_lock");
  }
});

test("leaves memory untouched when there is nothing to consolidate", async (t) => {
  const f = await fixture(t, `${FACT}\n`);
  for (const response of [fauxAssistantMessage(""), plan(`${FACT}\n`)]) {
    const result = await f.run(response);
    assert.equal(result.status, "noop");
    assert.equal(result.reason, "no_changes");
    assert.equal(result.bytesBefore, result.bytesAfter);
  }
  await f.unchanged();
});

test("writes a timestamped backup byte-identical to the prior memory", async (t) => {
  const original = `# Mémoire\r\n${FACT}\r\n${FACT}\r\n`;
  const f = await fixture(t, original);
  const result = await f.run(plan(`# Mémoire\n${FACT}\n`, [DUPLICATE]));
  assert.equal(result.status, "applied");
  assert.equal(
    result.backupPath,
    join(f.backups, "MEMORY-2026-11-26-030000.md"),
  );
  assert.deepEqual(await readFile(result.backupPath), Buffer.from(original));
});

test("offers exactly one consolidation tool and supplies only the latest seven daily files", async (t) => {
  const f = await fixture(t);
  for (let day = 18; day <= 25; day++)
    await f.note(`2026-11-${day}.md`, `Daily note ${day}\n`);
  await f.note("misc.md", "Not a daily note");
  let calls = 0;
  await f
    .run(async (context) => {
      calls++;
      assert.deepEqual(
        context.tools?.map(({ name }) => name),
        ["consolidate_memory"],
      );
      const wire = JSON.stringify(context.messages);
      assert.ok(wire.includes("Prefers tea"));
      for (let day = 19; day <= 25; day++)
        assert.ok(wire.includes(`Daily note ${day}`));
      assert.ok(!wire.includes("Daily note 18"));
      assert.ok(!wire.includes("Not a daily note"));
      return plan(`${FACT}\n`, [DUPLICATE]);
    })
    .then((result) => assert.equal(result.status, "applied"));
  assert.equal(calls, 1);
});

test("does not overwrite a durable edit made while the model is running", async (t) => {
  const f = await fixture(t);
  const edited = `${ORIGINAL}- Leaves early on Friday\n`;
  const result = await f.run(async () => {
    await writeFile(f.memory, edited);
    return plan(`${FACT}\n`, [DUPLICATE]);
  });
  assert.equal(result.reason, "stale_snapshot");
  assert.equal(await readFile(f.memory, "utf8"), edited);
  assert.deepEqual(await readdir(join(f.dir, "memory")), ["MEMORY.md"]);
});

test("defaults the nightly schedule off and accepts an explicit local-memory opt-in", async (t) => {
  const { loadHarnessConfig } = await import("../src/harness-config.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-consolidation-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.yaml");
  const env = { CONFIG_FILE: config };
  assert.deepEqual(loadHarnessConfig(env).memory, { enabled: true });
  await writeFile(config, "memory:\n  consolidation:\n    enabled: true\n");
  assert.deepEqual(loadHarnessConfig(env).memory, {
    enabled: true,
    consolidation: { enabled: true },
  });
});

test("the existing scheduler admits one nightly run at 03:00 local time across a restart", async (t) => {
  const { Tasks } = await import("../src/tasks.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-consolidation-scheduler-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const unused = async () => {
    throw new Error("No chat turn expected");
  };
  const runtime = {
    store,
    create: unused,
    conversation: unused,
    submit: unused,
  };
  let now = Date.parse("2026-11-26T07:59:59Z");
  let calls = 0;
  const scheduler = () => {
    const tasks = new Tasks(runtime, () => now);
    tasks.scheduleMemoryConsolidation("America/New_York", async () => {
      calls++;
    });
    return tasks;
  };
  const first = scheduler();
  await first.tick();
  assert.equal(calls, 0);
  now += 1000;
  await first.tick();
  await first.close();
  assert.equal(calls, 1);

  const second = scheduler();
  await second.tick();
  assert.equal(calls, 1);
  now += 24 * 60 * 60_000;
  await second.tick();
  await second.close();
  assert.equal(calls, 2);
});

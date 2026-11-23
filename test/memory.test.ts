import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryFiles } from "../src/memory-files.js";
import { Runtime } from "../src/runtime.js";

const IDLE = 30 * 60_000;
const DAY = "2026-11-23.md";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
  const memoryDir = join(dir, "memory");
  const config = join(dir, "config.yaml");
  let now = Date.parse("2026-11-23T12:00:00Z");
  const faux = fauxProvider({ models: [{ id: "base" }, { id: "cheap" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const curated: { wire: string; model: string }[] = [];
  const chat: string[] = [];
  let onCuration: (() => Promise<void>) | undefined;
  faux.setResponses(
    Array.from({ length: 20 }, () => async (transcript, _, _state, model) => {
      const wire = JSON.stringify(transcript);
      if (!wire.includes("You curate Markdown memory")) {
        chat.push(wire);
        return fauxAssistantMessage("acknowledged");
      }
      curated.push({ wire, model: model.id });
      await onCuration?.();
      return fauxAssistantMessage(
        [
          fauxToolCall("edit_memory", {
            durable: [
              "Prefers tea",
              "prefers  tea",
              "Balance: $100",
              "Tool error: failed",
              "Token count: 300",
            ],
            daily: ["Met Alice about the launch", "Rate limit reached"],
          }),
        ],
        { stopReason: "toolUse" },
      );
    }),
  );
  const options = {
    dir,
    models,
    gateway: { catalog: async () => [] },
    now: () => now,
    provider: "faux",
    modelId: "base",
    env: { DATA_DIR: dir, CONFIG_FILE: config },
  };
  let app = await Runtime.open(options);
  const id = await app.create("test memory");
  return {
    dir,
    config,
    memoryDir,
    chat,
    curated,
    id,
    get app() {
      return app;
    },
    advance: (ms: number) => {
      now += ms;
    },
    onCuration: (hook: () => Promise<void>) => {
      onCuration = hook;
    },
    async restart() {
      await app.close();
      app = await Runtime.open(options);
    },
    async send(n: number, text: string, source = "web") {
      const receipt = await app.submit(id, `testing-${n}`, text, source);
      const submission = await app.harness.submission(
        receipt.submissionId,
        context,
      );
      await submission?.wait(context);
      await (await app.conversation(id)).waitForIdle(context);
      while (app.isTurnBusy(id))
        await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("curates once after three new direct inputs and 30 idle minutes, with only its own tool and no operational state", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.send(1, "I prefer tea.\nBalance: $100");
  await f.send(2, "I met Alice about the launch.");
  await f.send(3, "schedule-only input", "task");
  f.advance(IDLE);
  await f.app.memory!.tick();
  assert.equal(f.curated.length, 0);
  await f.send(4, "The launch is my big project.");
  f.advance(IDLE - 1);
  await f.app.memory!.tick();
  assert.equal(f.curated.length, 0);
  f.advance(1);
  await f.app.memory!.tick();
  assert.equal(f.curated.length, 1);
  assert.equal(f.curated[0]?.model, "base");
  assert.match(f.curated[0]!.wire, /I prefer tea|launch is my big project/);
  assert.doesNotMatch(
    f.curated[0]!.wire,
    /Balance: \$100|schedule-only input|mcp_tools|tasks_list/,
  );
  assert.match(f.curated[0]!.wire, /edit_memory/);
  assert.equal(
    await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"),
    "- Prefers tea\n",
  );
  assert.equal(
    await readFile(join(f.memoryDir, DAY), "utf8"),
    "- Met Alice about the launch\n",
  );
  await f.send(5, "scheduled reads memory", "task");
  assert.match(f.chat.at(-1)!, /Saved memory.*Prefers tea/);
  assert.match(f.chat.at(-1)!, /memory_search/);
  f.advance(IDLE);
  await f.app.memory!.tick();
  assert.equal(f.curated.length, 1);
  await f.send(6, "new one");
  await f.send(7, "new two");
  await f.send(8, "new three");
  f.advance(IDLE);
  await f.app.memory!.tick();
  assert.equal(f.curated.length, 2);
  assert.match(f.curated[1]!.wire, /new one.*new two.*new three/);
  assert.doesNotMatch(f.curated[1]!.wire, /I prefer tea|schedule-only input/);
  assert.deepEqual(new MemoryFiles(f.dir).search("Alice launch"), [
    { file: DAY, text: "- Met Alice about the launch" },
  ]);
  assert.deepEqual(new MemoryFiles(f.dir).search("laun"), []);
  assert.equal(
    f.app.memory!.forget("prefers TEA"),
    "Removed 1 matching memory line(s).",
  );
  assert.equal(f.app.memory!.show(), "Memory is empty.");
});

test("resumes a staged multi-file edit on restart without calling the model or duplicating an already applied edit", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await writeFile(
    f.config,
    "memory:\n  curator_model:\n    provider: faux\n    model_id: cheap\n",
  );
  await f.restart();
  const external = join(f.dir, "external.md");
  await writeFile(external, "Keep unchanged.");
  await mkdir(f.memoryDir);
  f.onCuration(() => symlink(external, join(f.memoryDir, DAY)));
  for (let n = 1; n <= 3; n++) await f.send(n, `new detail ${n}`);
  f.advance(IDLE);
  await f.app.memory!.tick();
  assert.equal(f.curated[0]?.model, "cheap");
  assert.equal(
    await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"),
    "- Prefers tea\n",
  );
  assert.equal(await readFile(external, "utf8"), "Keep unchanged.");
  assert.ok(
    f.app.store.get("SELECT 1 FROM memory_curator WHERE plan IS NOT NULL"),
  );
  await unlink(join(f.memoryDir, DAY));
  await f.restart();
  await f.app.memory!.tick();
  assert.equal(f.curated.length, 1);
  assert.equal(
    await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"),
    "- Prefers tea\n",
  );
  assert.equal(
    await readFile(join(f.memoryDir, DAY), "utf8"),
    "- Met Alice about the launch\n",
  );
  assert.equal(f.app.store.get("SELECT 1 FROM memory_curator"), undefined);
});

test("memory can be disabled, and file names cannot escape the memory directory", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await writeFile(f.config, "memory:\n  enabled: false\n");
  await mkdir(f.memoryDir);
  await writeFile(join(f.memoryDir, "MEMORY.md"), "Private remembered text");
  await f.restart();
  assert.equal(f.app.memory, undefined);
  await f.send(1, "test disabled");
  assert.doesNotMatch(f.chat.at(-1)!, /Private remembered text|memory_search/);
  assert.throws(
    () => new MemoryFiles(f.dir).read("../config.yaml"),
    /Invalid memory file name/,
  );
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

function run(dir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/healthcheck.ts"],
    {
      env: { ...process.env, DATA_DIR: dir },
      encoding: "utf8",
    },
  );
}

test("healthcheck exits 0 only for a fresh health.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-health-"));
  try {
    assert.equal(run(dir).status, 1);
    await writeFile(
      join(dir, "health.json"),
      JSON.stringify({ at: Date.now() }),
    );
    assert.equal(run(dir).status, 0);
    await writeFile(
      join(dir, "health.json"),
      JSON.stringify({ at: Date.now() - 120_000 }),
    );
    assert.equal(run(dir).status, 1);
    await writeFile(join(dir, "health.json"), "{");
    assert.equal(run(dir).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("main publishes the waiting health.json by rename with a private mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-health-wait-"));
  const file = join(dir, "health.json");
  // A file left behind with a wider mode: an in-place write would keep 0644.
  const previous = JSON.stringify({ at: 0 });
  await writeFile(file, previous, { mode: 0o644 });
  await chmod(file, 0o644);
  const reader = await open(file, "r");
  // No Telegram token and an empty volume: main waits for setup, no network.
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: resolve("."),
    env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 15_000;
    let health: { at?: unknown; waiting?: unknown } = {};
    while (Date.now() < deadline) {
      try {
        health = JSON.parse(await readFile(file, "utf8"));
        if (health.waiting) break;
      } catch {
        /* Not written yet. */
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(health.waiting, "setup");
    assert.equal(typeof health.at, "number");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(existsSync(`${file}.tmp`), false);
    assert.equal(await reader.readFile("utf8"), previous);
  } finally {
    await reader.close();
    child.kill("SIGKILL");
    await new Promise((done) =>
      child.exitCode === null && child.signalCode === null
        ? child.once("exit", done)
        : done(undefined),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test("healthcheck trims DATA_DIR like main.ts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-health-"));
  try {
    await writeFile(
      join(dir, "health.json"),
      JSON.stringify({ at: Date.now() }),
    );
    // main.ts trims DATA_DIR before writing health.json; a stray space in .env
    // must not turn a healthy bot into a restart loop.
    assert.equal(run(` ${dir} `).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

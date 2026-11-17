import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

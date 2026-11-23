import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { readVolumeWebKeys } from "../src/web-config.js";

const hasPty =
  process.platform === "linux" &&
  spawnSync("script", ["--version"]).status === 0;
const choice = "\r\nChoice: ";
const main = "q - Exit without saving" + choice;
const save = "s - Save and back" + choice;
const exa = "fixture-setup-exa";
const context = "fixture-setup-context";

test(
  "Web search Save and back persists the provider order and keys",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATA_DIR: dir,
      TERM: "dumb",
    };
    const child = spawn(
      "script",
      ["-qefc", "node --import tsx test/setup-cli-child.ts", "/dev/null"],
      { env },
    );
    const steps: [string, string][] = [
      [main, "6"],
      [save, "1"],
      ["0 - None\r\nb - Back" + choice, "4"],
      ["Exa API key (hidden): ", exa],
      [save, "2"],
      ["0 - None\r\nb - Back" + choice, "2"],
      ["Context API key (hidden): ", context],
      [save, "3"],
      ["0 - None\r\nb - Back" + choice, "1"],
      [save, "4"],
      ["0 - None\r\nb - Back" + choice, "2"],
      ["Context API key [saved] (hidden, Enter keeps current): ", ""],
      [save, "s"],
      [main, "q"],
    ];
    let output = "";
    let cursor = 0;
    let step = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
        child.stdin.on("error", reject);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && step === steps.length) resolve();
          else
            reject(
              new Error(
                `Setup stopped at prompt ${step + 1} (exit ${code}):\n${output}`,
              ),
            );
        });
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          const next = steps[step];
          if (!next) return;
          const [prompt, input] = next;
          const start = output.indexOf(prompt, cursor);
          if (start === -1) return;
          cursor = start + prompt.length;
          step++;
          child.stdin.write(`${input}\n`);
        });
      });
      assert.match(
        output,
        /Web settings saved\.[\s\S]*6 - Web search\s+configured/,
      );
      assert.ok(!output.includes(exa));
      assert.ok(!output.includes(context));
      const path = join(dir, "config.yaml");
      const configStat = await stat(path);
      assert.equal(configStat.uid, process.getuid?.());
      assert.equal(configStat.mode & 0o077, 0);
      assert.deepEqual(parse(await readFile(path, "utf8")).web, {
        search: ["exa", "context"],
        extract: ["local", "context"],
      });
      assert.deepEqual(readVolumeWebKeys(dir), { exa, context });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

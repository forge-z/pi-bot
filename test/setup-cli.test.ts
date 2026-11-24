import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parse } from "yaml";
import {
  EXECUTOR_OAUTH_CREDENTIAL,
  readOauthCredential,
} from "../src/mcp-oauth.js";
import {
  readPhoneGateway,
  readStoredAggregators,
  readStoredSetup,
  readStoredTelegram,
  readStoredWhatsapp,
  writeStoredSetup,
} from "../src/setup.js";
import { readVolumeWebKeys } from "../src/web-config.js";

const hasPty =
  process.platform === "linux" &&
  spawnSync("script", ["--version"]).status === 0;
const choice = "\r\nChoice: ";
const main = "q - Exit without saving" + choice;
const save = "s - Save and back" + choice;
const exa = "fixture-setup-exa";
const context = "fixture-setup-context";

type SetupStep = readonly [string, string | ((output: string) => string)];

function runSetup(dir: string, steps: readonly SetupStep[], env = {}) {
  const child = spawn(
    "script",
    ["-qefc", "node --import tsx test/setup-cli-child.ts", "/dev/null"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATA_DIR: dir,
        TERM: "dumb",
        ...env,
      },
    },
  );
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let cursor = 0;
    let step = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.stdin.on("error", reject);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && step === steps.length) resolve(output);
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
      try {
        child.stdin.write(
          `${typeof input === "string" ? input : input(output)}\n`,
        );
      } catch (error) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(error);
      }
    });
  });
}

test(
  "Executor OAuth Save and back reports a rejected volume write and allows retry",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    try {
      db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TRIGGER reject_save BEFORE INSERT ON meta
      BEGIN SELECT RAISE(ABORT, 'test volume write failure'); END;
    `);
      const url = "https://executor.example/mcp?connection=bot";
      const output = await runSetup(
        dir,
        [
          [main, "5"],
          [save, "2"],
          ["Executor authentication: 1 - Token, 2 - OAuth [1]: ", "2"],
          ["Executor MCP URL: ", url],
          [
            "Paste the final browser URL: ",
            (transcript) => {
              const link = transcript.match(
                /https:\/\/executor\.example\/auth\/authorize\?[^\s]+/,
              );
              assert.ok(link);
              const authorize = new URL(link[0]);
              return `${authorize.searchParams.get("redirect_uri")}?code=test-code&state=${authorize.searchParams.get("state")}`;
            },
          ],
          [save, "s"],
          [
            save,
            () => {
              assert.equal(readStoredAggregators(dir).record, undefined);
              assert.equal(
                readOauthCredential(db, EXECUTOR_OAUTH_CREDENTIAL),
                undefined,
              );
              db.exec("DROP TRIGGER reject_save");
              return "s";
            },
          ],
          [main, "q"],
        ],
        { SETUP_TEST_EXECUTOR: "1" },
      );
      assert.match(output, /Could not save MCP settings/);
      assert.match(output, /MCP platform saved on the volume \(executor\)/);
      assert.match(output, /5 - MCP platform\s+configured \(executor\)/);
      assert.deepEqual(readStoredAggregators(dir).record, {
        choice: "executor",
        executor: { url, auth: "oauth" },
      });
      assert.equal(
        readOauthCredential(db, EXECUTOR_OAUTH_CREDENTIAL)?.connectionId,
        "bot",
      );
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Executor Token Save and back returns to setup and reloads the saved endpoint and token",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const url = "https://executor.example/mcp";
    const token = "fixture-executor-token";
    try {
      const output = await runSetup(dir, [
        [main, "5"],
        [save, "2"],
        ["Executor authentication: 1 - Token, 2 - OAuth [1]: ", "1"],
        ["Executor URL: ", url],
        ["Executor token (hidden): ", token],
        [save, "save and back"],
        [main, "q"],
      ]);
      assert.match(output, /5 - MCP platform\s+configured \(executor\)/);
      assert.ok(!output.includes(token));
      assert.deepEqual(readStoredAggregators(dir), {
        record: { choice: "executor", executor: { url } },
        executorToken: token,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Gateway Save and back returns from Telegram and WhatsApp after persisting their settings",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const token = "123456:fixture-telegram";
    try {
      const telegram = await runSetup(dir, [
        [main, "1"],
        [save, "1"],
        [save, "1"],
        ["Bot token (hidden): ", token],
        [save, "2"],
        ["Allowed user ids, comma-separated: ", "42"],
        [save, "s"],
        ["Active: Telegram", "s"],
        [main, "q"],
      ]);
      assert.match(telegram, /1 - Setup gateway\s+configured \(Telegram\)/);
      assert.ok(!telegram.includes(token));
      assert.deepEqual(readStoredTelegram(dir), { token, users: ["42"] });
      assert.equal(readPhoneGateway(dir), "telegram");

      const whatsapp = await runSetup(dir, [
        [main, "1"],
        [save, "2"],
        [save, "1"],
        ["Numbers with country code, comma-separated: ", "15551234567"],
        [save, "s"],
        ["Active: WhatsApp", "s"],
        [main, "q"],
      ]);
      assert.match(whatsapp, /1 - Setup gateway\s+configured \(WhatsApp\)/);
      assert.deepEqual(readStoredWhatsapp(dir), { users: ["15551234567"] });
      assert.equal(readPhoneGateway(dir), "whatsapp");
      assert.deepEqual(readStoredTelegram(dir), { token, users: ["42"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Image and audio Save and back return to setup and reload the changed backends",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const primary = {
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-flash",
      effort: "off",
      chatVision: true,
    };
    const audio = {
      modelId: "whisper-1",
      api: "openai" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    try {
      const db = new DatabaseSync(join(dir, "app.sqlite"));
      try {
        writeStoredSetup(
          db,
          {
            ...primary,
            vision: { modelId: "gpt-4.1-mini", baseUrl: audio.baseUrl },
            audio,
          },
          {
            chat: "fixture-chat-key",
            vision: "fixture-vision-key",
            audio: "fixture-audio-key",
          },
        );
      } finally {
        db.close();
      }
      const output = await runSetup(dir, [
        [main, "3"],
        [save, "-"],
        [save, "s"],
        [
          main,
          () => {
            assert.deepEqual(readStoredSetup(dir).record, {
              ...primary,
              audio,
            });
            return "4";
          },
        ],
        [save, "4"],
        ["Language [auto]: ", "pt"],
        [save, "s"],
        [main, "q"],
      ]);
      assert.match(output, /3 - Image model\s+not set/);
      assert.match(
        output,
        /4 - Audio model\s+configured \(openai\/whisper-1\)/,
      );
      assert.deepEqual(readStoredSetup(dir).record, {
        ...primary,
        audio: { ...audio, language: "pt" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Executor OAuth setup requires an MCP URL rather than using the token environment",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const child = spawn(
      "script",
      ["-qefc", "node --import tsx test/setup-cli-child.ts", "/dev/null"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DATA_DIR: dir,
          TERM: "dumb",
          EXECUTOR_MCP_URL: "https://pat.example/mcp",
        },
      },
    );
    const steps = [
      [main, "5"],
      [save, "2"],
      ["Executor authentication: 1 - Token, 2 - OAuth [1]: ", "2"],
      ["Executor MCP URL: ", ""],
      [save, "s"],
      [save, "b"],
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
      assert.match(output, /Enter a valid HTTPS Executor MCP URL/);
      assert.match(output, /Executor OAuth requires a valid HTTPS MCP URL/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Text model setup saves an optional fallback and its separate key without changing the primary",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    const primary = {
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-flash",
      effort: "off",
      chatVision: false,
    };
    const primaryKey = "fixture-primary-text";
    const fallbackKey = "fixture-fallback-text";
    writeStoredSetup(db, primary, { chat: primaryKey });
    db.close();
    const child = spawn(
      "script",
      ["-qefc", "node --import tsx test/setup-cli-child.ts", "/dev/null"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DATA_DIR: dir,
          TERM: "dumb",
        },
      },
    );
    const steps: [string, string][] = [
      [main, "2"],
      [save, "5"],
      ["b - Back" + choice, "anthropic"],
      ["Model [", "claude-haiku-4-5"],
      ["Fallback API key (hidden): ", fallbackKey],
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
      assert.match(output, /5 - Fallback model: None/);
      assert.match(output, /5 - Fallback model: anthropic\/claude-haiku-4-5/);
      assert.ok(!output.includes(fallbackKey));
      assert.deepEqual(readStoredSetup(dir), {
        record: {
          ...primary,
          fallbackModel: { provider: "anthropic", modelId: "claude-haiku-4-5" },
        },
        apiKey: primaryKey,
      });
      const check = new DatabaseSync(join(dir, "app.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          check
            .prepare("SELECT value FROM credentials WHERE provider=?")
            .get("anthropic")?.value,
          JSON.stringify({ type: "api_key", key: fallbackKey }),
        );
      } finally {
        check.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

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

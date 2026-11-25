import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parse } from "yaml";
import { mcpServersFromAggregators } from "../src/config.js";
import { loadHarnessConfig } from "../src/harness-config.js";
import {
  EXECUTOR_OAUTH_CREDENTIAL,
  readOauthCredential,
  writeOauthCredential,
} from "../src/mcp-oauth.js";
import {
  readPhoneGateway,
  readStoredAggregators,
  readStoredSetup,
  readStoredTelegram,
  readStoredWhatsapp,
  writeStoredAggregators,
  writeStoredSetup,
} from "../src/setup.js";
import { readVolumeWebKeys } from "../src/web-config.js";
import { createWebTools } from "../src/web-tools.js";
import { executorFixtureUrl } from "./memory-executor-fixture.js";

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
  "MCP Save and back exits an untouched menu without recording a platform choice",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    try {
      for (const env of [
        {},
        {
          EXECUTOR_MCP_URL: "https://executor.example/mcp",
          EXECUTOR_TOKEN: "fixture-env-pat",
        },
      ]) {
        await runSetup(
          dir,
          [
            [main, "5"],
            [save, "s"],
            [main, "q"],
          ],
          env,
        );
        assert.equal(readStoredAggregators(dir).record, undefined);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Executor without an OAuth grant exits on untouched save and can switch to its retained token",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    const oauthUrl = "https://executor.example/mcp?connection=bot";
    const tokenUrl = "https://pat.example/mcp";
    const token = "fixture-executor-token";
    try {
      writeStoredAggregators(
        db,
        { choice: "executor", executor: { url: oauthUrl, auth: "oauth" } },
        { executor: token },
      );
      assert.equal(
        readOauthCredential(db, EXECUTOR_OAUTH_CREDENTIAL),
        undefined,
      );
      const output = await runSetup(dir, [
        [main, "5"],
        [save, "s"],
        [
          main,
          () => {
            assert.equal(
              readStoredAggregators(dir).record?.executor?.auth,
              "oauth",
            );
            return "5";
          },
        ],
        [save, "2"],
        ["Executor authentication: 1 - Token, 2 - OAuth [2]: ", "1"],
        ["Executor URL: ", tokenUrl],
        ["Executor token [saved] (hidden, Enter keeps current): ", ""],
        [save, "s"],
        [main, "q"],
      ]);
      assert.match(output, /MCP platform\r\n[^\r\n]+\r\nChoice: executor/);
      assert.doesNotMatch(output, /Executor OAuth is not signed in/);
      const stored = readStoredAggregators(dir);
      assert.deepEqual(stored, {
        record: { choice: "executor", executor: { url: tokenUrl } },
        executorToken: token,
      });
      const executor = mcpServersFromAggregators({}, stored).find(
        (server) => server.name === "executor",
      );
      assert.equal(executor?.url, tokenUrl);
      assert.equal(executor?.token, token);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Abandoning Executor OAuth keeps Token mode and Save and back exits",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    const token = "fixture-executor-token";
    const record = {
      choice: "executor",
      executor: { url: "https://pat.example/mcp" },
    } as const;
    try {
      writeStoredAggregators(db, record, { executor: token });
      const output = await runSetup(
        dir,
        [
          [main, "5"],
          [save, "2"],
          ["Executor authentication: 1 - Token, 2 - OAuth [1]: ", "2"],
          ["Executor MCP URL: ", "https://executor.example/mcp?connection=bot"],
          ["Paste the final browser URL: ", ""],
          [save, "s"],
          [main, "q"],
        ],
        { SETUP_TEST_EXECUTOR: "1" },
      );
      assert.doesNotMatch(output, /Executor OAuth is not signed in/);
      assert.deepEqual(readStoredAggregators(dir), {
        record,
        executorToken: token,
      });
      assert.equal(
        readOauthCredential(db, EXECUTOR_OAUTH_CREDENTIAL),
        undefined,
      );
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Executor switches from Token to verified OAuth and back without replacing the token",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    const tokenUrl = "https://pat.example/mcp";
    const oauthUrl = "https://executor.example/mcp?connection=bot";
    const token = "fixture-executor-token";
    const tokenRecord = {
      choice: "executor",
      executor: { url: tokenUrl },
    } as const;
    try {
      writeStoredAggregators(db, tokenRecord, { executor: token });
      await runSetup(
        dir,
        [
          [main, "5"],
          [save, "2"],
          ["Executor authentication: 1 - Token, 2 - OAuth [1]: ", "2"],
          ["Executor MCP URL: ", oauthUrl],
          [
            "Paste the final browser URL: ",
            (transcript) => {
              assert.deepEqual(readStoredAggregators(dir).record, tokenRecord);
              assert.equal(
                readOauthCredential(db, EXECUTOR_OAUTH_CREDENTIAL),
                undefined,
              );
              const link = transcript.match(
                /https:\/\/executor\.example\/auth\/authorize\?[^\s]+/,
              );
              assert.ok(link);
              const authorize = new URL(link[0]);
              return `${authorize.searchParams.get("redirect_uri")}?code=test-code&state=${authorize.searchParams.get("state")}`;
            },
          ],
          [save, "s"],
          [main, "q"],
        ],
        { SETUP_TEST_EXECUTOR: "1" },
      );
      const oauth = readStoredAggregators(dir);
      assert.deepEqual(oauth, {
        record: {
          choice: "executor",
          executor: { url: oauthUrl, auth: "oauth" },
        },
        executorToken: token,
      });
      assert.equal(
        readOauthCredential(db, EXECUTOR_OAUTH_CREDENTIAL)?.connectionId,
        "bot",
      );
      assert.deepEqual(mcpServersFromAggregators({}, oauth), [
        { name: "executor", url: oauthUrl, mode: "direct", oauth: "executor" },
      ]);

      await runSetup(dir, [
        [main, "5"],
        [save, "2"],
        ["Executor authentication: 1 - Token, 2 - OAuth [2]: ", "1"],
        ["Executor URL: ", tokenUrl],
        ["Executor token [saved] (hidden, Enter keeps current): ", ""],
        [save, "s"],
        [main, "q"],
      ]);
      assert.deepEqual(readStoredAggregators(dir), {
        record: tokenRecord,
        executorToken: token,
      });
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

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
      assert.equal(readStoredAggregators(dir).record, undefined);
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

test(
  "Web search saves and reloads Weather without writing on an untouched Save and back",
  { skip: !hasPty },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
    const path = join(dir, "config.yaml");
    const env = { DATA_DIR: dir };
    const web = () => loadHarnessConfig(env).web;
    const weatherRegistered = () =>
      createWebTools(web(), {}).some(({ name }) => name === "weather");
    try {
      assert.equal(weatherRegistered(), true);
      await runSetup(dir, [
        [main, "6"],
        [save, "s"],
        [main, "q"],
      ]);
      await assert.rejects(stat(path), { code: "ENOENT" });

      const original = "# keep\nweb:\n  search: []\n  extract: []\n";
      await writeFile(path, original);
      const disabled = await runSetup(dir, [
        [main, "6"],
        [save, "5"],
        [save, "s"],
        [main, "q"],
      ]);
      assert.match(
        disabled,
        /Weather \(Open-Meteo\): On[\s\S]*Weather \(Open-Meteo\): Off/,
      );
      assert.match(disabled, /Web settings saved\./);
      assert.equal(web().weather, false);
      assert.equal(weatherRegistered(), false);
      const saved = await readFile(path, "utf8");
      assert.match(saved, /^# keep\n/);
      assert.deepEqual(parse(saved).web, {
        search: [],
        extract: [],
        weather: false,
      });

      const reloaded = await runSetup(dir, [
        [main, "6"],
        [save, "s"],
        [main, "q"],
      ]);
      assert.match(reloaded, /Weather \(Open-Meteo\): Off/);
      assert.doesNotMatch(reloaded, /Web settings saved\./);
      assert.equal(await readFile(path, "utf8"), saved);
      assert.equal(weatherRegistered(), false);

      await runSetup(dir, [
        [main, "6"],
        [save, "5"],
        [save, "s"],
        [main, "q"],
      ]);
      assert.equal(web().weather, true);
      assert.equal(weatherRegistered(), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

function saveScopedMemoryFixture(dir: string) {
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredAggregators(
      db,
      {
        choice: "executor",
        executor: { url: executorFixtureUrl, auth: "oauth" },
      },
      {},
    );
    writeOauthCredential(db, EXECUTOR_OAUTH_CREDENTIAL, {
      type: "oauth",
      executorUrl: executorFixtureUrl,
      access: "fixture-scoped-access",
      expires: Date.now() + 60_000,
      connectionId: "fixture-connection",
      organizationId: "fixture-org",
      grantBinding: "fixture-grant",
    });
  } finally {
    db.close();
  }
}

test(
  "Memory setup verifies the exact Executor paths before saving and can switch back to Markdown",
  { skip: !hasPty },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-memory-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = join(dir, "custom.yaml");
    const original =
      "memory:\n  enabled: false\n  curator_model: {provider: faux, model_id: cheap}\nweb: {weather: false}\n";
    await writeFile(config, original);
    const paths = ['tools["foo-bar"].recall', 'tools["foo-bar"].retain'];
    saveScopedMemoryFixture(dir);
    const trace = join(dir, "mcp.jsonl");
    const env = {
      CONFIG_FILE: config,
      SETUP_TEST_MEMORY: trace,
    };
    const output = await runSetup(
      dir,
      [
        [
          main,
          (transcript) => {
            assert.match(transcript, /7 - Memory\b/);
            return "7";
          },
        ],
        [
          save,
          (transcript) => {
            assert.match(transcript, /1 - Internal Markdown \(default\)/);
            assert.match(transcript, /2 - Executor Bot Memory/);
            assert.doesNotMatch(transcript, /SQLite/);
            return "2";
          },
        ],
        ["App slug (Enter cancels): ", "foo-bar"],
        [save, "s"],
        [main, "q"],
      ],
      env,
    );
    assert.match(output, /Memory settings saved/);
    assert.deepEqual(JSON.parse(await readFile(trace, "utf8")), {
      name: "describe",
      args: { paths },
    });
    assert.deepEqual(parse(await readFile(config, "utf8")), {
      memory: {
        enabled: false,
        curator_model: { provider: "faux", model_id: "cheap" },
        backend: "executor",
        app: "foo-bar",
      },
      web: { weather: false },
    });
    await runSetup(
      dir,
      [
        [main, "7"],
        [save, "1"],
        [save, "s"],
        [main, "q"],
      ],
      env,
    );
    assert.deepEqual(parse(await readFile(config, "utf8")).memory, {
      enabled: false,
      curator_model: { provider: "faux", model_id: "cheap" },
      backend: "local",
    });
  },
);

test(
  "Memory setup leaves config untouched on cancellation, invalid slug, missing connection and ambiguous discovery",
  { skip: !hasPty },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-memory-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = join(dir, "config.yaml");
    const original = "# keep this exactly\nweb: {weather: false}\n";
    await writeFile(config, original);
    saveScopedMemoryFixture(dir);
    const trace = join(dir, "mcp.jsonl");
    const env = {
      SETUP_TEST_MEMORY: trace,
      SETUP_TEST_MEMORY_DUPLICATE: "1",
    };
    const slug = "App slug (Enter cancels): ";
    const output = await runSetup(
      dir,
      [
        [
          main,
          (transcript) => {
            assert.match(transcript, /7 - Memory\b/);
            return "7";
          },
        ],
        [save, "2"],
        [slug, " foobar"],
        [save, "2"],
        [slug, ""],
        [save, "2"],
        [slug, "foobar"],
        [save, "s"],
        [main, "q"],
      ],
      env,
    );
    assert.match(output, /lowercase DNS slug/);
    assert.match(output, /could not verify.*recall and retain/i);
    assert.deepEqual(JSON.parse(await readFile(trace, "utf8")), {
      name: "describe",
      args: { paths: ["tools.foobar.recall", "tools.foobar.retain"] },
    });
    const missingDir = await mkdtemp(
      join(tmpdir(), "pi-setup-memory-unlinked-"),
    );
    t.after(() => rm(missingDir, { recursive: true, force: true }));
    const missingTrace = join(missingDir, "trace.jsonl");
    const missing = await runSetup(
      missingDir,
      [
        [main, "7"],
        [save, "2"],
        [slug, "foobar"],
        [save, "s"],
        [main, "q"],
      ],
      { SETUP_TEST_MEMORY: missingTrace },
    );
    assert.match(missing, /configure.*Executor.*MCP platform/i);
    await assert.rejects(stat(missingTrace), { code: "ENOENT" });
    await assert.rejects(stat(join(missingDir, "config.yaml")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(config, "utf8"), original);
  },
);

test(
  "Memory setup rejects a bearer connection without calling describe",
  { skip: !hasPty },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-setup-memory-bearer-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const trace = join(dir, "mcp.jsonl");
    const output = await runSetup(
      dir,
      [
        [main, "7"],
        [save, "2"],
        ["App slug (Enter cancels): ", "foo-bar"],
        [save, "s"],
        [main, "q"],
      ],
      {
        EXECUTOR_MCP_URL: executorFixtureUrl,
        EXECUTOR_TOKEN: "fixture-full-access",
        SETUP_TEST_MEMORY: trace,
      },
    );
    assert.match(output, /configure.*scoped Executor/i);
    await assert.rejects(stat(trace), { code: "ENOENT" });
    await assert.rejects(stat(join(dir, "config.yaml")), { code: "ENOENT" });
  },
);

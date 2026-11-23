#!/usr/bin/env node
/**
 * In-container diagnostic (docker exec). Never prints secret values.
 * Run from /app after build: node scripts/diagnose-tg-runtime.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  discoverLlmModels,
  environmentModels,
  LLM_PROVIDER_ID,
  operatorSecret,
  readConfig,
  startupErrorMessage,
  telegramAllowlistMisconfiguration,
} from "../dist/src/config.js";
import {
  readPhoneGateway,
  readStoredAggregators,
  readStoredTelegram,
} from "../dist/src/setup.js";
import {
  describeVolumeProvider,
  describeWhatsAppVolume,
  formatWaiting,
  readVolumeSetupFacts,
} from "../dist/src/diagnose-volume.js";
import { readAppInfo } from "../dist/src/app-info.js";
import {
  checkWebConfigWriteAccess,
  describeWebSetup,
} from "../dist/src/web-config.js";
import { spawnSync } from "node:child_process";

const optional = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
  "WHATSAPP_ALLOWED_USERS",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "EXECUTOR_MCP_URL",
  "EXECUTOR_TOKEN",
  "COMPOSIO_MCP_URL",
  "COMPOSIO_API_KEY",
  "COMPOSIO_USER_ID",
  "SELF_HOSTED_MCP_URL",
  "SELF_HOSTED_TOKEN",
  "SELF_HOSTED_HEADER",
  "DATA_DIR",
];

function volumeDir() {
  return process.env.DATA_DIR?.trim() || "/app/data";
}

function loadConfig() {
  const dir = volumeDir();
  return readConfig(
    process.env,
    readStoredAggregators(dir),
    readStoredTelegram(dir),
  );
}

/** Global default lives in app.sqlite; read-only peek, never a second writer. */
const globalDefault = () => {
  const dataDir = process.env.DATA_DIR?.trim() || "/app/data";
  try {
    const db = new DatabaseSync(join(dataDir, "app.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("model-defaults-selection:live");
      if (!row) return undefined;
      const value = JSON.parse(row.value);
      return value?.modelId
        ? `${value.provider}/${value.modelId} · ${value.effort}`
        : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
};

const section = (title) => console.log(`\n=== ${title} ===`);

const envStatus = (name) => {
  const file = process.env[`${name}_FILE`]?.trim();
  const raw = file
    ? existsSync(file)
      ? readFileSync(file, "utf8").trim()
      : ""
    : (process.env[name]?.trim() ?? "");
  if (!raw) return "EMPTY";
  if (/^replace_with/i.test(raw)) return "PLACEHOLDER";
  return "set";
};

section("Build identity");
const id = readAppInfo();
console.log(
  `commit=${id.commit ?? "unknown"} version=${id.version ?? "unknown"}`,
);
if (!id.commit && envStatus("SOURCE_COMMIT") === "set")
  console.log(
    "SOURCE_COMMIT is set but did not pass validation (short or invalid value).",
  );
if (!id.commit)
  console.log(
    "SOURCE_COMMIT is missing: the deployment has not provided the commit SHA. Export SOURCE_COMMIT=$(git rev-parse HEAD).",
  );

section("Environment variables (presence)");
console.log(
  "No variables are required. The token and allowed users come from the volume (`npm run setup`); environment variables override saved values.",
);
for (const name of optional)
  console.log(`${name}=${envStatus(name)} (optional)`);
console.log(
  `TELEGRAM_ALLOWED_CHATS=${envStatus("TELEGRAM_ALLOWED_CHATS")} (optional; defaults to ALLOWED_USERS)`,
);
console.log(
  `SOURCE_COMMIT=${envStatus("SOURCE_COMMIT")} (runtime; the deployment panel can set it)`,
);

const phoneGateway = readPhoneGateway(volumeDir());
if (phoneGateway === "whatsapp") {
  section("WhatsApp");
  for (const line of describeWhatsAppVolume(volumeDir())) console.log(line);
} else {
  section("Telegram and MCP configuration (local validation)");
  try {
    const config = loadConfig();
    console.log("readConfig: OK");
    console.log(
      `allowlist users=${config.users.length} chats=${config.chats.length}`,
    );
    console.log(`allowlist user IDs: ${config.users.join(", ")}`);
    const chatsDefault =
      !process.env.TELEGRAM_ALLOWED_CHATS?.trim() &&
      config.chats.join(",") === config.users.join(",");
    console.log(
      `allowlist chat IDs: ${config.chats.join(", ")}${chatsDefault ? " (defaults to users)" : ""}`,
    );
    console.log(`mcp servers=${config.mcp.length}`);
    for (const server of config.mcp)
      console.log(`  - ${server.name}: endpoint configured (URL omitted)`);
  } catch (error) {
    console.log(`readConfig: FAILED — ${startupErrorMessage(error)}`);
  }
}

const dataDir = process.env.DATA_DIR?.trim() || "/app/data";

section("Web search");
try {
  for (const line of describeWebSetup(dataDir, process.env)) console.log(line);
  checkWebConfigWriteAccess({ ...process.env, DATA_DIR: dataDir });
} catch (error) {
  console.log(startupErrorMessage(error));
}

section("Model provider");
const volumeFacts = readVolumeSetupFacts(dataDir, process.env);
for (const line of describeVolumeProvider(volumeFacts)) console.log(line);
if (volumeFacts.source === "env") {
  try {
    const models = await environmentModels();
    const catalog = models.getModels(LLM_PROVIDER_ID);
    console.log(
      `environmentModels: OK (${models
        .getProviders()
        .map((p) => p.id)
        .join(", ")}) — ${catalog.length} model(s)`,
    );
    const reasoning = catalog.filter((m) => m.reasoning).map((m) => m.id);
    console.log(
      `reasoning enabled (${reasoning.length}): ${reasoning.join(", ") || "none — /thinking stays off; set LLM_MODELS with reasoning=true"}`,
    );
    for (const model of catalog.slice(0, 20))
      console.log(`  ${LLM_PROVIDER_ID}/${model.id}`);
    if (catalog.length > 20) console.log(`  … +${catalog.length - 20}`);
    console.log(
      `global default: ${globalDefault() ?? "none selected (defaults to the first catalog entry)"}`,
    );
    console.log(
      "Saved configuration: npm run setup -- --list. OAuth: npm run login.",
    );
  } catch (error) {
    console.log(`environmentModels: FAILED — ${startupErrorMessage(error)}`);
  }
} else if (volumeFacts.source === "volume") {
  console.log(
    "environmentModels: not queried (the API key is on the volume; diagnostics do not read or print it).",
  );
  console.log(
    `global default: ${globalDefault() ?? "none selected (defaults to the first catalog entry)"}`,
  );
  console.log(
    "Saved configuration: npm run setup -- --list. OAuth: npm run login.",
  );
} else {
  try {
    await environmentModels();
    console.log("environmentModels: OK, but no entries were found.");
  } catch (error) {
    console.log(`environmentModels: FAILED — ${startupErrorMessage(error)}`);
  }
  console.log(
    "No provider is configured in the environment or on the volume. Run npm run setup or npm run login.",
  );
}

if (process.argv.includes("--probe")) {
  section("Live LLM endpoint probe (--probe; API key is not shown)");
  try {
    const raw = process.env.LLM_BASE_URL?.trim();
    if (!raw)
      throw new Error("Configure LLM_BASE_URL (endpoint OpenAI-compatible).");
    let baseUrl;
    try {
      baseUrl = new URL(raw).href.replace(/\/$/, "");
    } catch {
      throw new Error("Invalid LLM_BASE_URL endpoint");
    }
    const key = operatorSecret(process.env, "LLM_API_KEY");
    if (!key) throw new Error("Configure LLM_API_KEY or LLM_API_KEY_FILE.");
    const discovered = await discoverLlmModels(baseUrl, key);
    console.log(`GET ${baseUrl}/models: OK — ${discovered.length} model(s)`);
    for (const model of discovered.slice(0, 20)) console.log(`  ${model.id}`);
    if (discovered.length > 20) console.log(`  … +${discovered.length - 20}`);
    console.log(
      "Discovery does not report reasoning support. Set LLM_MODELS with reasoning=true to enable /thinking.",
    );
  } catch (error) {
    console.log(`probe: FAILED — ${startupErrorMessage(error)}`);
    console.log(
      "Check LLM_BASE_URL (include the version segment, e.g. /v1, if the provider requires it) and the API key.",
    );
  }
}

section("Heartbeat / DATA_DIR");
console.log(`DATA_DIR=${dataDir}`);
const healthPath = join(dataDir, "health.json");
if (!existsSync(healthPath)) {
  console.log(
    "health.json: missing (polling is not healthy yet or the process has stopped)",
  );
} else {
  try {
    const health = JSON.parse(readFileSync(healthPath, "utf8"));
    const ageMs = Date.now() - Number(health.at ?? 0);
    console.log(
      `health.json: present (age ~${Math.round(ageMs / 1000)}s${ageMs > 90_000 ? ", possibly stale" : ""})`,
    );
    const waiting = formatWaiting(health.waiting);
    if (waiting) console.log(waiting);
  } catch {
    console.log("health.json: unreadable");
  }
}

if (phoneGateway !== "whatsapp") {
  section("Telegram API (token available; secrets omitted)");
  try {
    const { token } = loadConfig();
    const call = async (method, body = {}) => {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        },
      );
      const data = await response.json();
      if (!data.ok)
        throw new Error(`${method}: ${data.description ?? response.status}`);
      return data.result;
    };
    const config = loadConfig();
    const me = await call("getMe");
    console.log(
      `getMe: @${me.username ?? "?"} id=${me.id} (use /status@${me.username ?? "Bot"} in groups)`,
    );
    const misconfig = telegramAllowlistMisconfiguration(me.id, config);
    if (misconfig) console.log(`CONFIG ERROR: ${misconfig}`);
    const hook = await call("getWebhookInfo");
    console.log(
      hook.url
        ? `getWebhookInfo: ACTIVE WEBHOOK (${hook.url}) — polling cannot receive updates; call deleteWebhook`
        : "getWebhookInfo: no webhook (polling can run)",
    );
    for (const chatId of config.chats) {
      try {
        const chat = await call("getChat", { chat_id: Number(chatId) });
        console.log(
          `getChat ${chatId}: type=${chat.type} title=${chat.title ?? chat.username ?? "?"}`,
        );
      } catch (error) {
        console.log(
          `getChat ${chatId}: FAILED — ${error.message}. Wrong ID, or the bot is not in this chat.`,
        );
      }
    }
  } catch (error) {
    console.log(`Telegram API: FAILED — ${startupErrorMessage(error)}`);
  }
}

section("SQLite database (app.sqlite, no sqlite3 CLI)");
{
  const dbPath = join(dataDir, "app.sqlite");
  console.log(`path=${dbPath}`);
  if (!existsSync(dbPath)) {
    console.log("app.sqlite: missing (first boot or volume not mounted)");
  } else {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const deliveries = db
        .prepare(
          "SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state ORDER BY state",
        )
        .all();
      console.log(
        deliveries.length
          ? `deliveries: ${deliveries.map((r) => `${r.state}=${r.n}`).join(", ")}`
          : "deliveries: none (the bot has not queued a reply yet)",
      );
      const recent = db
        .prepare(
          "SELECT id, state, substr(text,1,72) AS preview FROM deliveries ORDER BY rowid DESC LIMIT 5",
        )
        .all();
      for (const row of recent)
        console.log(`  ${row.state} ${row.id}: ${row.preview}`);
      const mcpPending = db
        .prepare(
          "SELECT COUNT(*) AS n FROM mcp_interactions WHERE state='pending'",
        )
        .get();
      console.log(`mcp_interactions pending=${mcpPending?.n ?? 0}`);
      const mcpCards = db
        .prepare(
          "SELECT id, state, substr(result,1,120) AS detail FROM deliveries WHERE id GLOB 'telegram:mcp:*' ORDER BY rowid DESC LIMIT 8",
        )
        .all();
      for (const row of mcpCards)
        console.log(
          `  mcp delivery ${row.state} ${row.id}${row.detail ? ` — ${row.detail}` : ""}`,
        );
      const mcpMarkup = db
        .prepare(
          "SELECT key FROM meta WHERE key GLOB 'telegram:markup:telegram:mcp:*' ORDER BY rowid DESC LIMIT 3",
        )
        .all();
      console.log(
        mcpMarkup.length
          ? `mcp inline markup keys=${mcpMarkup.map((r) => r.key).join(", ")}`
          : "mcp inline markup: none (card not queued or already sent)",
      );
      const updates = db
        .prepare("SELECT COUNT(*) AS n FROM telegram_updates")
        .get();
      console.log(
        `telegram_updates: ${updates.n} (0 = no commands or messages accepted yet)`,
      );
      const offset = db
        .prepare(
          "SELECT key, value FROM meta WHERE key GLOB 'telegram:offset:*'",
        )
        .all();
      for (const row of offset) console.log(`offset ${row.key}=${row.value}`);
      const conn = db
        .prepare(
          "SELECT value FROM meta WHERE key='telegram:connection' LIMIT 1",
        )
        .get();
      if (conn?.value) {
        try {
          const j = JSON.parse(conn.value);
          console.log(
            `telegram:connection: enabled=${j.enabled} botId=${j.bot?.id ?? "?"} storedUsers=${(j.allowedUsers ?? []).length} storedChats=${(j.allowedChats ?? []).length}`,
          );
        } catch {
          console.log("telegram:connection: unreadable JSON");
        }
      } else
        console.log("telegram:connection: missing (restart the container)");
      db.close();
    } catch (error) {
      console.log(`app.sqlite: read failed — ${error.message}`);
    }
  }
}

section("Process health check");
{
  const hc = spawnSync(process.execPath, ["dist/src/healthcheck.js"], {
    encoding: "utf8",
  });
  console.log(
    hc.status === 0
      ? "healthcheck.js: OK"
      : "healthcheck.js: FAILED (heartbeat missing or stale)",
  );
}

section("Reminders");
console.log(`\
- TELEGRAM_ALLOWED_CHATS is optional. Omit it for DMs (uses ALLOWED_USERS). For groups, use the negative chat ID.
- TELEGRAM_ALLOWED_USERS deve incluir seu user ID do Telegram.
- Regular groups (type group) are supported; channels are not. In groups, use /status@YourBot or disable privacy mode.
- EXECUTOR_MCP_URL and EXECUTOR_TOKEN come only from the deployment environment, never from Git.
- EXECUTOR_TOKEN is the raw token without the Bearer prefix.
- Set variables in .env or in the deployment UI. Do not commit .env.
- Database: ${join(dataDir, "app.sqlite")} (not store.db). The image does not include the sqlite3 binary; use npm run diagnose.`);

#!/usr/bin/env node
/**
 * ChatGPT / Codex subscription login for the Telegram bot volume.
 *
 * Usage:
 *   npm run login -- [openai|openai-codex] [--device-code]
 *   npm run login -- --logout [openai|openai-codex]
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootstrapModels, SetupRequiredError } from "../dist/src/config.js";
import { readStoredSetup, writeStoredSetup } from "../dist/src/setup.js";
import { SUBSCRIPTION_PROVIDER_IDS } from "../dist/src/subscription-auth.js";
import {
  oauthInteractionFromReadline,
  runSubscriptionLogin,
  subscriptionChatCatalog,
} from "../dist/src/subscription-login.js";
import { Store, SqlCredentials } from "../dist/src/store.js";
import {
  modelDefaultsConfirmedKey,
  modelDefaultsKey,
} from "../dist/src/settings.js";

const MODE = "live";

const usage = `Uso: npm run login -- [openai|openai-codex] [--device-code]
       npm run login -- --logout [openai|openai-codex]

  openai          Sign in with ChatGPT (Plus/Pro subscription) — default
  openai-codex    OpenAI Codex (legado, modelos GPT-5.x Codex)
  --device-code   openai-codex only: device-code login (no localhost needed)

Tokens are stored in DATA_DIR/app.sqlite (credentials table, provider openai or
openai-codex). The bot reloads automatically within about 10 seconds. LLM_BASE_URL and LLM_API_KEY
are not required. LLM_AUTH=chatgpt is optional; the saved sign-in is enough.`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

const logout = argv.includes("--logout");
const deviceCodeOnly = argv.includes("--device-code");
const positional = argv.filter(
  (arg) => arg !== "--device-code" && arg !== "--logout",
);
const providerArg = positional[0] ?? "openai";
if (!SUBSCRIPTION_PROVIDER_IDS.includes(providerArg)) {
  fail(`Invalid provider: ${providerArg}\n\n${usage}`, 2);
}
if (providerArg === "openai" && deviceCodeOnly) {
  fail("--device-code applies only to openai-codex.\n\n" + usage, 2);
}

const dir = process.env.DATA_DIR?.trim() || "data";
mkdirSync(dir, { recursive: true, mode: 0o700 });

const store = new Store(dir);
const credentials = new SqlCredentials(store);
const stored = readStoredSetup(dir);

async function loadModels() {
  try {
    return await bootstrapModels(credentials, process.env, { stored });
  } catch (error) {
    if (error instanceof SetupRequiredError) {
      return bootstrapModels(
        credentials,
        { ...process.env, LLM_AUTH: "chatgpt" },
        { stored },
      );
    }
    throw error;
  }
}

const models = await loadModels().catch((error) => {
  store.close();
  fail(error instanceof Error ? error.message : String(error));
});

if (logout) {
  await models.logout(providerArg);
  store.close();
  console.log(`Signed out (${providerArg}).`);
  process.exit(0);
}

const rl = createInterface({ input, output });
const interaction = oauthInteractionFromReadline(rl, { deviceCodeOnly });

console.log(`Iniciando login OAuth (${providerArg})…`);

try {
  await runSubscriptionLogin(store, models, providerArg, interaction, {
    deviceCodeOnly,
  });
} catch (error) {
  rl.close();
  store.close();
  fail(error instanceof Error ? error.message : String(error));
}

rl.close();

function seedSetupIfEmpty(providerId) {
  if (stored.record?.modelId) return false;
  const provider = models.getProvider(providerId);
  if (!provider) return false;
  const catalog = subscriptionChatCatalog(models, providerId);
  const model = catalog[0];
  if (!model) return false;
  const effort =
    model.efforts.find((level) => level === "high") ??
    model.efforts.at(-1) ??
    "off";
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredSetup(
      db,
      {
        providerId,
        baseUrl: provider.baseUrl ?? "",
        modelId: model.id,
        effort,
        authMode: "chatgpt",
      },
      {},
      MODE,
    );
    db.prepare(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(
      modelDefaultsKey(MODE),
      JSON.stringify({
        provider: providerId,
        modelId: model.id,
        effort,
      }),
    );
    db.prepare(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(modelDefaultsConfirmedKey(MODE), "1");
  } finally {
    db.close();
  }
  console.log(
    `Default saved: ${providerId} / ${model.id} (reasoning effort ${effort}).`,
  );
  return true;
}

const seededFirstCatalogModel = seedSetupIfEmpty(providerArg);
store.close();
console.log(
  seededFirstCatalogModel
    ? "Signed in. The first catalog model was selected; use /model to switch. Tokens were saved to the volume. The bot will use the subscription on its next check (about 10 seconds) or after a restart."
    : "Signed in. Tokens were saved to the volume. The bot will use the subscription on its next check (about 10 seconds) or after a restart. The previously saved model is unchanged; use /model to switch.",
);

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { maskLogText } from "./channel.js";
import {
  readStoredWhatsapp,
  resolveWhatsappUsers,
  setupKey,
  usableSetupRecord,
  type SetupRecord,
} from "./setup.js";
import {
  canonicalProviderId,
  compatEnvConfigured,
  isApiKeyProviderId,
} from "./native-providers.js";

type Env = Record<string, string | undefined>;

interface VolumeProviderFacts {
  source: "env" | "volume" | "none";
  recordPresent: boolean;
  authMode?: "chatgpt" | "api_key";
  providerId?: string;
  modelId?: string;
  credentials: Record<"llm" | "openai" | "openai-codex", boolean>;
}

/** Compat reserve only. A complete official volume setup ignores these. */
function envOverrides(env: Env) {
  return compatEnvConfigured(env);
}

function emptyCredentials(): VolumeProviderFacts["credentials"] {
  return { llm: false, openai: false, "openai-codex": false };
}

/**
 * Read-only view of the volume the bot actually runs. Credential values, endpoints
 * and file paths stay out of the result.
 */
export function readVolumeSetupFacts(
  dir: string,
  env: Env = process.env,
  mode = "live",
): VolumeProviderFacts {
  const credentials = emptyCredentials();
  const presentIds = new Set<string>();
  let record: SetupRecord | undefined;
  const file = join(dir, "app.sqlite");
  if (existsSync(file)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const row = db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(setupKey(mode)) as { value?: string } | undefined;
      if (row?.value) {
        try {
          const parsed = JSON.parse(row.value) as SetupRecord;
          if (usableSetupRecord(parsed)) record = parsed;
        } catch {
          record = undefined;
        }
      }
      const present = db.prepare("SELECT provider FROM credentials").all() as {
        provider: string;
      }[];
      for (const row of present) {
        presentIds.add(row.provider);
        if (row.provider === "llm") credentials.llm = true;
        if (row.provider === "openai") credentials.openai = true;
        if (row.provider === "openai-codex") credentials["openai-codex"] = true;
      }
    } catch {
      /* Missing tables mean the volume has no setup yet. */
    } finally {
      db?.close();
    }
  }
  const hasCredential = (id: string) =>
    presentIds.has(id) || presentIds.has(canonicalProviderId(id));
  const recordPresent = record !== undefined;
  const authMode = !record
    ? undefined
    : record.authMode === "chatgpt" || record.providerId === "openai-codex"
      ? "chatgpt"
      : "api_key";
  const officialRecord =
    !!record &&
    (record.authMode === "chatgpt" ||
      record.providerId === "openai-codex" ||
      (isApiKeyProviderId(record.providerId) &&
        hasCredential(record.providerId)));
  const overrides = envOverrides(env);
  // Official CLI setup wins. Compat `llm` still lets LLM_* override the volume.
  const source = officialRecord
    ? "volume"
    : overrides
      ? "env"
      : recordPresent
        ? "volume"
        : "none";
  return {
    source,
    recordPresent,
    ...(authMode ? { authMode } : {}),
    ...(record?.providerId ? { providerId: record.providerId } : {}),
    ...(record?.modelId ? { modelId: record.modelId } : {}),
    credentials,
  };
}

const SETUP_VERSUS_LOGIN =
  "npm run setup is the full wizard (provider, API key or ChatGPT, model, reasoning, vision, and audio). npm run login is only for ChatGPT/Codex OAuth, including device-code login without a TTY. Upsy OAuth is in the MCP menu in npm run setup, not npm run login. Both commands save to the volume. LLM_BASE_URL and LLM_API_KEY do not override an official setup; they apply only to the compatible llm provider (Other in setup).";

/** Lines for diagnose. Never includes secrets, endpoints, or credential values. */
export function describeVolumeProvider(facts: VolumeProviderFacts): string[] {
  const lines = [
    facts.recordPresent
      ? `volume: saved configuration present (authMode=${facts.authMode ?? "api_key"}, provider=${facts.providerId ?? "?"}, model=${facts.modelId ?? "?"})`
      : "volume: saved configuration missing",
    `credentials: llm=${facts.credentials.llm ? "present" : "missing"} openai=${facts.credentials.openai ? "present" : "missing"} openai-codex=${facts.credentials["openai-codex"] ? "present" : "missing"}`,
    facts.source === "env"
      ? "source: environment (compatible llm provider; no complete official setup on the volume)"
      : facts.source === "volume"
        ? "source: volume (CLI setup; LLM_BASE_URL/LLM_API_KEY do not override an official setup)"
        : "source: none (no LLM_* variables or saved configuration)",
  ];
  if (facts.recordPresent)
    lines.push(
      `model on volume: ${facts.providerId ?? "?"}/${facts.modelId ?? "?"}. Use /model to switch. npm run login saves the first catalog model only when the volume has no saved model.`,
    );
  lines.push(SETUP_VERSUS_LOGIN);
  return lines;
}

/**
 * WhatsApp facts for diagnose. Numbers are masked to the last four digits.
 * `WHATSAPP_ALLOWED_USERS` overrides the list saved on the volume. No session secrets.
 */
export function describeWhatsAppVolume(
  dir: string,
  env: Env = process.env,
): string[] {
  let numbers = "none";
  try {
    const users = resolveWhatsappUsers(env, readStoredWhatsapp(dir)) ?? [];
    numbers = users.map((user) => maskLogText(user)).join(", ") || "none";
  } catch {
    numbers = "invalid override";
  }
  const paired = existsSync(join(dir, "whatsapp-auth", "creds.json"));
  const lines = [
    `numbers: ${numbers}`,
    `paired session: ${paired ? "yes" : "no"}`,
  ];
  const file = join(dir, "app.sqlite");
  if (!existsSync(file)) {
    lines.push("pending deliveries: database missing");
    return lines;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM deliveries WHERE state='pending' AND channel='whatsapp'",
      )
      .get() as { n: number } | undefined;
    lines.push(`pending deliveries: ${row?.n ?? 0}`);
  } catch {
    lines.push("pending deliveries: unavailable");
  } finally {
    db?.close();
  }
  return lines;
}

/** health.json `waiting` from the idle process. Unknown values are omitted. */
export function formatWaiting(waiting: unknown): string | undefined {
  if (waiting === "setup")
    return "waiting=setup — process running without a provider. Run npm run setup.";
  if (waiting === "login")
    return "waiting=login — process running and waiting for OAuth. Run npm run login.";
  return undefined;
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMap, parseDocument } from "yaml";
import { operatorSecret } from "./config.js";
import { loadHarnessConfig, userConfigPath } from "./harness-config.js";
import {
  WEB_KEY_ENV,
  WEB_SEARCH_PROVIDERS,
  type RemoteWebProvider,
  type WebConfig,
  type WebProvider,
} from "./web-providers.js";

type Env = Record<string, string | undefined>;
export type WebKeys = Partial<Record<RemoteWebProvider, string>>;

export function webCredentialId(provider: RemoteWebProvider) {
  return `web:${provider}`;
}

export function readWebKeys(db: DatabaseSync): WebKeys {
  const keys: WebKeys = {};
  for (const provider of WEB_SEARCH_PROVIDERS) {
    try {
      const raw = (
        db
          .prepare("SELECT value FROM credentials WHERE provider=?")
          .get(webCredentialId(provider)) as { value: string } | undefined
      )?.value;
      if (!raw) continue;
      const credential = JSON.parse(raw);
      if (
        credential?.type === "api_key" &&
        typeof credential.key === "string"
      ) {
        const key = credential.key.trim();
        if (key) keys[provider] = key;
      }
    } catch {
      // Missing credentials table or invalid stored credential.
    }
  }
  return keys;
}

export function resolveWebKeys(env: Env, stored: WebKeys): WebKeys {
  const keys = { ...stored };
  for (const provider of WEB_SEARCH_PROVIDERS) {
    try {
      const override = operatorSecret(env, WEB_KEY_ENV[provider]);
      if (override) keys[provider] = override;
    } catch {
      console.error(`Pi-Agent: could not read ${WEB_KEY_ENV[provider]}_FILE.`);
    }
  }
  return keys;
}

export function activeWebProviders<P extends WebProvider>(
  order: readonly P[],
  keys: WebKeys,
) {
  return order.filter(
    (provider: WebProvider) => provider === "local" || Boolean(keys[provider]),
  );
}

export function readVolumeWebKeys(dir: string): WebKeys {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(dir, "app.sqlite"), { readOnly: true });
    return readWebKeys(db);
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

function writeWebConfig(env: Env, web: WebConfig) {
  const path = userConfigPath(env);
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const doc = parseDocument(source);
  if (doc.errors.length || (doc.contents && !isMap(doc.contents)))
    throw new Error("Invalid config.yaml");
  const existing = doc.get("web", true);
  if (isMap(existing)) {
    existing.set("search", doc.createNode(web.search));
    existing.set("extract", doc.createNode(web.extract));
  } else {
    doc.set("web", doc.createNode(web));
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, doc.toString(), { mode: 0o600 });
}

export function saveWebSetup(
  db: DatabaseSync,
  env: Env,
  config: WebConfig,
  keys: Partial<Record<RemoteWebProvider, string | null>>,
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT)",
    );
    const write = db.prepare(
      "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
    );
    const remove = db.prepare("DELETE FROM credentials WHERE provider=?");
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const key = keys[provider];
      if (key)
        write.run(
          webCredentialId(provider),
          JSON.stringify({ type: "api_key", key }),
        );
      else if (key === null) remove.run(webCredentialId(provider));
    }
    writeWebConfig(env, config);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function describeWebSetup(dir: string, env: Env) {
  const keys = resolveWebKeys(env, readVolumeWebKeys(dir));
  const { web } = loadHarnessConfig({ ...env, DATA_DIR: dir });
  return (["search", "extract"] as const).map((operation) => {
    const providers = activeWebProviders(web[operation], keys);
    if (providers.length === 0)
      return `web.${operation}: native tool disabled (MCP)`;
    if (providers.length === 1)
      return `web.${operation}: ${providers[0]} — warning: no fallback`;
    return `web.${operation}: ${providers.join(" → ")}`;
  });
}

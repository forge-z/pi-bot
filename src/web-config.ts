import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMap, parseDocument } from "yaml";
import { operatorSecret } from "./config.js";
import {
  configDirectory,
  HarnessConfigAccessError,
  loadHarnessConfig,
  userConfigPath,
} from "./harness-config.js";
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

export function resolveWebProviders<P extends WebProvider>(
  order: readonly P[],
  keys: WebKeys,
) {
  const available: P[] = [];
  const missingKeys: string[] = [];
  const missingKey = (provider: WebProvider) =>
    provider === "local" || keys[provider] ? undefined : WEB_KEY_ENV[provider];
  for (const provider of order) {
    const key = missingKey(provider);
    if (key) missingKeys.push(`${provider} (${key})`);
    else available.push(provider);
  }
  return { available, missingKeys };
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      throw new HarnessConfigAccessError(path, "read", code);
    assertConfigCreationAccess(path);
  }
  const doc = parseDocument(source);
  if (doc.errors.length || (doc.contents && !isMap(doc.contents)))
    throw new Error("Invalid config.yaml");
  const existing = doc.get("web", true);
  if (isMap(existing)) {
    existing.set("search", doc.createNode(web.search));
    existing.set("extract", doc.createNode(web.extract));
    if (web.weather !== undefined) existing.set("weather", web.weather);
  } else {
    doc.set("web", doc.createNode(web));
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, doc.toString(), { mode: 0o600 });
  } catch (error) {
    throw new HarnessConfigAccessError(
      path,
      "write",
      (error as NodeJS.ErrnoException).code,
    );
  }
}

function assertConfigCreationAccess(path: string) {
  try {
    const directory = configDirectory(path);
    if (process.getuid?.() === 0 && statSync(directory).uid !== 0)
      throw new HarnessConfigAccessError(
        path,
        "write",
        "root cannot create a private config in a non-root directory",
      );
    accessSync(directory, constants.W_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof HarnessConfigAccessError) throw error;
    throw new HarnessConfigAccessError(
      path,
      "write",
      (error as NodeJS.ErrnoException).code,
    );
  }
}

export function checkWebConfigWriteAccess(env: Env) {
  const path = userConfigPath(env);
  try {
    accessSync(path, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      throw new HarnessConfigAccessError(path, "write", code);
    assertConfigCreationAccess(path);
  }
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
    if (web[operation].length === 0)
      return `web.${operation}: native tool disabled (MCP)`;
    const { available, missingKeys } = resolveWebProviders(
      web[operation],
      keys,
    );
    const skipped = missingKeys.length
      ? `; missing API keys: ${missingKeys.join(", ")}`
      : "";
    if (available.length === 0)
      return `web.${operation}: all configured providers unavailable${skipped}`;
    if (available.length === 1)
      return `web.${operation}: ${available[0]} — warning: no fallback${skipped}`;
    return `web.${operation}: ${available.join(" → ")}${skipped}`;
  });
}

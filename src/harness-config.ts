import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isMap, parse, parseDocument, type Document } from "yaml";
import { DEFAULT_REACTION_DELAY_MS, reactionDelayMs } from "./reaction-ack.js";
import { validMemorySlug } from "./memory-executor.js";
import type { MemoryConfig } from "./memory.js";
import {
  WEB_CHOICES,
  type WebConfig,
  type WebProvider,
} from "./web-providers.js";

export type { WebConfig } from "./web-providers.js";

/**
 * Product defaults in `config.default.yaml`, with an optional user file on top.
 * The user path is `$DATA_DIR/config.yaml` unless `CONFIG_FILE` is set.
 * A file that does not parse is logged and ignored. A user file that cannot be read is an error.
 */

type Env = Record<string, string | undefined>;

export interface ServerTools {
  trust: "trusted" | "untrusted";
  read: string[];
  write: string[];
  /** False when this server did not set `tools`, so it uses the executor lists. */
  ownTools: boolean;
}

/** Thinking levels a subagent may use. `xhigh` and `max` are left out on purpose. */
const SUBAGENT_THINKING = ["off", "minimal", "low", "medium", "high"] as const;

export interface SubagentsConfig {
  /** Registers the `subagent` tool. Read at startup; a change needs a restart. */
  enabled: boolean;
  /** Tasks one call may run at once, 1..3. */
  maxParallel: number;
  /** The child's `maxTurns`, 1..20. */
  maxTurns: number;
  thinking: (typeof SUBAGENT_THINKING)[number];
}

const SUBAGENT_DEFAULTS: SubagentsConfig = {
  enabled: false,
  maxParallel: 3,
  maxTurns: 8,
  thinking: "low",
};

export interface HarnessConfig {
  mcpServers: Record<string, ServerTools>;
  asyncJobs: unknown[];
  /** Worker timing from `async_job`. Absent numbers fall back in the poller. */
  asyncJob: { timeoutMin?: number; pollSeconds?: number };
  /** Raw `sandbox_code_task` block; the tool validates it before registering. */
  sandboxTask?: unknown;
  web: WebConfig;
  /** Folder names under `$DATA_DIR/skills`, in prompt order. */
  skillsAlways: string[];
  /**
   * Milliseconds before the eyes reaction. `0` reacts immediately.
   * From `reaction_delay_ms`; missing or invalid stays at the default.
   */
  reactionDelayMs: number;
  turnReceiptFooter: boolean;
  /** `subagents` block. Off unless the file turns it on. */
  subagents: SubagentsConfig;
  memory: MemoryConfig;
  /** `whatsapp.attachment_urls`: hosts the bot may download an MCP attachment from. */
  whatsappAttachmentUrls: AttachmentUrlPolicy;
}

const WEB_DEFAULTS: WebConfig = {
  search: ["exa", "firecrawl"],
  extract: ["exa", "firecrawl"],
};

function webFrom(value: unknown): WebConfig {
  if (!isRecord(value)) return WEB_DEFAULTS;
  const order = <P extends WebProvider>(
    operation: keyof typeof WEB_CHOICES,
    choices: readonly P[],
    fallback: readonly P[],
  ): readonly P[] => {
    const list = value[operation];
    if (list === undefined) return fallback;
    if (
      Array.isArray(list) &&
      list.every((provider) => choices.includes(provider)) &&
      new Set(list).size === list.length
    )
      return list;
    console.error(`Pi-Agent: web.${operation} is invalid. Using the default.`);
    return fallback;
  };
  if (value.weather !== undefined && typeof value.weather !== "boolean")
    console.error(
      "Pi-Agent: web.weather must be true or false. Using the default.",
    );
  return {
    search: order("search", WEB_CHOICES.search, WEB_DEFAULTS.search),
    extract: order("extract", WEB_CHOICES.extract, WEB_DEFAULTS.extract),
    ...(typeof value.weather === "boolean" ? { weather: value.weather } : {}),
  };
}

export interface AttachmentUrlPolicy {
  /** Exact HTTPS host names. Empty sends only attachments that carry bytes. */
  hosts: string[];
  timeoutMs: number;
  maxBytes: number;
}

const ATTACHMENT_URL_DEFAULTS: AttachmentUrlPolicy = {
  hosts: [],
  timeoutMs: 20_000,
  maxBytes: 16 * 1024 * 1024,
};

const EMPTY: HarnessConfig = {
  mcpServers: {},
  asyncJobs: [],
  asyncJob: {},
  web: WEB_DEFAULTS,
  skillsAlways: [],
  reactionDelayMs: DEFAULT_REACTION_DELAY_MS,
  turnReceiptFooter: false,
  subagents: SUBAGENT_DEFAULTS,
  memory: { enabled: true },
  whatsappAttachmentUrls: ATTACHMENT_URL_DEFAULTS,
};
const globCache = new Map<string, RegExp | null>();
let cache: { key: string; config: HarnessConfig } | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `*` is one dotted segment. `**` crosses segments. Match is case-insensitive. */
export function globMatch(pattern: string, value: string) {
  let regex = globCache.get(pattern);
  if (regex === undefined) {
    try {
      const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\0")
        .replace(/\*/g, "[^.]*")
        .replace(/\0/g, ".*");
      regex = new RegExp(`^${source}$`, "i");
    } catch {
      regex = null;
    }
    globCache.set(pattern, regex);
  }
  return regex ? regex.test(value.trim()) : false;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function positiveNumber(value: unknown) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function schemaProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "the file must be a map";
  if ("mcp_servers" in value && value.mcp_servers != null) {
    if (!isRecord(value.mcp_servers)) return "mcp_servers must be a map";
    for (const [name, server] of Object.entries(value.mcp_servers)) {
      if (server === null) continue;
      if (!isRecord(server)) return `mcp_servers.${name} must be a map`;
      if (
        server.trust !== undefined &&
        server.trust !== "trusted" &&
        server.trust !== "untrusted"
      )
        return `mcp_servers.${name}.trust aceita trusted ou untrusted`;
      if (server.tools === undefined || server.tools === null) continue;
      if (!isRecord(server.tools))
        return `mcp_servers.${name}.tools must be a map`;
      for (const key of ["read", "write"] as const) {
        const list = server.tools[key];
        if (list === undefined || list === null) continue;
        if (
          !Array.isArray(list) ||
          list.some((item) => typeof item !== "string" || item.length === 0)
        )
          return `mcp_servers.${name}.tools.${key} must be a list of strings`;
      }
    }
  }
  if ("skills" in value && value.skills != null) {
    if (!isRecord(value.skills)) return "skills must be a map";
    if ("always" in value.skills && value.skills.always != null) {
      const list = value.skills.always;
      if (
        !Array.isArray(list) ||
        list.some((item) => typeof item !== "string" || item.length === 0)
      )
        return "skills.always must be a list of strings";
    }
  }
  if ("async_jobs" in value && value.async_jobs != null) {
    const jobs = value.async_jobs;
    if (Array.isArray(jobs)) {
      if (jobs.some((item) => !isRecord(item)))
        return "async_jobs must be a list of maps";
    } else if (!isRecord(jobs)) return "async_jobs must be a map";
    else {
      for (const [name, job] of Object.entries(jobs)) {
        if (job !== null && !isRecord(job))
          return `async_jobs.${name} must be a map`;
      }
    }
  }
  return undefined;
}

function merge(base: unknown, over: unknown): unknown {
  if (over === null || !isRecord(base) || !isRecord(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

function serverFrom(value: Record<string, unknown>): ServerTools {
  const tools = isRecord(value.tools) ? value.tools : undefined;
  return {
    trust: value.trust === "trusted" ? "trusted" : "untrusted",
    read: stringList(tools?.read),
    write: stringList(tools?.write),
    ownTools: tools !== undefined,
  };
}

/** One invalid field is logged and keeps its default; the other fields still apply. */
function subagentsFrom(value: unknown): SubagentsConfig {
  if (value === undefined || value === null) return SUBAGENT_DEFAULTS;
  const invalid = (field: string) =>
    console.error(
      `Pi-Agent: subagents.${field} is invalid. Using the default.`,
    );
  if (!isRecord(value)) {
    invalid("(bloco)");
    return SUBAGENT_DEFAULTS;
  }
  const out = { ...SUBAGENT_DEFAULTS };
  if (value.enabled !== undefined) {
    if (typeof value.enabled === "boolean") out.enabled = value.enabled;
    else invalid("enabled");
  }
  const bounded = (field: string, max: number) => {
    const n = value[field];
    if (n === undefined) return undefined;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max)
      return n;
    invalid(field);
    return undefined;
  };
  out.maxParallel = bounded("max_parallel", 3) ?? out.maxParallel;
  out.maxTurns = bounded("max_turns", 20) ?? out.maxTurns;
  if (value.thinking !== undefined) {
    const level = SUBAGENT_THINKING.find((item) => item === value.thinking);
    if (level) out.thinking = level;
    else invalid("thinking");
  }
  return out;
}

function memoryFrom(raw: unknown, user: Record<string, unknown>): MemoryConfig {
  const value = isRecord(raw) ? raw : {};
  const selection = isRecord(user.memory) ? user.memory : value;
  const { backend, app, provider } = selection;
  const enabled = value.enabled !== false;
  if (
    (Object.hasOwn(user, "memory") && !isRecord(user.memory)) ||
    (Object.hasOwn(selection, "enabled") &&
      typeof selection.enabled !== "boolean") ||
    (backend === "executor"
      ? !validMemorySlug(app)
      : backend === "advanced"
        ? provider !== "gemini" && provider !== "openai"
        : backend !== "local" &&
          (Object.hasOwn(selection, "backend") ||
            Object.hasOwn(selection, "app")))
  ) {
    console.error(
      "Pi-Agent: memory configuration is invalid. Memory is disabled.",
    );
    return { enabled: false };
  }
  if (backend === "executor" && validMemorySlug(app))
    return { enabled, backend, app };
  if (
    backend === "advanced" &&
    (provider === "gemini" || provider === "openai")
  )
    return { enabled, backend, provider };
  const config: MemoryConfig = {
    enabled,
    ...(backend === "local" ? { backend } : {}),
  };
  if (value.curator_model != null) {
    const model = value.curator_model;
    if (
      isRecord(model) &&
      typeof model.provider === "string" &&
      model.provider.trim() &&
      typeof model.model_id === "string" &&
      model.model_id.trim()
    )
      config.curatorModel = {
        provider: model.provider.trim(),
        modelId: model.model_id.trim(),
      };
    else
      console.error(
        "Pi-Agent: memory.curator_model is invalid. Using the conversation model.",
      );
  }
  return config;
}

function configFrom(
  raw: Record<string, unknown>,
  memory: MemoryConfig,
): HarnessConfig {
  const servers = isRecord(raw.mcp_servers) ? raw.mcp_servers : {};
  const mcpServers: Record<string, ServerTools> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isRecord(value)) mcpServers[name] = serverFrom(value);
  }
  const jobs = raw.async_jobs;
  const asyncJobs = Array.isArray(jobs)
    ? jobs.filter(isRecord)
    : isRecord(jobs)
      ? Object.values(jobs).filter(isRecord)
      : [];
  const timing = isRecord(raw.async_job) ? raw.async_job : {};
  return {
    mcpServers,
    asyncJobs,
    asyncJob: {
      timeoutMin: positiveNumber(timing.timeout_min),
      pollSeconds: positiveNumber(timing.poll_seconds),
    },
    sandboxTask: raw.sandbox_code_task,
    web: webFrom(raw.web),
    skillsAlways: stringList(
      isRecord(raw.skills) ? raw.skills.always : undefined,
    ),
    reactionDelayMs: reactionDelayMs(raw.reaction_delay_ms),
    turnReceiptFooter:
      isRecord(raw.turn_receipt) && raw.turn_receipt.footer === true,
    subagents: subagentsFrom(raw.subagents),
    memory,
    whatsappAttachmentUrls: attachmentUrlsFrom(
      isRecord(raw.whatsapp) ? raw.whatsapp.attachment_urls : undefined,
    ),
  };
}

function attachmentUrlsFrom(value: unknown): AttachmentUrlPolicy {
  if (!isRecord(value)) return ATTACHMENT_URL_DEFAULTS;
  const seconds = positiveNumber(value.timeout_seconds);
  const mb = positiveNumber(value.max_mb);
  return {
    hosts: stringList(value.hosts).map((host) => host.trim().toLowerCase()),
    timeoutMs: seconds ? seconds * 1000 : ATTACHMENT_URL_DEFAULTS.timeoutMs,
    maxBytes: mb
      ? Math.floor(mb * 1024 * 1024)
      : ATTACHMENT_URL_DEFAULTS.maxBytes,
  };
}

function defaultsPath() {
  const candidates = [
    join(import.meta.dirname, "../config.default.yaml"),
    join(import.meta.dirname, "../../config.default.yaml"),
    join(process.cwd(), "config.default.yaml"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

export function userConfigPath(env: Env = process.env) {
  const override = env.CONFIG_FILE?.trim();
  if (override) return override;
  return join(env.DATA_DIR?.trim() || "data", "config.yaml");
}

export function configDirectory(path: string) {
  let directory = dirname(path);
  for (;;) {
    try {
      statSync(directory);
      return directory;
    } catch (error) {
      const parent = dirname(directory);
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        parent === directory
      )
        throw error;
      directory = parent;
    }
  }
}

export class HarnessConfigAccessError extends Error {
  constructor(
    path: string,
    operation: "read" | "write",
    code: string | undefined,
  ) {
    let owner = "owner UID unavailable";
    try {
      owner = `file owner UID ${statSync(path).uid}`;
    } catch {
      try {
        owner = `parent owner UID ${statSync(configDirectory(path)).uid}`;
      } catch {
        // Metadata may be inaccessible too.
      }
    }
    super(
      `Cannot ${operation} config ${path} (${code ?? "I/O error"}; process UID ${process.getuid?.() ?? "unknown"}; ${owner}). Check volume permissions and run setup as the gateway user.`,
    );
  }
}

export function updateUserConfig(env: Env, edit: (doc: Document) => void) {
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
  edit(doc);
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

export function assertConfigCreationAccess(path: string) {
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

export function saveMemoryBackend(
  env: Env,
  selection:
    | { backend: "local" }
    | { backend: "executor"; app: string }
    | { backend: "advanced"; provider: "gemini" | "openai" },
) {
  if (selection.backend === "executor" && !validMemorySlug(selection.app))
    throw new Error("Invalid memory app slug");
  updateUserConfig(env, (doc) => {
    if (!isMap(doc.get("memory", true))) doc.set("memory", doc.createNode({}));
    doc.setIn(["memory", "backend"], selection.backend);
    if (selection.backend === "executor") {
      doc.setIn(["memory", "app"], selection.app);
    } else {
      doc.deleteIn(["memory", "app"]);
    }
    if (selection.backend === "advanced")
      doc.setIn(["memory", "provider"], selection.provider);
    else doc.deleteIn(["memory", "provider"]);
  });
}

/** The tool list this server uses. No list of its own means executor's list. */
function toolListSource(config: HarnessConfig, server?: string) {
  const named = server ? config.mcpServers[server] : undefined;
  return named?.ownTools ? named : config.mcpServers.executor;
}

/**
 * Executor decides approval for itself and for any server that inherits its
 * tool list. A server with its own `tools` list keeps the local write gate.
 */
export function executorDecidesApproval(
  config: HarnessConfig,
  server?: string,
) {
  const source = toolListSource(config, server);
  return !!source && source === config.mcpServers.executor;
}

/** Lists for one MCP server. A server with no `tools` of its own uses executor's. */
export function mcpServerPolicy(config: HarnessConfig, server?: string) {
  const named = server ? config.mcpServers[server] : undefined;
  const source = toolListSource(config, server);
  return {
    read: source?.read ?? [],
    write: source?.write ?? [],
    trusted: named?.trust === "trusted",
  };
}

function stamp(path: string) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function readDocument(
  path: string,
  userFile = false,
): {
  doc: Record<string, unknown>;
  problem?: string;
  missing?: boolean;
} {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { doc: {}, missing: true };
    if (userFile) throw new HarnessConfigAccessError(path, "read", code);
    return {
      doc: {},
      problem: code === "EISDIR" ? "not a file" : "unreadable",
    };
  }
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { doc: {}, problem: message.split("\n")[0]?.slice(0, 240) };
  }
  if (parsed === null || parsed === undefined) return { doc: {} };
  const problem = schemaProblem(parsed);
  if (problem) return { doc: {}, problem };
  return { doc: parsed as Record<string, unknown> };
}

/** Loads defaults and the user file. Malformed YAML is logged once. */
export function loadHarnessConfig(env: Env = process.env): HarnessConfig {
  const defaults = defaultsPath();
  const user = userConfigPath(env);
  const key = `${defaults}|${stamp(defaults)}|${user}|${stamp(user)}`;
  if (cache?.key === key) return cache.config;
  const base = readDocument(defaults);
  const over = readDocument(user, true);
  if (base.missing)
    console.error(
      `Pi-Agent: config.default.yaml missing (${defaults}). No classification or job defaults are available.`,
    );
  else if (base.problem)
    console.error(
      `Pi-Agent: config.default.yaml is invalid (${base.problem}). No classification or job defaults are available.`,
    );
  if (!over.missing && over.problem)
    console.error(
      `Pi-Agent: ${user} is invalid (${over.problem}). Using config.default.yaml.`,
    );
  const usableBase = base.problem || base.missing ? {} : base.doc;
  const usableUser = over.problem || over.missing ? {} : over.doc;
  const merged = merge(usableBase, usableUser);
  const config = isRecord(merged)
    ? configFrom(
        merged,
        over.problem
          ? { enabled: false }
          : memoryFrom(merged.memory, usableUser),
      )
    : EMPTY;
  cache = { key, config };
  return config;
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth 2.1 authorization-code + PKCE (S256) for a remote MCP with no API key
 * and no client secret. The verifier stays in the credentials row. The operator
 * pastes the redirect URL back; nothing listens on it. New logins use
 * http://127.0.0.1:33418/callback (the public MCP example). Port 80 is still
 * recognized so an in-flight paste is not dropped. ChatGPT/Codex login is separate.
 */
export const UPSY_SERVER_NAME = "upsy";
export const UPSY_MCP_URL = "https://upsy.ai/connect";
export const UPSY_OAUTH_CREDENTIAL = "mcp-upsy";
export const MCP_OAUTH_REDIRECT_URI = "http://127.0.0.1:33418/callback";
const LEGACY_REDIRECT_URI = "http://127.0.0.1/callback";
export const UPSY_OAUTH_PROFILE = {
  name: "Upsy",
  resource: UPSY_MCP_URL,
  redirectUri: MCP_OAUTH_REDIRECT_URI,
};

const PENDING_MS = 15 * 60 * 1000;
const CLIENT_NAME = "pi-bot";
const NOT_WAITING = "That URL is not the sign-in this bot is waiting for.";
const EXCHANGE_FAILED =
  "Sign-in failed. Open the latest link and paste the redirect URL again.";
const COULD_NOT_START = "MCP sign-in could not start.";

export class McpOauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOauthError";
  }
}

export interface McpOauthCredential {
  type: "oauth";
  access?: string;
  refresh?: string;
  expires?: number;
  clientId?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  resource?: string;
  redirectUri?: string;
  pending?: { state: string; verifier: string; createdAt: number };
  refreshNotice?: boolean;
  notifiedPending?: number;
}

export interface OauthVault {
  read(provider: string): McpOauthCredential | undefined;
  write(provider: string, credential: McpOauthCredential): void;
}

type FetchImpl = typeof fetch;
type Random = (size: number) => Buffer;

const TEXT_KEYS = [
  "access",
  "refresh",
  "clientId",
  "authorizationEndpoint",
  "tokenEndpoint",
  "resource",
  "redirectUri",
] as const;

const CLIENT_KEYS = TEXT_KEYS.filter(
  (key) => key !== "access" && key !== "refresh",
);

const chains = new Map<string, Promise<unknown>>();

function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  chains.set(key, run);
  return run;
}

function singleLine(value: unknown) {
  return typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value)
    ? value
    : undefined;
}

function sameHttps(left: string, right: string) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const path = (url: URL) => url.pathname.replace(/\/$/, "") || "/";
    return (
      a.protocol === b.protocol && a.host === b.host && path(a) === path(b)
    );
  } catch {
    return false;
  }
}

function httpsUrl(value: unknown) {
  const text = singleLine(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function startError(): never {
  throw new McpOauthError(COULD_NOT_START);
}

function parseOauthCredential(
  value: string | undefined,
): McpOauthCredential | undefined {
  let row: Record<string, unknown>;
  try {
    const parsed = value ? JSON.parse(value) : undefined;
    if (!parsed || typeof parsed !== "object") return undefined;
    row = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (row.type !== "oauth") return undefined;
  const credential: McpOauthCredential = { type: "oauth" };
  for (const key of TEXT_KEYS) {
    const item = singleLine(row[key]);
    if (item) credential[key] = item;
  }
  if (typeof row.expires === "number" && Number.isFinite(row.expires))
    credential.expires = row.expires;
  if (row.refreshNotice === true) credential.refreshNotice = true;
  if (typeof row.notifiedPending === "number")
    credential.notifiedPending = row.notifiedPending;
  const pending = row.pending;
  if (pending && typeof pending === "object") {
    const item = pending as Record<string, unknown>;
    const state = singleLine(item.state);
    const verifier = singleLine(item.verifier);
    if (state && verifier && typeof item.createdAt === "number")
      credential.pending = { state, verifier, createdAt: item.createdAt };
  }
  return credential;
}

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
}

export function readOauthCredential(db: Sqlite, provider: string) {
  try {
    const row = db
      .prepare("SELECT value FROM credentials WHERE provider=?")
      .get(provider) as { value?: string } | undefined;
    return parseOauthCredential(row?.value);
  } catch {
    return undefined;
  }
}

export function writeOauthCredential(
  db: Sqlite,
  provider: string,
  credential: McpOauthCredential,
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT)",
  );
  db.prepare(
    "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
  ).run(provider, JSON.stringify(credential));
}

export function vaultFromStore(store: {
  get<T>(sql: string, ...args: (string | number | null)[]): T | undefined;
  run(sql: string, ...args: (string | number | null)[]): unknown;
}): OauthVault {
  return {
    read(provider) {
      const row = store.get<{ value: string }>(
        "SELECT value FROM credentials WHERE provider=?",
        provider,
      );
      return parseOauthCredential(row?.value);
    },
    write(provider, credential) {
      store.run(
        "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
        provider,
        JSON.stringify(credential),
      );
    },
  };
}

function clientFields(
  source: McpOauthCredential,
  dropClient = false,
): McpOauthCredential {
  const next: McpOauthCredential = { type: "oauth" };
  for (const key of CLIENT_KEYS)
    if (!(dropClient && key === "clientId") && source[key])
      next[key] = source[key];
  return next;
}

function loginShell(source: McpOauthCredential, dropClient = false) {
  const next = clientFields(source, dropClient);
  if (source.pending) next.pending = source.pending;
  if (source.notifiedPending !== undefined)
    next.notifiedPending = source.notifiedPending;
  return next;
}

function withTokens(
  credential: McpOauthCredential,
  tokens: { access: string; refresh?: string; expiresIn?: number },
  now: number,
): McpOauthCredential {
  return {
    ...clientFields(credential),
    access: tokens.access,
    refresh: tokens.refresh ?? credential.refresh,
    expires: now + (tokens.expiresIn ?? 60) * 1000,
  };
}

function authorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
}) {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("resource", input.resource);
  return url.href;
}

function bounded(value: string, max: number) {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/\s/.test(trimmed) ? trimmed : "";
}

function isCallback(url: URL) {
  const here = `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  return [MCP_OAUTH_REDIRECT_URI, LEGACY_REDIRECT_URI].some((redirect) => {
    const expected = new URL(redirect);
    const there = `${expected.protocol}//${expected.host}${expected.pathname.replace(/\/$/, "")}`;
    return here === there;
  });
}

type Pasted = { code?: string; state: string; callback: boolean; iss?: string };

function parsePastedRedirect(text: string): Pasted | undefined {
  const found: Pasted[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let url: URL;
    try {
      url = new URL(match[0].replace(/[.,);]+$/, ""));
    } catch {
      continue;
    }
    const state = bounded(url.searchParams.get("state") ?? "", 256);
    const code = bounded(url.searchParams.get("code") ?? "", 512);
    const error = bounded(url.searchParams.get("error") ?? "", 64);
    if (!state || (!code && !error)) continue;
    const iss = bounded(url.searchParams.get("iss") ?? "", 256);
    found.push({
      state,
      callback: isCallback(url),
      ...(code ? { code } : {}),
      ...(iss ? { iss } : {}),
    });
  }
  return (
    found.find((item) => item.code && item.callback) ??
    found.find((item) => item.code) ??
    found.find((item) => item.callback) ??
    found[0]
  );
}

function oauthStateMatches(
  expected: string | undefined,
  actual: string | undefined,
) {
  if (!expected || !actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function accessTokenFresh(
  credential: McpOauthCredential | undefined,
  now: number,
  skewMs = 60_000,
) {
  return Boolean(
    credential?.access &&
    typeof credential.expires === "number" &&
    credential.expires - skewMs > now,
  );
}

function oauthLoginNotice(
  name: string,
  url: string,
  where: "chat" | "terminal",
) {
  const back =
    where === "chat"
      ? "paste the final browser URL back in this chat"
      : "paste the final browser URL here";
  return `${name} sign-in. Open this link, sign in, and ${back}. The page can fail to load; paste the address anyway.\n${url}`;
}

function pendingAuthorizationUrl(
  credential: McpOauthCredential | undefined,
  now: number,
) {
  const pending = credential?.pending;
  const authorizationEndpoint = httpsUrl(credential?.authorizationEndpoint);
  if (
    !pending ||
    !authorizationEndpoint ||
    !credential?.clientId ||
    !credential.redirectUri ||
    !credential.resource ||
    now - pending.createdAt > PENDING_MS
  )
    return undefined;
  return authorizationUrl({
    authorizationEndpoint,
    clientId: credential.clientId,
    redirectUri: credential.redirectUri,
    codeChallenge: createHash("sha256")
      .update(pending.verifier)
      .digest("base64url"),
    state: pending.state,
    resource: credential.resource,
  });
}

function readTokenFields(body: unknown) {
  if (!body || typeof body !== "object") return undefined;
  const row = body as Record<string, unknown>;
  const access = singleLine(row.access_token);
  if (!access) return undefined;
  const raw = row.expires_in;
  const expiresIn = Number(raw);
  const ttl =
    (typeof raw === "number" || typeof raw === "string") &&
    Number.isFinite(expiresIn) &&
    expiresIn > 0
      ? expiresIn
      : undefined;
  const refresh = singleLine(row.refresh_token);
  return {
    access,
    ...(refresh ? { refresh } : {}),
    ...(ttl ? { expiresIn: ttl } : {}),
  };
}

async function readJson(url: string, fetchImpl: FetchImpl) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  }).catch(() => undefined);
  if (!response) return undefined;
  const final = response.url || url;
  let same = false;
  try {
    same =
      final.startsWith("https://") &&
      new URL(final).origin === new URL(url).origin;
  } catch {
    same = false;
  }
  if (!response.ok || !same) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return response.json().catch(() => undefined);
}

function wellKnown(kind: string, resource: string) {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/${kind}${path}`;
}

async function discoverMcpOauth(resource: string, fetchImpl: FetchImpl) {
  let doc = await readJson(
    wellKnown("oauth-protected-resource", resource),
    fetchImpl,
  );
  if (!doc || typeof doc !== "object") {
    let probe: Response;
    try {
      probe = await fetchImpl(resource, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      startError();
    }
    const link = httpsUrl(
      /resource_metadata="([^"]+)"/i.exec(
        probe.headers.get("www-authenticate") ?? "",
      )?.[1],
    );
    await probe.body?.cancel().catch(() => undefined);
    doc = link ? await readJson(link, fetchImpl) : undefined;
    if (!doc || typeof doc !== "object") startError();
  }
  const metadata = doc as {
    resource?: unknown;
    authorization_servers?: unknown[];
  };
  const published = httpsUrl(metadata.resource);
  // RFC 9728: a published resource identifier must be the one we asked for.
  if (published && !sameHttps(published, resource)) startError();
  const issuer = httpsUrl(metadata.authorization_servers?.[0]);
  if (!issuer) startError();
  const as = (await readJson(
    wellKnown("oauth-authorization-server", issuer),
    fetchImpl,
  )) as Record<string, unknown> | undefined;
  const publishedIssuer = httpsUrl(as?.issuer);
  // RFC 8414: issuer in the metadata must be the issuer we fetched.
  if (!publishedIssuer || !sameHttps(publishedIssuer, issuer)) startError();
  const authorizationEndpoint = httpsUrl(as?.authorization_endpoint);
  const tokenEndpoint = httpsUrl(as?.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) startError();
  const methods = as?.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256"))
    throw new McpOauthError("This MCP server does not offer PKCE S256.");
  const authMethods = as?.token_endpoint_auth_methods_supported;
  if (Array.isArray(authMethods) && !authMethods.includes("none"))
    throw new McpOauthError("This MCP server requires a client secret.");
  const registrationEndpoint = httpsUrl(as?.registration_endpoint);
  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    resource: httpsUrl(metadata.resource) ?? resource,
  };
}

async function registerPublicClient(
  endpoint: string,
  redirectUri: string,
  fetchImpl: FetchImpl,
) {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new McpOauthError("MCP client registration failed.");
  }
  const body = await response.json().catch(() => undefined);
  const clientId =
    response.ok && body && typeof body === "object"
      ? singleLine((body as { client_id?: unknown }).client_id)
      : undefined;
  if (!clientId) throw new McpOauthError("MCP client registration failed.");
  return clientId;
}

async function postForm(
  url: string,
  body: URLSearchParams,
  fetchImpl: FetchImpl,
) {
  if (!httpsUrl(url)) startError();
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: response.status,
    ok: response.ok,
    json: await response.json().catch(() => undefined),
  };
}

function rejected(error: string | undefined) {
  return (
    !error ||
    error === "invalid_grant" ||
    error === "invalid_token" ||
    error === "invalid_client"
  );
}

export async function refreshOauthCredential(
  credential: McpOauthCredential,
  fetchImpl: FetchImpl,
  now = Date.now(),
): Promise<
  | { ok: true; credential: McpOauthCredential }
  | { ok: false; invalid: boolean; dropClient?: boolean }
> {
  const tokenEndpoint = httpsUrl(credential.tokenEndpoint);
  if (!credential.refresh || !tokenEndpoint || !credential.clientId)
    return { ok: false, invalid: true };
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refresh,
    client_id: credential.clientId,
  });
  if (credential.resource) body.set("resource", credential.resource);
  let result: { status: number; ok: boolean; json: unknown };
  try {
    result = await postForm(tokenEndpoint, body, fetchImpl);
  } catch {
    return { ok: false, invalid: false };
  }
  if (result.status === 400 || result.status === 401) {
    const error =
      result.json && typeof result.json === "object"
        ? singleLine((result.json as { error?: unknown }).error)
        : undefined;
    return {
      ok: false,
      invalid: rejected(error),
      ...(error === "invalid_client" ? { dropClient: true } : {}),
    };
  }
  const tokens = result.ok ? readTokenFields(result.json) : undefined;
  if (!tokens) return { ok: false, invalid: false };
  return { ok: true, credential: withTokens(credential, tokens, now) };
}

export async function beginMcpOauthLogin(input: {
  resource: string;
  redirectUri: string;
  existing?: McpOauthCredential;
  fetchImpl?: FetchImpl;
  now?: number;
  random?: Random;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now();
  const reused = pendingAuthorizationUrl(input.existing, now);
  if (input.existing && reused)
    return { credential: input.existing, url: reused };
  const endpoints = await discoverMcpOauth(input.resource, fetchImpl);
  let clientId = input.existing?.clientId;
  if (
    !clientId ||
    input.existing?.tokenEndpoint !== endpoints.tokenEndpoint ||
    input.existing?.redirectUri !== input.redirectUri
  ) {
    if (!endpoints.registrationEndpoint)
      throw new McpOauthError(
        "This MCP server has no dynamic client registration.",
      );
    clientId = await registerPublicClient(
      endpoints.registrationEndpoint,
      input.redirectUri,
      fetchImpl,
    );
  }
  const random = input.random ?? randomBytes;
  const verifier = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = random(16).toString("base64url");
  const credential: McpOauthCredential = {
    type: "oauth",
    clientId,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
    resource: endpoints.resource,
    redirectUri: input.redirectUri,
    pending: { state, verifier, createdAt: now },
  };
  return {
    credential,
    url: authorizationUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId,
      redirectUri: input.redirectUri,
      codeChallenge: challenge,
      state,
      resource: endpoints.resource,
    }),
  };
}

function pasteFailed(message: string) {
  return { ok: false as const, message };
}

export async function completeOauthPaste(
  credential: McpOauthCredential,
  text: string,
  fetchImpl: FetchImpl = fetch,
  now = Date.now(),
): Promise<
  { ok: true; credential: McpOauthCredential } | { ok: false; message: string }
> {
  const parsed = parsePastedRedirect(text);
  if (!parsed)
    return pasteFailed(
      "Paste the full redirect URL, including code and state.",
    );
  if (
    !credential.pending ||
    !oauthStateMatches(credential.pending.state, parsed.state)
  )
    return pasteFailed(NOT_WAITING);
  if (!parsed.code)
    return pasteFailed(
      "Sign-in was declined. Open the latest link to try again.",
    );
  const tokenEndpoint = httpsUrl(credential.tokenEndpoint);
  if (parsed.iss) {
    let origin = "";
    try {
      origin = new URL(parsed.iss).origin;
    } catch {
      origin = "";
    }
    if (!tokenEndpoint || origin !== new URL(tokenEndpoint).origin)
      return pasteFailed(NOT_WAITING);
  }
  if (
    !tokenEndpoint ||
    !credential.clientId ||
    !credential.redirectUri ||
    !credential.resource
  )
    return pasteFailed("Sign-in expired. Start it again.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: parsed.code,
    redirect_uri: credential.redirectUri,
    client_id: credential.clientId,
    code_verifier: credential.pending.verifier,
    resource: credential.resource,
  });
  try {
    const result = await postForm(tokenEndpoint, body, fetchImpl);
    const tokens = result.ok ? readTokenFields(result.json) : undefined;
    if (!tokens) return pasteFailed(EXCHANGE_FAILED);
    return { ok: true, credential: withTokens(credential, tokens, now) };
  } catch {
    return pasteFailed(EXCHANGE_FAILED);
  }
}

export async function acceptStoredOauthPaste(
  vault: OauthVault,
  provider: string,
  text: string,
  fetchImpl?: FetchImpl,
): Promise<{ handled: true; message: string } | { handled: false }> {
  const parsed = parsePastedRedirect(text);
  if (!parsed) return { handled: false };
  return exclusive(provider, async () => {
    const current = vault.read(provider);
    if (!current?.pending)
      return parsed.callback
        ? { handled: true as const, message: NOT_WAITING }
        : { handled: false as const };
    const done = await completeOauthPaste(current, text, fetchImpl ?? fetch);
    if (!done.ok) return { handled: true as const, message: done.message };
    vault.write(provider, done.credential);
    return { handled: true as const, message: "Upsy is signed in." };
  });
}

export async function promptMcpOauthLogin(
  profile: { name: string; resource: string; redirectUri: string },
  io: {
    log: (line: string) => void;
    ask: (prompt: string) => Promise<string>;
    save: (credential: McpOauthCredential) => void;
  },
  existing?: McpOauthCredential,
  fetchImpl: FetchImpl = fetch,
) {
  if (existing?.refresh) {
    const answer = (
      await io.ask(
        `${profile.name} is signed in. Press Enter to keep it, or type login to sign in again: `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer !== "login") return "kept" as const;
  }
  const started = await beginMcpOauthLogin({
    resource: profile.resource,
    redirectUri: profile.redirectUri,
    existing,
    fetchImpl,
  });
  const pending = existing
    ? { ...existing, ...started.credential }
    : started.credential;
  io.save(pending);
  io.log(oauthLoginNotice(profile.name, started.url, "terminal"));
  const done = await completeOauthPaste(
    pending,
    await io.ask("Paste the final browser URL: "),
    fetchImpl,
  );
  if (!done.ok) throw new McpOauthError(done.message);
  io.save(done.credential);
  io.log(`${profile.name} is signed in.`);
  return "signed-in" as const;
}

export async function ensureMcpOauthAccess(input: {
  vault: OauthVault;
  provider: string;
  resource: string;
  redirectUri: string;
  name: string;
  fetchImpl?: FetchImpl;
  now?: number;
  notify: (text: string, id: string) => void;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now();
  return exclusive(input.provider, async () => {
    let current = input.vault.read(input.provider) ?? {
      type: "oauth" as const,
    };
    if (accessTokenFresh(current, now) && current.access) return current.access;
    if (
      current.refresh &&
      httpsUrl(current.tokenEndpoint) &&
      current.clientId
    ) {
      const refreshed = await refreshOauthCredential(current, fetchImpl, now);
      if (refreshed.ok && refreshed.credential.access) {
        input.vault.write(input.provider, refreshed.credential);
        return refreshed.credential.access;
      }
      if (!refreshed.ok && !refreshed.invalid) {
        if (current.access && (current.expires ?? 0) > now)
          return current.access;
        if (!current.refreshNotice) {
          input.notify(
            `${input.name} could not refresh its sign-in. Sign in again: npm run setup, then choose ${input.name}.`,
            `refresh-${now}`,
          );
          input.vault.write(input.provider, {
            ...current,
            refreshNotice: true,
          });
        }
        throw new McpOauthError("MCP sign-in could not be refreshed.");
      }
      if (!refreshed.ok) {
        current = loginShell(current, refreshed.dropClient);
        input.vault.write(input.provider, current);
      }
    }
    let credential = loginShell(current);
    let url = pendingAuthorizationUrl(credential, now);
    if (!url) {
      const started = await beginMcpOauthLogin({
        resource: input.resource,
        redirectUri: input.redirectUri,
        existing: credential,
        fetchImpl,
        now,
      });
      credential = started.credential;
      url = started.url;
    }
    const created = credential.pending?.createdAt;
    if (created !== undefined && credential.notifiedPending !== created) {
      input.notify(oauthLoginNotice(input.name, url, "chat"), String(created));
      credential = { ...credential, notifiedPending: created };
    }
    input.vault.write(input.provider, credential);
    throw new McpOauthError(
      "MCP sign-in is waiting. Open the link and paste the final browser URL.",
    );
  });
}

export function withOauthBearer<T extends { name: string; url?: string }>(
  servers: T[],
  vault: OauthVault,
  notify: (text: string, id: string) => void,
  fetchImpl?: FetchImpl,
): Array<T & { resolveToken?: () => Promise<string> }> {
  return servers.map((server) => {
    if (server.name !== UPSY_SERVER_NAME || server.url !== UPSY_MCP_URL)
      return server;
    return {
      ...server,
      resolveToken: () =>
        ensureMcpOauthAccess({
          vault,
          provider: UPSY_OAUTH_CREDENTIAL,
          resource: UPSY_MCP_URL,
          redirectUri: MCP_OAUTH_REDIRECT_URI,
          name: "Upsy",
          fetchImpl,
          notify,
        }),
    };
  });
}

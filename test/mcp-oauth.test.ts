import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mcpServersFromAggregators, readConfig } from "../src/config.js";
import {
  EXECUTOR_MCP_URL,
  EXECUTOR_OAUTH_CREDENTIAL,
  EXECUTOR_OAUTH_PROFILE,
  MCP_OAUTH_REDIRECT_URI,
  UPSY_MCP_URL,
  UPSY_OAUTH_CREDENTIAL,
  UPSY_OAUTH_PROFILE,
  acceptStoredOauthPaste,
  beginMcpOauthLogin,
  completeOauthPaste,
  ensureMcpOauthAccess,
  promptMcpOauthLogin,
  refreshOauthCredential,
  withOauthBearer,
  writeOauthCredential,
  type McpOauthCredential,
  type OauthVault,
} from "../src/mcp-oauth.js";
import { McpGateway } from "../src/mcp.js";
import { readStoredAggregators, writeStoredAggregators } from "../src/setup.js";

const NOW = 1_700_000_000_000;
const REDIRECT = MCP_OAUTH_REDIRECT_URI;
const EXECUTOR_ISSUER = "https://executor.sh/api/auth";
const EXECUTOR_AUTH = "https://app.executor.sh/api/auth/oauth2";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function credential(
  extra: Omit<McpOauthCredential, "type"> = {},
): McpOauthCredential {
  return { type: "oauth", ...extra };
}

function discoveryFetch(
  onRequest?: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | undefined,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const handled = onRequest?.(url, init);
    if (handled) return handled;
    if (url.includes("/.well-known/oauth-protected-resource"))
      return jsonResponse(200, {
        resource: UPSY_MCP_URL,
        authorization_servers: ["https://upsy.ai"],
      });
    if (url.includes("/.well-known/oauth-authorization-server"))
      return jsonResponse(200, {
        issuer: "https://upsy.ai",
        authorization_endpoint: "https://upsy.ai/oauth/authorize",
        token_endpoint: "https://upsy.ai/api/oauth/token",
        registration_endpoint: "https://upsy.ai/api/oauth/register",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.endsWith("/api/oauth/register"))
      return jsonResponse(201, { client_id: "cid-1" });
    throw new Error(`unexpected ${url}`);
  };
}

function memoryVault(initial: McpOauthCredential): OauthVault & {
  current: McpOauthCredential;
} {
  const box = { current: initial };
  return {
    get current() {
      return box.current;
    },
    read: () => box.current,
    write: (_provider, next) => {
      box.current = next;
    },
  };
}

const scopedGrant = {
  organization: { id: "org-1", slug: "test", name: "Test" },
  access: { kind: "connection", id: "conn-1", name: "Bot", apps: 1 },
  mode: "model",
};

function executorFetch(grant: unknown = scopedGrant): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, "error");
    if (
      url === "https://mcp.executor.sh/.well-known/oauth-protected-resource/mcp"
    )
      return jsonResponse(200, {
        resource: EXECUTOR_MCP_URL,
        authorization_servers: [EXECUTOR_ISSUER],
        scopes_supported: ["mcp", "offline_access"],
      });
    if (
      url ===
      "https://executor.sh/.well-known/oauth-authorization-server/api/auth"
    )
      return jsonResponse(200, {
        issuer: EXECUTOR_ISSUER,
        authorization_endpoint: EXECUTOR_AUTH + "/authorize",
        token_endpoint: EXECUTOR_AUTH + "/token",
        registration_endpoint: EXECUTOR_AUTH + "/register",
      });
    if (url === EXECUTOR_AUTH + "/register") {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.redirect_uris, [REDIRECT]);
      assert.equal(body.scope, "mcp offline_access");
      return jsonResponse(201, { client_id: "executor-client" });
    }
    if (url === EXECUTOR_AUTH + "/token") {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("resource"), EXECUTOR_MCP_URL);
      return jsonResponse(200, {
        access_token: "executor-access",
        refresh_token: "executor-refresh",
        expires_in: 3600,
      });
    }
    if (url === EXECUTOR_MCP_URL + "/whoami") {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer executor-access",
      );
      return jsonResponse(200, grant);
    }
    assert.fail(`Unexpected request: ${url}`);
  };
}

test("Executor setup sends scope, validates its issuer, and only saves a scoped grant", async () => {
  const saved: McpOauthCredential[] = [];
  let authorize: URL | undefined;
  const result = await promptMcpOauthLogin(
    EXECUTOR_OAUTH_PROFILE,
    {
      log(line) {
        if (line.includes("\nhttps://"))
          authorize = new URL(line.split("\n")[1]);
      },
      ask() {
        assert.ok(authorize);
        assert.equal(
          authorize.origin + authorize.pathname,
          EXECUTOR_AUTH + "/authorize",
        );
        assert.equal(authorize.searchParams.get("scope"), "mcp offline_access");
        assert.equal(
          authorize.searchParams.get("code_challenge_method"),
          "S256",
        );
        return Promise.resolve(
          `${REDIRECT}?code=ok&state=${authorize.searchParams.get("state")}&iss=${encodeURIComponent(EXECUTOR_ISSUER)}`,
        );
      },
      save(value) {
        saved.push(value);
      },
    },
    undefined,
    executorFetch(),
  );
  assert.equal(result, "signed-in");
  assert.equal(saved[0].access, undefined);
  const grant = saved[1];
  assert.equal(grant.connectionId, "conn-1");
  assert.equal(grant.organizationId, "org-1");
  assert.ok(grant.grantBinding);
  const refreshed = await refreshOauthCredential(grant, executorFetch());
  assert.ok(refreshed.ok);
  assert.equal(refreshed.credential.grantBinding, grant.grantBinding);
  const changed = await refreshOauthCredential(
    grant,
    executorFetch({
      ...scopedGrant,
      access: { ...scopedGrant.access, id: "different" },
    }),
  );
  assert.deepEqual(changed, { ok: false, invalid: true });
});

test("Executor rejects a mismatched issuer, full grants, and automatic approvals", async () => {
  const started = await beginMcpOauthLogin({
    ...EXECUTOR_OAUTH_PROFILE,
    fetchImpl: executorFetch(),
  });
  const callback = `${REDIRECT}?code=ok&state=${started.credential.pending?.state}`;
  const wrongIssuer = await completeOauthPaste(
    started.credential,
    callback + "&iss=https://app.executor.sh/api/auth",
    () => assert.fail("Must not exchange a code from a different issuer"),
  );
  assert.equal(wrongIssuer.ok, false);
  for (const grant of [
    { ...scopedGrant, access: { kind: "all" } },
    { ...scopedGrant, mode: "automatic" },
    {},
  ]) {
    const result = await completeOauthPaste(
      started.credential,
      callback,
      executorFetch(grant),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /scoped connection/);
  }
});

test("Executor OAuth wins over saved and environment PATs only in OAuth mode", async () => {
  const env = {
    EXECUTOR_MCP_URL: "https://pat.example/mcp",
    EXECUTOR_TOKEN: "env-pat",
  };
  const stored = {
    record: {
      choice: "executor" as const,
      executor: { url: EXECUTOR_MCP_URL, auth: "oauth" as const },
    },
    executorToken: "saved-pat",
  };
  const vault = memoryVault(credential());
  const [oauth] = withOauthBearer(
    mcpServersFromAggregators(env, stored),
    vault,
    () => {},
    executorFetch(),
  );
  assert.equal(oauth.url, EXECUTOR_MCP_URL);
  assert.equal(oauth.token, undefined);
  await assert.rejects(oauth.resolveToken!(), /sign-in is waiting/);
  assert.deepEqual(
    mcpServersFromAggregators(env, {
      ...stored,
      record: { ...stored.record, choice: "none" },
    }),
    [],
  );
  const gateway = new McpGateway([oauth]);
  const pendingBinding = gateway.credentialBinding("executor");
  vault.write(
    EXECUTOR_OAUTH_CREDENTIAL,
    credential({ grantBinding: "verified-grant" }),
  );
  assert.notEqual(gateway.credentialBinding("executor"), pendingBinding);
  const [pat] = withOauthBearer(
    mcpServersFromAggregators(env, {
      ...stored,
      record: { ...stored.record, executor: { url: EXECUTOR_MCP_URL } },
    }),
    vault,
    () => {},
  );
  assert.equal(pat.url, env.EXECUTOR_MCP_URL);
  assert.equal(pat.token, env.EXECUTOR_TOKEN);
  assert.equal(pat.resolveToken, undefined);
});

test("authorization URL is PKCE S256 on the fixed loopback port and carries no secret", async () => {
  let registration = "";
  const started = await beginMcpOauthLogin({
    resource: UPSY_MCP_URL,
    redirectUri: REDIRECT,
    now: NOW,
    random: (size) => Buffer.alloc(size, size === 32 ? 7 : 3),
    fetchImpl: discoveryFetch((url, init) => {
      assert.equal(init?.redirect, "error");
      if (url.endsWith("/api/oauth/register")) {
        registration = String(init?.body ?? "");
        return jsonResponse(201, { client_id: "cid-1" });
      }
      return undefined;
    }),
  });
  const posted = JSON.parse(registration) as {
    redirect_uris: string[];
    token_endpoint_auth_method: string;
    client_name: string;
  };
  assert.deepEqual(posted.redirect_uris, [REDIRECT]);
  assert.equal(posted.token_endpoint_auth_method, "none");
  assert.equal(posted.client_name, "pi-bot");
  assert.equal("client_secret" in posted, false);
  const url = new URL(started.url);
  const verifier = started.credential.pending?.verifier ?? "";
  assert.equal(url.origin + url.pathname, "https://upsy.ai/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "cid-1");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), UPSY_MCP_URL);
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal(url.searchParams.has("code_verifier"), false);
  assert.equal(started.url.includes(verifier), false);
  assert.equal(REDIRECT, "http://127.0.0.1:33418/callback");
});

test("a pasted callback yields code and state, and does not echo a mismatched code", async () => {
  const pending = credential({
    pending: { state: "expected", verifier: "verifier", createdAt: NOW },
    tokenEndpoint: "https://upsy.ai/api/oauth/token",
    clientId: "client-1",
    redirectUri: REDIRECT,
    resource: UPSY_MCP_URL,
  });
  const mismatch = await completeOauthPaste(
    pending,
    "the page failed, see https://upsy.ai/home and then http://127.0.0.1:33418/callback?code=SECRETCODE&state=other.",
    () => {
      throw new Error("token endpoint must not be called");
    },
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok)
    assert.equal(mismatch.message.includes("SECRETCODE"), false);
  const missing = await completeOauthPaste(
    pending,
    "http://127.0.0.1:33418/callback?code=c1",
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /code and state/);
  const fragment = await completeOauthPaste(
    pending,
    "http://127.0.0.1:33418/callback#code=c1&state=expected",
  );
  assert.equal(fragment.ok, false);
  let exchanged = "";
  const ok = await completeOauthPaste(
    pending,
    "notes https://example.com/docs http://127.0.0.1:33418/callback?state=expected&code=c1&iss=https://upsy.ai",
    async (_url, init) => {
      exchanged = String(init?.body ?? "");
      assert.equal(init?.redirect, "error");
      return jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 900,
      });
    },
    NOW,
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.credential.access, "access-1");
    assert.equal(ok.credential.pending, undefined);
  }
  const params = new URLSearchParams(exchanged);
  assert.equal(params.get("code"), "c1");
  assert.equal(params.get("code_verifier"), "verifier");
  assert.equal(params.has("client_secret"), false);
  const wrongIssuer = await completeOauthPaste(
    pending,
    `${REDIRECT}?code=SECRETCODE&state=expected&iss=https://evil.example`,
    () => {
      throw new Error("token endpoint must not be called");
    },
  );
  assert.equal(wrongIssuer.ok, false);
  if (!wrongIssuer.ok)
    assert.equal(wrongIssuer.message.includes("SECRETCODE"), false);
});

test("a loopback callback is not forwarded when no login is waiting", async () => {
  const vault = memoryVault(credential({ refresh: "refresh-secret" }));
  const idle = await acceptStoredOauthPaste(
    vault,
    UPSY_OAUTH_CREDENTIAL,
    `${REDIRECT}?code=SECRETCODE&state=stale`,
    () => {
      throw new Error("token endpoint must not be called");
    },
  );
  assert.equal(idle.handled, true);
  if (idle.handled) assert.equal(idle.message.includes("SECRETCODE"), false);
  assert.equal(vault.current.refresh, "refresh-secret");
  const ordinary = await acceptStoredOauthPaste(
    vault,
    UPSY_OAUTH_CREDENTIAL,
    "https://example.com/app?code=abc&state=xyz",
  );
  assert.deepEqual(ordinary, { handled: false });
});

test("token refresh exchanges the refresh token and does not follow a redirect", async () => {
  const logs: string[] = [];
  const write = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    let body = "";
    const result = await refreshOauthCredential(
      credential({
        access: "old-access-secret",
        refresh: "refresh-secret",
        expires: NOW,
        clientId: "client-1",
        tokenEndpoint: "https://upsy.ai/api/oauth/token",
        resource: UPSY_MCP_URL,
      }),
      async (_url, init) => {
        body = String(init?.body ?? "");
        assert.equal(init?.redirect, "error");
        return jsonResponse(200, {
          access_token: "new-access-secret",
          refresh_token: "next-refresh-secret",
          expires_in: "900",
        });
      },
      NOW,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.credential.access, "new-access-secret");
      assert.equal(result.credential.refresh, "next-refresh-secret");
      assert.equal(result.credential.expires, NOW + 900_000);
      assert.equal(result.credential.pending, undefined);
    }
    const params = new URLSearchParams(body);
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(params.get("refresh_token"), "refresh-secret");
    assert.equal(params.get("client_id"), "client-1");
    assert.equal(params.has("client_secret"), false);
    assert.equal(
      logs.some((line) => /access-secret|refresh-secret/.test(line)),
      false,
    );
    const rejected = await refreshOauthCredential(
      credential({
        refresh: "refresh-secret",
        clientId: "client-1",
        tokenEndpoint: "https://upsy.ai/api/oauth/token",
      }),
      async () => jsonResponse(400, { error: "invalid_grant" }),
    );
    assert.deepEqual(rejected, { ok: false, invalid: true });
    const kept = await refreshOauthCredential(
      credential({
        refresh: "refresh-secret",
        clientId: "client-1",
        tokenEndpoint: "https://upsy.ai/api/oauth/token",
      }),
      async () => jsonResponse(400, { error: "invalid_request" }),
    );
    assert.deepEqual(kept, { ok: false, invalid: false });
  } finally {
    console.log = write;
  }
});

test("a rejected refresh is dropped once, and a blip keeps the refresh token", async () => {
  const notices: string[] = [];
  const vault = memoryVault(
    credential({
      access: "old-access-secret",
      refresh: "refresh-secret",
      expires: NOW - 120_000,
      clientId: "cid-old",
      tokenEndpoint: "https://upsy.ai/api/oauth/token",
      redirectUri: "http://127.0.0.1/callback",
      resource: UPSY_MCP_URL,
    }),
  );
  let registrations = 0;
  const fetchImpl = discoveryFetch((url, init) => {
    const body = String(init?.body ?? "");
    if (body.includes("grant_type=refresh_token"))
      return jsonResponse(400, { error: "invalid_grant" });
    if (url.endsWith("/api/oauth/register")) {
      registrations += 1;
      return jsonResponse(201, { client_id: "cid-1" });
    }
    return undefined;
  });
  const access = () =>
    ensureMcpOauthAccess({
      vault,
      provider: UPSY_OAUTH_CREDENTIAL,
      resource: UPSY_MCP_URL,
      redirectUri: REDIRECT,
      name: "Upsy",
      fetchImpl,
      now: NOW,
      notify: (text) => notices.push(text),
    });
  await assert.rejects(access, /MCP sign-in is waiting/);
  assert.equal(notices.length, 1);
  assert.match(
    notices[0],
    /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A33418%2Fcallback/,
  );
  assert.match(notices[0], /client_id=cid-1/);
  assert.equal(notices[0].includes("cid-old"), false);
  assert.equal(notices[0].includes("refresh-secret"), false);
  assert.equal(notices[0].includes("old-access-secret"), false);
  assert.equal(vault.current.refresh, undefined);
  assert.equal(vault.current.redirectUri, REDIRECT);
  assert.equal(registrations, 1);
  await assert.rejects(access, /MCP sign-in is waiting/);
  assert.equal(notices.length, 1);
  assert.equal(registrations, 1);
  const down = memoryVault(
    credential({
      access: "old-access-secret",
      refresh: "refresh-secret",
      expires: NOW - 120_000,
      clientId: "cid-old",
      tokenEndpoint: "https://upsy.ai/api/oauth/token",
      resource: UPSY_MCP_URL,
    }),
  );
  const downNotices: string[] = [];
  const again = () =>
    ensureMcpOauthAccess({
      vault: down,
      provider: UPSY_OAUTH_CREDENTIAL,
      resource: UPSY_MCP_URL,
      redirectUri: REDIRECT,
      name: "Upsy",
      fetchImpl: async () => {
        throw new Error("network");
      },
      now: NOW,
      notify: (text) => downNotices.push(text),
    });
  await assert.rejects(again, /could not be refreshed/);
  assert.equal(downNotices.length, 1);
  assert.equal(downNotices[0].includes("refresh-secret"), false);
  assert.equal(down.current.refresh, "refresh-secret");
  assert.equal(down.current.refreshNotice, true);
  await assert.rejects(again, /could not be refreshed/);
  assert.equal(downNotices.length, 1);

  const blip = memoryVault(
    credential({
      access: "still-good",
      refresh: "refresh-secret",
      expires: NOW + 30_000,
      clientId: "cid-old",
      tokenEndpoint: "https://upsy.ai/api/oauth/token",
      resource: UPSY_MCP_URL,
    }),
  );
  const blipNotices: string[] = [];
  const token = await ensureMcpOauthAccess({
    vault: blip,
    provider: UPSY_OAUTH_CREDENTIAL,
    resource: UPSY_MCP_URL,
    redirectUri: REDIRECT,
    name: "Upsy",
    fetchImpl: async () => {
      throw new Error("network");
    },
    now: NOW,
    notify: (text) => blipNotices.push(text),
  });
  assert.equal(token, "still-good");
  assert.equal(blip.current.refresh, "refresh-secret");
  assert.equal(blipNotices.length, 0);
});

test("a failed re-login keeps the stored refresh token", async () => {
  const existing = credential({
    access: "access-secret",
    refresh: "refresh-secret",
    expires: Date.now() + 10 * 60_000,
    clientId: "cid",
    authorizationEndpoint: "https://upsy.ai/oauth/authorize",
    tokenEndpoint: "https://upsy.ai/api/oauth/token",
    resource: UPSY_MCP_URL,
    redirectUri: REDIRECT,
    pending: {
      state: "expected",
      verifier: "verifier-secret",
      createdAt: Date.now(),
    },
  });
  let stored = existing;
  const logs: string[] = [];
  await assert.rejects(
    () =>
      promptMcpOauthLogin(
        UPSY_OAUTH_PROFILE,
        {
          log: (line) => logs.push(line),
          ask: async (prompt) =>
            prompt.includes("keep it")
              ? "login"
              : `${REDIRECT}?code=SECRETCODE&state=other`,
          save: (next) => {
            stored = next;
          },
        },
        existing,
        () => {
          throw new Error("token endpoint must not be called");
        },
      ),
    /not the sign-in/,
  );
  assert.equal(stored.refresh, "refresh-secret");
  assert.equal(stored.pending?.state, "expected");
  assert.equal(
    logs.some((line) => /SECRETCODE|refresh-secret|verifier-secret/.test(line)),
    false,
  );
});

test("Upsy on the volume is listed like the other MCP servers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-upsy-"));
  try {
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    try {
      writeStoredAggregators(db, { choice: "upsy" });
      writeOauthCredential(
        db,
        UPSY_OAUTH_CREDENTIAL,
        credential({
          access: "access-secret",
          refresh: "refresh-secret",
          expires: Date.now() + 10 * 60_000,
          clientId: "cid",
          tokenEndpoint: "https://upsy.ai/api/oauth/token",
          resource: UPSY_MCP_URL,
        }),
      );
    } finally {
      db.close();
    }
    const stored = readStoredAggregators(dir);
    assert.equal(stored.record?.choice, "upsy");
    assert.equal(stored.upsy?.access, "access-secret");
    const meta = new DatabaseSync(join(dir, "app.sqlite"), { readOnly: true });
    try {
      const row = meta
        .prepare("SELECT value FROM meta WHERE key='aggregators:live'")
        .get() as { value: string };
      assert.equal(row.value.includes("access-secret"), false);
      assert.equal(row.value.includes("refresh-secret"), false);
    } finally {
      meta.close();
    }
    const server = readConfig(
      { TELEGRAM_BOT_TOKEN: "123:mock", TELEGRAM_ALLOWED_USERS: "42" },
      stored,
    ).mcp[0];
    assert.equal(server?.name, "upsy");
    assert.equal(server?.url, UPSY_MCP_URL);
    assert.equal(server?.token, undefined);
    assert.equal(server?.mode, "direct");
    const vault: OauthVault = {
      read: () => credential({ access: "access-secret" }),
      write: () => {},
    };
    const [bound] = withOauthBearer([server!], vault, () => {});
    assert.equal(typeof bound.resolveToken, "function");
    const [other] = withOauthBearer(
      [{ ...server!, url: "https://evil.example/mcp" }],
      vault,
      () => {},
    );
    assert.equal(other.resolveToken, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovery rejects a resource or issuer that does not match the request", async () => {
  const login = (onRequest: Parameters<typeof discoveryFetch>[0]) =>
    beginMcpOauthLogin({
      resource: UPSY_MCP_URL,
      redirectUri: REDIRECT,
      now: NOW,
      fetchImpl: discoveryFetch(onRequest),
    });
  await assert.rejects(
    () =>
      login((url) => {
        if (url.includes("/.well-known/oauth-protected-resource"))
          return jsonResponse(200, {
            resource: "https://evil.example/mcp",
            authorization_servers: ["https://upsy.ai"],
          });
        return undefined;
      }),
    /MCP sign-in could not start/,
  );
  await assert.rejects(
    () =>
      login((url) => {
        if (url.includes("/.well-known/oauth-authorization-server"))
          return jsonResponse(200, {
            issuer: "https://evil.example",
            authorization_endpoint: "https://upsy.ai/oauth/authorize",
            token_endpoint: "https://upsy.ai/api/oauth/token",
            registration_endpoint: "https://upsy.ai/api/oauth/register",
            code_challenge_methods_supported: ["S256"],
          });
        return undefined;
      }),
    /MCP sign-in could not start/,
  );
});

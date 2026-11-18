import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  writePhoneGateway,
  writeStoredSetup,
  writeStoredWhatsapp,
} from "../src/setup.js";
import { Store } from "../src/store.js";
import {
  describeVolumeProvider,
  describeWhatsAppVolume,
  formatWaiting,
  readVolumeSetupFacts,
} from "../src/diagnose-volume.js";

const secret = "super-secret-volume-key";
const oauthSecret = "oauth-secret-value";
const envSecret = "env-secret-value";

async function volume() {
  const dir = await mkdtemp(join(tmpdir(), "pi-diagnose-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  writeStoredSetup(
    db,
    {
      providerId: "openai",
      baseUrl: "https://secret.example/v1?key=hidden",
      modelId: "gpt-test",
      authMode: "chatgpt",
    },
    { chat: secret },
  );
  db.prepare("INSERT INTO credentials VALUES (?,?)").run(
    "openai",
    JSON.stringify({ type: "oauth", access: oauthSecret }),
  );
  db.close();
  return {
    dir,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test("diagnose lê o volume sem imprimir segredo e distingue a fonte", async () => {
  const f = await volume();
  try {
    const stored = readVolumeSetupFacts(f.dir, {});
    const text = describeVolumeProvider(stored).join("\n");
    assert.equal(stored.source, "volume");
    assert.equal(stored.authMode, "chatgpt");
    assert.equal(stored.credentials.llm, true);
    assert.equal(stored.credentials.openai, true);
    assert.equal(stored.credentials["openai-codex"], false);
    assert.match(text, /fonte em uso: volume/);
    assert.match(text, /provider=openai/);
    assert.match(text, /model=gpt-test/);
    assert.match(text, /npm run setup é o assistente completo/);
    assert.match(text, /npm run login é só OAuth/);
    assert.match(text, /primeiro modelo do catálogo/);
    assert.match(text, /\/model troca/);
    assert.doesNotMatch(text, new RegExp(secret));
    assert.doesNotMatch(text, new RegExp(oauthSecret));
    assert.doesNotMatch(text, /secret\.example/);
    assert.doesNotMatch(text, /hidden/);

    const overridden = readVolumeSetupFacts(f.dir, {
      LLM_API_KEY: envSecret,
    });
    const overriddenText = describeVolumeProvider(overridden).join("\n");
    assert.equal(overridden.source, "volume");
    assert.match(overriddenText, /não substituem um setup oficial/);
    assert.doesNotMatch(overriddenText, new RegExp(envSecret));
    assert.doesNotMatch(overriddenText, new RegExp(secret));

    const placeholder = readVolumeSetupFacts(f.dir, {
      LLM_API_KEY: "replace_with_key",
      LLM_BASE_URL: "replace_with_url",
    });
    assert.equal(placeholder.source, "volume");
  } finally {
    await f.close();
  }
});

test("diagnose sem volume e waiting de setup ou login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diagnose-empty-"));
  try {
    const facts = readVolumeSetupFacts(dir, {});
    assert.equal(facts.source, "none");
    assert.equal(facts.recordPresent, false);
    assert.match(describeVolumeProvider(facts).join("\n"), /registro ausente/);
    assert.match(formatWaiting("setup")!, /npm run setup/);
    assert.match(formatWaiting("login")!, /npm run login/);
    assert.equal(formatWaiting("other"), undefined);
    assert.equal(formatWaiting(undefined), undefined);
    const empty = describeWhatsAppVolume(dir, {}).join("\n");
    assert.match(empty, /números: nenhum/);
    assert.match(empty, /sessão pareada: não/);
    assert.match(empty, /entregas pendentes: banco ausente/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("whatsapp diagnose shows numbers, a paired session and pending deliveries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diagnose-wa-"));
  const store = new Store(dir);
  let closed = false;
  try {
    writePhoneGateway(store.db, "whatsapp");
    writeStoredWhatsapp(store.db, ["15551234567"]);
    store.queueTelegram(
      "wa",
      "15551234567@s.whatsapp.net",
      "oi",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    store.queueTelegram("tg", "1", "hello");
    store.close();
    closed = true;
    await mkdir(join(dir, "whatsapp-auth"), { recursive: true });
    await writeFile(join(dir, "whatsapp-auth", "creds.json"), "{}");
    const text = describeWhatsAppVolume(dir, {}).join("\n");
    assert.match(text, /números: \*\*\*4567/);
    assert.equal(text.includes("15551234567"), false);
    const overridden = describeWhatsAppVolume(dir, {
      WHATSAPP_ALLOWED_USERS: "15550001111",
    }).join("\n");
    assert.match(overridden, /números: \*\*\*1111/);
    assert.equal(overridden.includes("15550001111"), false);
    assert.equal(overridden.includes("15551234567"), false);
    assert.match(text, /sessão pareada: sim/);
    assert.match(text, /entregas pendentes: 1/);
    assert.doesNotMatch(text, /hello/);
  } finally {
    if (!closed) store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

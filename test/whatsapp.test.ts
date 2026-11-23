import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { readConfig, SetupRequiredError } from "../src/config.js";
import {
  ChannelNotSent,
  ChannelOffline,
  bindChannelChat,
  cancelInactiveGateway,
  flushChannelDeliveries,
  whatsAppOauthChat,
  type Channel,
  type InboundMessage,
} from "../src/channel.js";
import { McpCalls } from "../src/mcp-calls.js";
import { McpGateway } from "../src/mcp.js";
import { retryableError, Runtime } from "../src/runtime.js";
import { SettingsError } from "../src/settings.js";
import {
  readPhoneGateway,
  readStoredWhatsapp,
  parseWhatsappNumbers,
  resolveWhatsappUsers,
  routeWhatsappMenu,
  writePhoneGateway,
  writeStoredTelegram,
  writeStoredWhatsapp,
} from "../src/setup.js";
import { queueWhatsApp, Store, type Delivery } from "../src/store.js";
import { queueNotify } from "../src/task-telegram.js";
import { sweepMcpApprovals } from "../src/telegram-approvals.js";
import { Telegram } from "../src/telegram.js";
import {
  acceptWhatsAppMessage,
  queueWhatsAppUncertainNotices,
  queueWhatsappApprovals,
  takeNumberedApproval,
} from "../src/whatsapp-inbound.js";
import {
  admitWhatsAppMessage,
  pairWhatsApp,
  WhatsAppGateway,
  type WaConnectionUpdate,
  type WaRawMessage,
  type WaSocket,
} from "../src/whatsapp.js";

const OWNER = "15551234567";
const JID = `${OWNER}@s.whatsapp.net`;

async function pairChild() {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  await rl.question("Numbers with country code, comma-separated: ");
  rl.close();
  let opened = 0;
  const dir = join(tmpdir(), `pi-wa-pair-child-${process.pid}`);
  try {
    await pairWhatsApp(dir, {
      onQr: () => console.log("QR"),
      socketFactory: () => {
        opened += 1;
        const which = opened;
        const connection: Array<(update: WaConnectionUpdate) => void> = [];
        const socket = {
          ev: {
            on(event: string, listener: (value: never) => void) {
              if (event === "connection.update")
                connection.push(
                  listener as (update: WaConnectionUpdate) => void,
                );
            },
          },
          sendMessage: async () => ({ key: { id: "out" } }),
          end() {},
        } as WaSocket;
        setTimeout(() => {
          if (which === 1) {
            for (const listener of connection)
              listener({
                connection: "close",
                lastDisconnect: { error: { output: { statusCode: 408 } } },
              });
            return;
          }
          for (const listener of connection) listener({ qr: "qr-payload" });
          for (const listener of connection) listener({ connection: "open" });
        }, 20);
        return socket;
      },
    });
    console.log("PAIRED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.env.PI_WA_PAIR_CHILD === "1") {
  await pairChild();
  process.exit(0);
}

function textMessage(id: string, fromMe = false, chat = JID): WaRawMessage {
  return {
    key: { remoteJid: chat, id, fromMe },
    message: { conversation: "hello" },
  };
}

test("WhatsApp admits only the owner's direct chat", () => {
  const allowed = [OWNER];
  const own = `${OWNER}:1@s.whatsapp.net`;
  const admitted = admitWhatsAppMessage({
    raw: textMessage("m1"),
    allowed,
    sentIds: new Set(),
  });
  assert.equal(admitted?.channel, "whatsapp");
  assert.equal(admitted?.chatId, JID);
  assert.equal(admitted?.text, "hello");
  assert.equal(
    admitWhatsAppMessage({
      raw: textMessage("m2", false, "15559999999@s.whatsapp.net"),
      allowed,
      sentIds: new Set(),
    }),
    undefined,
  );
  for (const chat of [
    "120363000@g.us",
    "status@broadcast",
    "120363000@newsletter",
  ])
    assert.equal(
      admitWhatsAppMessage({
        raw: textMessage("m3", false, chat),
        allowed,
        sentIds: new Set(),
      }),
      undefined,
    );
  assert.equal(
    admitWhatsAppMessage({
      raw: textMessage("echo"),
      allowed,
      sentIds: new Set(["echo"]),
    }),
    undefined,
  );
  const self = admitWhatsAppMessage({
    raw: textMessage("note", true, JID),
    allowed,
    ownJid: own,
    sentIds: new Set(),
  });
  assert.equal(self?.senderId, JID);
  assert.equal(
    admitWhatsAppMessage({
      raw: textMessage("note", true, "15550000000@s.whatsapp.net"),
      allowed,
      ownJid: own,
      sentIds: new Set(),
    }),
    undefined,
  );
});

const OWN_LID = "155500000000099:31@lid";
const SELF_LID = "155500000000099@lid";

function withInfo(run: (lines: string[]) => void) {
  const lines: string[] = [];
  const original = console.info;
  console.info = ((line?: unknown) => {
    lines.push(String(line));
  }) as typeof console.info;
  try {
    run(lines);
  } finally {
    console.info = original;
  }
}

test("a LID self-chat is admitted and other drops are logged masked", () => {
  const own = `${OWNER}:1@s.whatsapp.net`;
  const allowed = [OWNER];
  withInfo((lines) => {
    const self = admitWhatsAppMessage({
      raw: {
        key: {
          remoteJid: SELF_LID,
          remoteJidAlt: JID,
          fromMe: true,
          id: "self",
        },
        message: { conversation: "note to self" },
      },
      allowed,
      ownJid: own,
      ownLid: OWN_LID,
      sentIds: new Set(),
    });
    assert.equal(self?.chatId, SELF_LID);
    assert.equal(self?.senderId, SELF_LID);
    assert.deepEqual(self?.aliases, [JID]);
    assert.equal(self?.text, "note to self");
    const viaAlt = admitWhatsAppMessage({
      raw: {
        key: {
          remoteJid: SELF_LID,
          remoteJidAlt: JID,
          fromMe: true,
          id: "self-alt",
        },
        message: { conversation: "note to self" },
      },
      allowed,
      ownJid: own,
      sentIds: new Set(),
    });
    assert.equal(viaAlt?.chatId, SELF_LID);
    assert.equal(
      admitWhatsAppMessage({
        raw: {
          key: {
            remoteJid: SELF_LID,
            remoteJidAlt: JID,
            fromMe: true,
            id: "echo",
          },
          message: { conversation: "bot reply" },
        },
        allowed,
        ownJid: own,
        ownLid: OWN_LID,
        sentIds: new Set(["echo"]),
      }),
      undefined,
    );
    assert.equal(
      admitWhatsAppMessage({
        raw: textMessage("nope", false, "15559999999@s.whatsapp.net"),
        allowed,
        ownJid: own,
        sentIds: new Set(),
      }),
      undefined,
    );
    const fromLid = admitWhatsAppMessage({
      raw: {
        key: {
          remoteJid: "999000111222333@lid",
          remoteJidAlt: JID,
          fromMe: false,
          id: "from-lid",
        },
        message: { conversation: "hi" },
      },
      allowed,
      sentIds: new Set(),
    });
    assert.equal(fromLid?.chatId, "999000111222333@lid");
    assert.equal(fromLid?.senderId, JID);
    assert.deepEqual(fromLid?.aliases, [JID]);
    const fromParticipant = admitWhatsAppMessage({
      raw: {
        key: {
          remoteJid: "999000111222333@lid",
          participantAlt: `${OWNER}:2@s.whatsapp.net`,
          fromMe: false,
          id: "from-participant",
        },
        message: { conversation: "hi" },
      },
      allowed,
      sentIds: new Set(),
    });
    assert.equal(fromParticipant?.senderId, JID);
    assert.equal(
      admitWhatsAppMessage({
        raw: {
          key: {
            remoteJid: "888000111222333@lid",
            remoteJidAlt: JID,
            fromMe: true,
            id: "other-lid",
          },
          message: { conversation: "not mine" },
        },
        allowed,
        ownJid: own,
        ownLid: OWN_LID,
        sentIds: new Set(),
      }),
      undefined,
    );
    const text = lines.join("\n");
    assert.match(text, /dropped inbound \(echo\) \*\*\*4567/);
    assert.match(text, /dropped inbound \(not-allowed\) \*\*\*9999/);
    assert.match(text, /dropped inbound \(not-self\)/);
    assert.equal(text.includes(OWNER), false);
    assert.equal(text.includes("15559999999"), false);
    assert.equal(text.includes("155500000000099"), false);
    assert.equal(text.includes("note to self"), false);
    assert.equal(text.includes("bot reply"), false);
    assert.equal(text.includes("not mine"), false);
  });
});

test("the linked account is the owner's self-chat even when fromMe is false", () => {
  const own = `${OWNER}:1@s.whatsapp.net`;
  const stranger = ["19998887777"];
  withInfo((lines) => {
    const device = admitWhatsAppMessage({
      raw: textMessage("dev", false, `${OWNER}:14@s.whatsapp.net`),
      allowed: stranger,
      ownJid: own,
      sentIds: new Set(),
    });
    assert.equal(device?.chatId, JID);
    assert.equal(device?.senderId, JID);
    const fromMeSelf = admitWhatsAppMessage({
      raw: textMessage("me", true, `${OWNER}:14@s.whatsapp.net`),
      allowed: stranger,
      ownJid: own,
      sentIds: new Set(),
    });
    assert.equal(fromMeSelf?.chatId, JID);
    const lid = admitWhatsAppMessage({
      raw: {
        key: { remoteJid: SELF_LID, fromMe: false, id: "lid-only" },
        message: { conversation: "self lid" },
      },
      allowed: stranger,
      ownLid: OWN_LID,
      sentIds: new Set(),
    });
    assert.equal(lid?.chatId, SELF_LID);
    assert.equal(lid?.senderId, SELF_LID);
    const viaParticipant = admitWhatsAppMessage({
      raw: {
        key: {
          remoteJid: "999000111222333@lid",
          participantAlt: `${OWNER}:2@s.whatsapp.net`,
          fromMe: false,
          id: "sender-alt",
        },
        message: { conversation: "from me" },
      },
      allowed: stranger,
      ownJid: own,
      ownLid: OWN_LID,
      sentIds: new Set(),
    });
    assert.equal(viaParticipant?.chatId, "999000111222333@lid");
    const byPhone = admitWhatsAppMessage({
      raw: textMessage("phone-only", false),
      allowed: stranger,
      ownPhone: OWNER,
      sentIds: new Set(),
    });
    assert.equal(byPhone?.chatId, JID);
    assert.equal(
      admitWhatsAppMessage({
        raw: {
          key: { remoteJid: SELF_LID, fromMe: false, id: "echo-self" },
          message: { conversation: "bot reply" },
        },
        allowed: stranger,
        ownLid: OWN_LID,
        sentIds: new Set(["echo-self"]),
      }),
      undefined,
    );
    assert.equal(
      admitWhatsAppMessage({
        raw: textMessage("stranger", false, "15550002892@s.whatsapp.net"),
        allowed: stranger,
        ownJid: own,
        ownLid: OWN_LID,
        sentIds: new Set(),
      }),
      undefined,
    );
    assert.equal(
      admitWhatsAppMessage({
        raw: textMessage("out", true, "15550001111@s.whatsapp.net"),
        allowed: [OWNER, "15550001111"],
        ownJid: own,
        ownLid: OWN_LID,
        sentIds: new Set(),
      }),
      undefined,
    );
    const text = lines.join("\n");
    assert.match(
      text,
      /dropped inbound \(echo\) \*\*\*0099 remote=lid alt=no fromMe=false/,
    );
    assert.match(
      text,
      /dropped inbound \(not-allowed\) \*\*\*2892 remote=pn alt=no fromMe=false/,
    );
    assert.match(
      text,
      /dropped inbound \(not-self\) .* remote=pn alt=no fromMe=true/,
    );
    assert.equal(text.includes(OWNER), false);
    assert.equal(text.includes("15550002892"), false);
    assert.equal(text.includes("155500000000099"), false);
    assert.equal(text.includes("bot reply"), false);
    assert.equal(text.includes("self lid"), false);
  });
});

function socketHarness(lid?: string) {
  const connection: Array<(update: WaConnectionUpdate) => void> = [];
  const messages: Array<
    (upsert: { messages?: WaRawMessage[]; type?: string }) => void
  > = [];
  const sent: Array<{ jid: string; text?: string; quoted?: string }> = [];
  const socket = {
    user: {
      id: `${OWNER}:1@s.whatsapp.net`,
      ...(lid ? { lid } : {}),
    },
    ev: {
      on(event: string, listener: (value: never) => void) {
        if (event === "connection.update")
          connection.push(listener as (update: WaConnectionUpdate) => void);
        if (event === "messages.upsert")
          messages.push(
            listener as (upsert: {
              messages?: WaRawMessage[];
              type?: string;
            }) => void,
          );
      },
    },
    sendMessage: async (
      jid: string,
      content: Record<string, unknown>,
      options?: { quoted?: { key: { id?: string | null } } },
    ) => {
      sent.push({
        jid,
        text: typeof content.text === "string" ? content.text : undefined,
        quoted: options?.quoted?.key.id ?? undefined,
      });
      return { key: { id: `out-${sent.length}` } };
    },
    end() {},
  } as WaSocket;
  return {
    socket,
    sent,
    open() {
      for (const listener of connection) listener({ connection: "open" });
    },
    close(code: number) {
      for (const listener of connection)
        listener({
          connection: "close",
          lastDisconnect: { error: { output: { statusCode: code } } },
        });
    },
    upsert(raw: WaRawMessage, type: "notify" | "append" = "notify") {
      for (const listener of messages) listener({ type, messages: [raw] });
    },
    upsertMany(raws: WaRawMessage[], type: "notify" | "append" = "notify") {
      for (const listener of messages) listener({ type, messages: raws });
    },
    qr(value: string) {
      for (const listener of connection) listener({ qr: value });
    },
  };
}

test("one upsert batch is handled in order per chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-batch-"));
  const other = "15550008888@s.whatsapp.net";
  const harness = socketHarness();
  const order: string[] = [];
  let releaseFirst = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER, "15550008888"],
    onMessage: async (message) => {
      order.push(`start:${message.messageId}`);
      if (message.messageId === "a") await gate;
      order.push(`end:${message.messageId}`);
    },
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    harness.upsertMany([
      textMessage("a"),
      textMessage("b"),
      textMessage("c", false, other),
    ]);
    const deadline = Date.now() + 1000;
    while (!order.includes("end:c") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(order.includes("start:a"), true);
    assert.equal(order.includes("start:b"), false);
    assert.equal(order.includes("end:c"), true);
    releaseFirst();
    const done = Date.now() + 1000;
    while (!order.includes("end:b") && Date.now() < done)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(order.indexOf("end:a") < order.indexOf("start:b"));
    assert.equal(order.at(-1), "end:b");
  } finally {
    releaseFirst();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rejected reconnect is logged and scheduled again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-reconnect-fail-"));
  const scheduled: Array<() => void> = [];
  const errors: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  const original = console.error;
  console.error = ((line?: unknown) => {
    errors.push(String(line));
  }) as typeof console.error;
  const made: ReturnType<typeof socketHarness>[] = [];
  let opens = 0;
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "whatsapp-auth"),
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => {
      opens += 1;
      if (opens > 1)
        return Promise.reject(new Error(`EACCES creds.json ${OWNER}`));
      const next = socketHarness();
      made.push(next);
      return next.socket;
    },
    schedule: (run) => scheduled.push(run),
  });
  try {
    await gateway.start();
    made[0].close(408);
    assert.equal(scheduled.length, 1);
    scheduled[0]();
    for (let attempt = 0; scheduled.length < 2 && attempt < 20; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(unhandled.length, 0);
    assert.equal(scheduled.length, 2);
    const logged = errors.join("\n");
    assert.match(logged, /reconnect failed/);
    assert.equal(logged.includes(OWNER), false);
    assert.match(logged, /\*\*\*4567/);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    console.error = original;
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a normal socket close (428) keeps a referenced reconnect timer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-428-"));
  const made: ReturnType<typeof socketHarness>[] = [];
  const real = globalThis.setTimeout;
  const armed: Array<ReturnType<typeof setTimeout>> = [];
  globalThis.setTimeout = ((
    fn: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => {
    const timer = real(fn as never, ms as never, ...(args as never[]));
    if (ms === 2000) armed.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => {
      const next = socketHarness();
      made.push(next);
      return next.socket;
    },
  });
  try {
    await gateway.start();
    made[0]!.close(428);
    assert.equal(armed.length, 1);
    assert.equal(armed[0]!.hasRef(), true);
    assert.equal(gateway.connected, false);
    assert.equal(gateway.live, true);
    await new Promise((resolve) => real(resolve, 2100));
    assert.equal(made.length, 2);
  } finally {
    globalThis.setTimeout = real;
    for (const timer of armed) clearTimeout(timer);
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the gateway reconnects, and a logout waits for a new QR instead of exiting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-reconnect-"));
  const sessionDir = join(dir, "whatsapp-auth");
  const made: ReturnType<typeof socketHarness>[] = [];
  const scheduled: Array<() => void> = [];
  const qrs: string[] = [];
  const errors: string[] = [];
  const original = console.error;
  console.error = ((line?: unknown) => {
    errors.push(String(line));
  }) as typeof console.error;
  const gateway = new WhatsAppGateway({
    sessionDir,
    allowed: [OWNER],
    onMessage: async () => {},
    onQr: (qr) => qrs.push(qr),
    socketFactory: () => {
      const next = socketHarness();
      made.push(next);
      return next.socket;
    },
    schedule: (run) => scheduled.push(run),
  });
  try {
    await gateway.start();
    assert.equal(made.length, 1);
    made[0].close(408);
    assert.equal(scheduled.length, 1);
    assert.equal(gateway.waitingForPair, false);
    assert.equal(gateway.connected, false);
    assert.equal(gateway.live, true);
    scheduled[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(made.length, 2);
    await writeFile(join(sessionDir, "creds.json"), '{"me":{"id":"x"}}\n');
    made[1].close(401);
    for (let attempt = 0; scheduled.length < 2 && attempt < 50; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gateway.waitingForPair, true);
    assert.equal(scheduled.length, 2);
    const names = await readdir(dir);
    const moved = names.find((name) =>
      name.startsWith("whatsapp-auth.loggedout-"),
    );
    assert.ok(moved);
    const parked = await readdir(join(dir, moved));
    assert.equal(parked.includes("creds.json"), true);
    const live = await readdir(sessionDir);
    assert.equal(live.includes("creds.json"), false);
    const logged = errors.join("\n");
    assert.match(logged, /session logged out/);
    assert.match(logged, /npm run setup/);
    assert.match(logged, /scan the QR/);
    assert.equal(logged.includes(OWNER), false);
    assert.equal(logged.includes('{"me"'), false);
    made[1].close(401);
    assert.equal(scheduled.length, 2);
    scheduled[1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(made.length, 3);
    made[2].qr("qr-payload");
    assert.deepEqual(qrs, ["qr-payload"]);
    made[2].open();
    assert.equal(gateway.connected, true);
    assert.equal(gateway.waitingForPair, false);
  } finally {
    console.error = original;
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reply into the LID self-chat does not answer its own echo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-self-"));
  const seen: string[] = [];
  const lines: string[] = [];
  const original = console.info;
  console.info = ((line?: unknown) => {
    lines.push(String(line));
  }) as typeof console.info;
  const made: ReturnType<typeof socketHarness>[] = [];
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async (message) => {
      seen.push(`${message.chatId}:${message.messageId}`);
      await gateway.sendText(message.chatId, "pong");
    },
    socketFactory: () => {
      const next = socketHarness(OWN_LID);
      made.push(next);
      return next.socket;
    },
  });
  try {
    await gateway.start();
    made[0].open();
    made[0].upsert({
      key: {
        remoteJid: SELF_LID,
        remoteJidAlt: JID,
        fromMe: true,
        id: "from-phone",
      },
      message: { conversation: "ping" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen, [`${SELF_LID}:from-phone`]);
    assert.equal(made[0].sent[0]?.jid, JID);
    assert.equal(made[0].sent[0]?.text, "Pi: pong");
    const echoId = "out-1";
    made[0].upsert({
      key: {
        remoteJid: SELF_LID,
        remoteJidAlt: JID,
        fromMe: true,
        id: echoId,
      },
      message: { conversation: "pong" },
    });
    assert.deepEqual(seen, [`${SELF_LID}:from-phone`]);
    assert.equal(made[0].sent.length, 1);
    made[0].upsert(
      textMessage("stranger", false, "15558887777@s.whatsapp.net"),
    );
    assert.deepEqual(seen, [`${SELF_LID}:from-phone`]);
    const text = lines.join("\n");
    assert.match(text, /dropped inbound \(echo\) \*\*\*4567/);
    assert.match(text, /dropped inbound \(not-allowed\) \*\*\*7777/);
    assert.equal(text.includes(OWNER), false);
    assert.equal(text.includes("15558887777"), false);
    assert.equal(text.includes("ping"), false);
    assert.equal(text.includes("pong"), false);
  } finally {
    console.info = original;
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a LID chat with a phone alt is answered on that phone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-lid-pn-"));
  const sessionDir = join(dir, "auth");
  const other = "999000111222333@lid";
  const unknown = "777000111222333@lid";
  const made: ReturnType<typeof socketHarness>[] = [];
  const gateway = new WhatsAppGateway({
    sessionDir,
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => {
      const next = socketHarness();
      made.push(next);
      return next.socket;
    },
  });
  try {
    await gateway.start();
    made[0].open();
    made[0].upsert({
      key: {
        remoteJid: other,
        participantAlt: `${OWNER}:2@s.whatsapp.net`,
        fromMe: false,
        id: "from-owner",
      },
      message: { conversation: "hi" },
    });
    await gateway.sendText(other, "reply text");
    assert.equal(made[0].sent[0]?.jid, JID);
    assert.equal(made[0].sent[0]?.jid.includes(":"), false);
    assert.equal(made[0].sent[0]?.text, "Pi: reply text");
    await gateway.sendText(unknown, "fallback");
    assert.equal(made[0].sent[1]?.jid, unknown);
    await gateway.close();
    const againMade: ReturnType<typeof socketHarness>[] = [];
    const again = new WhatsAppGateway({
      sessionDir,
      allowed: [OWNER],
      onMessage: async () => {},
      socketFactory: () => {
        const next = socketHarness();
        againMade.push(next);
        return next.socket;
      },
    });
    await again.start();
    againMade[0].open();
    await again.sendText(other, "still the phone");
    assert.equal(againMade[0].sent[0]?.jid, JID);
    await again.close();
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp send trims trailing whitespace and does not send an empty text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-trim-"));
  const harness = socketHarness();
  const sent: Array<Record<string, unknown>> = [];
  harness.socket.sendMessage = async (_jid, content) => {
    sent.push(content);
    return { key: { id: `out-${sent.length}` } };
  };
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    const other = "15550009999@s.whatsapp.net";
    await gateway.sendText(other, "hello\n\n");
    await gateway.sendText(other, "\nhello  \n");
    await gateway.sendText(other, "  kept");
    await assert.rejects(
      () => gateway.sendText(other, "\n \t"),
      (error: unknown) => {
        assert.ok(error instanceof ChannelNotSent);
        assert.equal(sent.length, 3);
        return true;
      },
    );
    const photo = Buffer.from("img").toString("base64");
    await gateway.sendMedia(other, {
      kind: "photo",
      data: photo,
      mimeType: "image/jpeg",
      caption: "cap\n\n",
    });
    await gateway.sendMedia(other, {
      kind: "photo",
      data: photo,
      mimeType: "image/jpeg",
      caption: "\n",
    });
    assert.equal(sent[0]?.text, "hello");
    assert.equal(sent[1]?.text, "\nhello");
    assert.equal(sent[2]?.text, "  kept");
    assert.equal(sent[3]?.caption, "cap");
    assert.equal("caption" in sent[4]!, false);
    assert.ok(sent[4]?.image);
    assert.equal(sent.length, 5);
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Baileys 7 throws when a quote key has no message", async () => {
  const { generateWAMessage } = await import("@whiskeysockets/baileys");
  const jid = JID;
  await assert.rejects(
    () =>
      generateWAMessage(jid, { text: "reply" }, {
        quoted: { key: { remoteJid: jid, id: "pre-179", fromMe: false } },
        userJid: `${OWNER}:1@s.whatsapp.net`,
      } as never),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(
        error.message,
        "Cannot read properties of undefined (reading 'undefined')",
      );
      assert.match(error.stack ?? "", /messages\.[jt]s:\d+/);
      return true;
    },
  );
});

test("a LID chat bound before the phone pair is answered on that phone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-pre-lid-"));
  const lid = "999000111222333@lid";
  const bot = "15550001111";
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const conversationId = await app.create("WhatsApp");
  app.store.run(
    "INSERT INTO channel_chats VALUES (?,?,?)",
    "whatsapp",
    lid,
    conversationId,
  );
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    `whatsapp:quote:${lid}`,
    "pre-179-msg",
  );
  const sent: Array<{
    jid: string;
    quoted?: string;
    message?: string;
  }> = [];
  const harness = socketHarness();
  harness.socket.user = {
    id: `${bot}:1@s.whatsapp.net`,
    lid: OWN_LID,
    phoneNumber: bot,
  };
  harness.socket.sendMessage = async (jid, content, options) => {
    const quoted = options?.quoted as
      | {
          key?: { remoteJid?: unknown; id?: unknown; fromMe?: unknown };
          message?: { conversation?: unknown };
        }
      | undefined;
    assert.equal(typeof jid, "string");
    assert.ok(jid);
    assert.equal(jid.includes("undefined"), false);
    if (options) {
      assert.equal(typeof quoted?.message?.conversation, "string");
      assert.ok(quoted?.message?.conversation);
      assert.equal(typeof quoted?.key?.remoteJid, "string");
      assert.equal(typeof quoted?.key?.id, "string");
      assert.equal(typeof quoted?.key?.fromMe, "boolean");
    }
    const { generateWAMessage } = await import("@whiskeysockets/baileys");
    await generateWAMessage(
      jid,
      content as never,
      {
        userJid: `${bot}:1@s.whatsapp.net`,
        ...(quoted ? { quoted } : {}),
      } as never,
    );
    sent.push({
      jid,
      quoted: typeof quoted?.key?.id === "string" ? quoted.key.id : undefined,
      message:
        typeof quoted?.message?.conversation === "string"
          ? quoted.message.conversation
          : undefined,
    });
    return { key: { id: `out-${sent.length}` } };
  };
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "whatsapp-auth"),
    allowed: [OWNER],
    onMessage: (message) => acceptWhatsAppMessage(app, message),
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    harness.upsert({
      key: {
        remoteJid: lid,
        remoteJidAlt: `${OWNER}:2@s.whatsapp.net`,
        fromMe: false,
        id: "from-owner",
      },
      message: { conversation: "oi" },
    });
    for (
      let attempt = 0;
      attempt < 40 &&
      !app.store.get(
        "SELECT 1 FROM requests WHERE conversationId=?",
        conversationId,
      );
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    await (await app.conversation(conversationId)).waitForIdle(context);
    let row: (Delivery & { result: string | null }) | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      await flushChannelDeliveries(app.store, gateway);
      row = app.store.get<Delivery & { result: string | null }>(
        "SELECT * FROM deliveries WHERE channel='whatsapp'",
      );
      if (row?.state === "sent" || row?.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(row?.state, "sent");
    assert.equal(row?.chat, lid);
    assert.equal((row?.result ?? "").includes("Nothing was sent"), false);
    assert.ok(sent.length > 0);
    for (const item of sent) {
      assert.equal(item.jid, JID);
      assert.equal(item.jid.includes(":"), false);
      assert.equal(item.jid.endsWith("@s.whatsapp.net"), true);
      assert.equal(item.quoted, undefined);
    }
    const pairs = JSON.parse(
      await readFile(join(dir, "whatsapp-lid-map.json"), "utf8"),
    ) as Record<string, string>;
    assert.equal(pairs[lid], JID);
    const bound = app.store.all<{ chatId: string; conversationId: string }>(
      "SELECT chatId, conversationId FROM channel_chats WHERE channel='whatsapp' ORDER BY chatId",
    );
    assert.deepEqual(
      bound.map((item) => item.chatId),
      [JID, lid].sort(),
    );
    assert.ok(bound.every((item) => item.conversationId === conversationId));
  } finally {
    await gateway.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a local send error is failed and logged masked; an ack timeout stays uncertain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-send-fail-"));
  const store = new Store(dir);
  const harness = socketHarness(OWN_LID);
  let mode: "local" | "stack" | "timeout" = "local";
  let attempts = 0;
  harness.socket.sendMessage = async () => {
    attempts += 1;
    if (mode === "local") throw new Error(`no session for ${OWNER} SECRET`);
    if (mode === "stack") {
      const error = new TypeError(
        "Cannot read properties of undefined (reading 'undefined')",
      );
      error.stack = [
        "TypeError: Cannot read properties of undefined (reading 'undefined')",
        "    at generateWAMessageFromContent (file:///opt/app/node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:568:64)",
        "    at WhatsAppGateway.send (file:///opt/app/src/whatsapp.ts:584:21)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      ].join("\n");
      throw error;
    }
    throw new Error(`timed out waiting for ack ${OWNER}`);
  };
  const lines: string[] = [];
  const original = console.error;
  console.error = ((line?: unknown) => {
    lines.push(String(line));
  }) as typeof console.error;
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "whatsapp-auth"),
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => harness.socket,
  });
  const body = "do not log this body";
  const redact = (text: string) => text.replaceAll("SECRET", "[REDACTED]");
  const queue = (id: string) =>
    store.queueTelegram(
      id,
      SELF_LID,
      body,
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
  const row = (id: string) =>
    store.get<{ state: string; result: string | null }>(
      "SELECT state, result FROM deliveries WHERE id=?",
      `${id}:0`,
    );
  try {
    await gateway.start();
    harness.open();
    queue("local");
    await flushChannelDeliveries(store, gateway, redact);
    assert.equal(row("local")?.state, "failed");
    assert.match(row("local")?.result ?? "", /Nothing was sent/);
    assert.equal((row("local")?.result ?? "").includes("unknown"), false);
    const localLog = lines.join("\n");
    assert.match(
      localLog,
      /WhatsApp: send failed \(no session for \*\*\*4567 \[REDACTED\]\)\./,
    );
    assert.equal(localLog.includes(OWNER), false);
    assert.equal(localLog.includes("SECRET"), false);
    assert.equal(localLog.includes(body), false);
    const afterLocal = attempts;
    await flushChannelDeliveries(store, gateway, redact);
    assert.equal(attempts, afterLocal);

    mode = "stack";
    lines.length = 0;
    queue("stack");
    await flushChannelDeliveries(store, gateway, redact);
    assert.equal(row("stack")?.state, "failed");
    assert.match(row("stack")?.result ?? "", /Nothing was sent/);
    const stackLog = lines.join("\n");
    assert.match(
      stackLog,
      /WhatsApp: send failed \(Cannot read properties of undefined \(reading 'undefined'\)\)\./,
    );
    assert.equal(stackLog.includes("node_modules"), false);
    assert.equal(stackLog.includes("/opt/app"), false);
    assert.equal(stackLog.includes(body), false);
    assert.equal(stackLog.includes(OWNER), false);

    mode = "timeout";
    lines.length = 0;
    queue("later");
    await flushChannelDeliveries(store, gateway, redact);
    assert.equal(row("later")?.state, "uncertain");
    assert.match(
      row("later")?.result ?? "",
      /Send outcome unknown\. Not resent automatically\./,
    );
    const timeoutLog = lines.join("\n");
    assert.match(timeoutLog, /WhatsApp: send failed \(timed out/);
    assert.match(timeoutLog, /\*\*\*4567/);
    assert.equal(timeoutLog.includes(OWNER), false);
    assert.equal(timeoutLog.includes(body), false);
    const afterTimeout = attempts;
    await flushChannelDeliveries(store, gateway, redact);
    assert.equal(attempts, afterTimeout);
  } finally {
    console.error = original;
    await gateway.close();
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-chat from creds.json is admitted before socket.user exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-creds-"));
  const auth = join(dir, "auth");
  await mkdir(auth, { recursive: true });
  await writeFile(
    join(auth, "creds.json"),
    JSON.stringify({
      me: { id: JID, lid: OWN_LID },
    }),
  );
  const seen: string[] = [];
  const lines: string[] = [];
  const original = console.info;
  console.info = ((line?: unknown) => {
    lines.push(String(line));
  }) as typeof console.info;
  const harness = socketHarness();
  harness.socket.user = undefined;
  const gateway = new WhatsAppGateway({
    sessionDir: auth,
    allowed: ["19998887777"],
    onMessage: async (message) => {
      seen.push(`${message.chatId}:${message.messageId}`);
    },
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    harness.upsert({
      key: { remoteJid: SELF_LID, fromMe: false, id: "lid" },
      message: { conversation: "self" },
    });
    harness.upsert(textMessage("device", false, `${OWNER}:12@s.whatsapp.net`));
    harness.upsert(textMessage("other", false, "15550002892@s.whatsapp.net"));
    await gateway.sendText(SELF_LID, "pong");
    assert.equal(harness.sent[0]?.jid, JID);
    harness.upsert({
      key: { remoteJid: SELF_LID, fromMe: false, id: "out-1" },
      message: { conversation: "pong" },
    });
    assert.deepEqual(seen, [`${SELF_LID}:lid`, `${JID}:device`]);
    const text = lines.join("\n");
    assert.match(
      text,
      /dropped inbound \(not-allowed\) \*\*\*2892 remote=pn alt=no fromMe=false/,
    );
    assert.match(text, /dropped inbound \(echo\)/);
    assert.equal(text.includes(OWNER), false);
    assert.equal(text.includes("15550002892"), false);
    assert.equal(text.includes("self"), false);
    assert.equal(text.includes("pong"), false);
  } finally {
    console.info = original;
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pairing stays up after stdin closes and the first socket drops", async () => {
  const { spawn } = await import("node:child_process");
  const file = new URL("./whatsapp.test.ts", import.meta.url);
  const child = spawn(process.execPath, ["--import", "tsx", file.pathname], {
    cwd: file.pathname.replace(/\/test\/whatsapp\.test\.ts$/, ""),
    env: { ...process.env, PI_WA_PAIR_CHILD: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end("15550001111,15550002222\n");
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`pairing child hung\n${stdout}\n${stderr}`));
      }, 15_000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /QR/);
    assert.match(stdout, /PAIRED/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (child.pid)
      await rm(join(tmpdir(), `pi-wa-pair-child-${child.pid}`), {
        recursive: true,
        force: true,
      });
  }
});

test("pairing resolves once the socket is open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-pair-"));
  try {
    await pairWhatsApp(join(dir, "auth"), {
      socketFactory: () => {
        const harness = socketHarness();
        setTimeout(() => harness.open(), 20);
        return harness.socket;
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pairing refuses while the gateway holds the volume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-pair-lock-"));
  const release = await lockfile.lock(dir, {
    realpath: true,
    lockfilePath: join(dir, "owner.lock"),
    stale: 30_000,
    retries: 0,
  });
  let opened = 0;
  try {
    await assert.rejects(
      () =>
        pairWhatsApp(join(dir, "whatsapp-auth"), {
          socketFactory: () => {
            opened += 1;
            return socketHarness().socket;
          },
        }),
      /o gateway já mostra o QR nos logs/,
    );
    assert.equal(opened, 0);
  } finally {
    await release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("starting one gateway cancels the other channel's pending rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-inactive-"));
  const store = new Store(dir);
  try {
    store.queueTelegram("tg", "1", "hello");
    store.queueTelegram(
      "wa",
      JID,
      "oi",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    store.run(
      "INSERT INTO deliveries(id,chat,text,state,channel) VALUES (?,?,?,?,?)",
      "explicit-tg",
      "1",
      "legacy",
      "pending",
      "telegram",
    );
    assert.equal(cancelInactiveGateway(store, "whatsapp"), 2);
    const left = store.all<{ id: string; state: string }>(
      "SELECT id, state FROM deliveries ORDER BY id",
    );
    assert.deepEqual(
      left.map((row) => [row.id, row.state]),
      [
        ["explicit-tg", "cancelled"],
        ["tg:0", "cancelled"],
        ["wa:0", "pending"],
      ],
    );
    assert.equal(
      store.get<{ result: string }>(
        "SELECT result FROM deliveries WHERE id=?",
        "tg:0",
      )?.result,
      "gateway inativo",
    );
    store.run(
      "UPDATE deliveries SET state='pending' WHERE id IN ('tg:0','explicit-tg','wa:0')",
    );
    assert.equal(cancelInactiveGateway(store, "telegram"), 1);
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        "wa:0",
      )?.state,
      "cancelled",
    );
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        "tg:0",
      )?.state,
      "pending",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a retry receipt resends the cached message, not an empty body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-resend-"));
  const harness = socketHarness();
  let n = 0;
  harness.socket.sendMessage = async (_jid, content) => {
    n += 1;
    const text = typeof content.text === "string" ? content.text : "";
    return n === 1
      ? { key: { id: "m1" } }
      : { key: { id: `m${n}` }, message: { conversation: text } };
  };
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => harness.socket,
  });
  const other = "15550009999@s.whatsapp.net";
  try {
    await gateway.start();
    harness.open();
    await gateway.sendText(other, "hello");
    assert.deepEqual(gateway.retryMessage("m1"), { conversation: "hello" });
    assert.equal(gateway.retryMessage("missing"), undefined);
    assert.equal(gateway.retryMessage(undefined), undefined);
    for (let i = 0; i < 100; i++) await gateway.sendText(other, `n${i}`);
    assert.equal(gateway.retryMessage("m1"), undefined);
    assert.deepEqual(gateway.retryMessage("m101"), { conversation: "n99" });
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function recordingChannel(send: Channel["sendText"]): Channel {
  return {
    id: "whatsapp",
    sendText: send,
    sendMedia: async () => ({}),
  };
}

test("WhatsApp deliveries share Telegram's sent, failed and uncertain rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-flush-"));
  const store = new Store(dir);
  const calls: string[] = [];
  let mode: "ok" | "unknown" | "offline" = "ok";
  const channel = recordingChannel(async (_chat, text) => {
    calls.push(text);
    if (mode === "unknown") throw new Error("socket dropped");
    if (mode === "offline") throw new ChannelOffline();
    return { messageId: "sent-1" };
  });
  const state = () =>
    store.get<Delivery>("SELECT * FROM deliveries WHERE id=?", "note:0")?.state;
  try {
    store.queueTelegram(
      "note",
      JID,
      "hello",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    await flushChannelDeliveries(store, channel);
    assert.equal(state(), "sent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes("<"), false);

    store.queueTelegram(
      "maybe",
      JID,
      "maybe",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    mode = "unknown";
    await flushChannelDeliveries(store, channel);
    assert.equal(
      store.get<Delivery>("SELECT * FROM deliveries WHERE id='maybe:0'")?.state,
      "uncertain",
    );
    const afterUnknown = calls.length;
    await flushChannelDeliveries(store, channel);
    assert.equal(calls.length, afterUnknown);

    store.queueTelegram(
      "later",
      JID,
      "later",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    store.queueTelegram(
      "after",
      JID,
      "after",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    mode = "offline";
    await flushChannelDeliveries(store, channel);
    assert.equal(
      store.get<Delivery>("SELECT * FROM deliveries WHERE id='later:0'")?.state,
      "pending",
    );
    assert.equal(
      store.get<Delivery>("SELECT * FROM deliveries WHERE id='after:0'")?.state,
      "pending",
    );
    mode = "ok";
    await flushChannelDeliveries(store, channel);
    assert.equal(
      store.get<Delivery>("SELECT * FROM deliveries WHERE id='later:0'")?.state,
      "sent",
    );
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a slow send keeps two flushes in chunk order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-order-"));
  const store = new Store(dir);
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const channel = recordingChannel(async (_chat, text) => {
    calls += 1;
    order.push(text);
    if (calls === 1) await gate;
    return {};
  });
  try {
    const text = "a".repeat(8000);
    store.queueTelegram(
      "long",
      JID,
      text,
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    const first = flushChannelDeliveries(store, channel);
    for (let attempt = 0; order.length < 1 && attempt < 20; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    const second = flushChannelDeliveries(store, channel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(order.length, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(
      order.map((part) => part.length),
      [3800, 3800, 400],
    );
    assert.equal(order.join(""), text);
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an offline or unsent file is not marked sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-media-"));
  const store = new Store(dir);
  let mode: "offline" | "missing" = "offline";
  const channel: Channel = {
    id: "whatsapp",
    sendText: async () => ({ messageId: "text" }),
    sendMedia: async () => {
      if (mode === "offline") throw new ChannelOffline();
      throw new ChannelNotSent("missing file");
    },
  };
  const state = () =>
    store.get<Delivery>("SELECT * FROM deliveries WHERE id=?", "file:0")?.state;
  try {
    store.queueTelegram(
      "file",
      JID,
      "",
      3500,
      undefined,
      undefined,
      [{ kind: "document", filename: "a.bin", data: "YQ==" }],
      undefined,
      "whatsapp",
    );
    await flushChannelDeliveries(store, channel);
    assert.equal(state(), "pending");
    mode = "missing";
    await flushChannelDeliveries(store, channel);
    assert.equal(state(), "failed");
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an offline flush retries only the media that was not sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-media-tail-"));
  const store = new Store(dir);
  const sent: string[] = [];
  let failAt = 1;
  const channel: Channel = {
    id: "whatsapp",
    sendText: async () => ({}),
    sendMedia: async (_chat, media) => {
      if (sent.length === failAt) throw new ChannelOffline();
      sent.push(media.filename ?? "");
      return { messageId: media.filename };
    },
  };
  const files = ["a.bin", "b.bin", "c.bin"].map((filename) => ({
    kind: "document" as const,
    filename,
    data: "YQ==",
  }));
  try {
    store.queueTelegram(
      "files",
      JID,
      "",
      3500,
      undefined,
      undefined,
      files,
      undefined,
      "whatsapp",
    );
    await flushChannelDeliveries(store, channel);
    assert.deepEqual(sent, ["a.bin"]);
    assert.equal(
      store.get<Delivery>("SELECT state FROM deliveries WHERE id='files:0'")
        ?.state,
      "pending",
    );
    failAt = 99;
    await flushChannelDeliveries(store, channel);
    assert.deepEqual(sent, ["a.bin", "b.bin", "c.bin"]);
    assert.equal(
      store.get<Delivery>("SELECT state FROM deliveries WHERE id='files:0'")
        ?.state,
      "sent",
    );
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("queueing the same WhatsApp prefix twice keeps the row count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-cut-"));
  const store = new Store(dir);
  const text = "b".repeat(8000);
  const rows = (prefix: string) =>
    store.all<Delivery>(
      "SELECT * FROM deliveries WHERE id>=? AND id<? ORDER BY id",
      `${prefix}:`,
      `${prefix};`,
    );
  try {
    store.queueTelegram(
      "same",
      JID,
      text,
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    const before = rows("same").length;
    store.queueTelegram(
      "same",
      JID,
      text,
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    const again = rows("same");
    assert.equal(again.length, before);
    assert.equal(again.map((row) => row.text).join(""), text);
    store.queueTelegram(
      "cut",
      JID,
      text,
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    store.run("DELETE FROM deliveries WHERE id='cut:1' OR id='cut:2'");
    store.queueTelegram(
      "cut",
      JID,
      text,
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    const parts = rows("cut");
    assert.equal(parts.length, 3);
    assert.equal(parts.map((row) => row.text).join(""), text);
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a sending row is uncertain after the process restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-restart-"));
  const store = new Store(dir);
  store.queueTelegram(
    "crash",
    JID,
    "hi",
    3500,
    undefined,
    undefined,
    undefined,
    undefined,
    "whatsapp",
  );
  store.run("UPDATE deliveries SET state='sending' WHERE id='crash:0'");
  store.db.close();
  const again = new Store(dir);
  try {
    assert.equal(
      again.get<Delivery>("SELECT * FROM deliveries WHERE id='crash:0'")?.state,
      "uncertain",
    );
  } finally {
    again.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("job notify uses WhatsApp only when the conversation has no Telegram route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-notify-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const store = app.store;
  try {
    store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      JID,
      "conv-wa",
    );
    assert.equal(
      queueNotify(store, "conv-wa", "req", "call", "job finished"),
      undefined,
    );
    const row = store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id LIKE 'conv-wa:req:notify:%'",
    );
    assert.equal(row?.channel, "whatsapp");
    assert.equal(row?.chat, JID);

    store.run(
      "INSERT INTO credentials VALUES ('telegram:bot',?)",
      JSON.stringify({ token: "123456:fake-local-only", botId: 123456 }),
    );
    store.run(
      "INSERT INTO telegram_conversations VALUES (?,?,?)",
      "conv-tg",
      "42",
      "42",
    );
    store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      "conv-tg",
    );
    store.run(
      "INSERT INTO meta VALUES (?,?)",
      "telegram:connection",
      JSON.stringify({
        enabled: true,
        bot: { id: 123456 },
        userId: "42",
        chatId: "42",
      }),
    );
    store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      "15550000000@s.whatsapp.net",
      "conv-tg",
    );
    assert.equal(
      queueNotify(store, "conv-tg", "req", "call", "via telegram"),
      undefined,
    );
    const telegram = store.get<Delivery>(
      "SELECT * FROM deliveries WHERE chat='42'",
    );
    assert.equal(telegram?.channel, null);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Telegram flush leaves WhatsApp rows pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-skip-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const sent: string[] = [];
  const telegram = new Telegram(
    app,
    {
      send: async (chat) => {
        sent.push(chat);
        return { message_id: 1 };
      },
    },
    ["42"],
    ["42"],
  );
  try {
    app.store.queueTelegram("tg", "42", "ping");
    app.store.queueTelegram(
      "wa",
      JID,
      "ping",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    await telegram.flush();
    assert.deepEqual(sent, ["42"]);
    assert.equal(
      app.store.get<Delivery>("SELECT * FROM deliveries WHERE id='wa:0'")
        ?.state,
      "pending",
    );
  } finally {
    await telegram.drain();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed inbound WhatsApp message asks the chat to send it again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-inbound-fail-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const message = {
    channel: "whatsapp" as const,
    chatId: JID,
    senderId: JID,
    messageId: "boom-1",
    text: "ping",
  };
  const notice = () =>
    app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id=?",
      "whatsapp:inbound-failed:boom-1:0",
    );
  const seen = () =>
    app.store.get("SELECT 1 FROM meta WHERE key=?", "whatsapp:seen:boom-1");
  try {
    app.submit = async () => {
      throw new SettingsError("model missing");
    };
    await assert.rejects(
      () => acceptWhatsAppMessage(app, message),
      SettingsError,
    );
    assert.match(
      notice()?.text ?? "",
      /Não consegui processar esta mensagem; envie de novo\./,
    );
    assert.equal(notice()?.channel, "whatsapp");
    assert.ok(seen());
    app.submit = async () => {
      throw retryableError(new Error("provider busy"));
    };
    message.messageId = "boom-2";
    await assert.rejects(() => acceptWhatsAppMessage(app, message), /busy/);
    const retry = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id=?",
      "whatsapp:inbound-failed:boom-2:0",
    );
    assert.match(
      retry?.text ?? "",
      /Não consegui processar esta mensagem; envie de novo\./,
    );
    assert.equal(
      app.store.get("SELECT 1 FROM meta WHERE key=?", "whatsapp:seen:boom-2"),
      undefined,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ask_user is not registered when the gateway is WhatsApp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-no-ask-"));
  const gateway = new McpGateway([]);
  const app = await Runtime.open({
    dir,
    mode: "demo",
    phoneGateway: "whatsapp",
    gateway,
  });
  try {
    const id = await app.create();
    const names = (await (await app.conversation(id)).agent(context)).tools.map(
      (tool) => tool.name,
    );
    assert.equal(names.includes("ask_user"), false);
    bindChannelChat(app.store, "whatsapp", JID, id);
    app.store.run(
      "INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      "call-1",
      id,
      "srv",
      "write",
      "{}",
      "uncertain",
      null,
      "direct",
      1,
    );
    queueWhatsAppUncertainNotices(app);
    const notice = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id LIKE 'whatsapp:mcp-uncertain:%'",
    );
    assert.equal(notice?.channel, "whatsapp");
    assert.match(notice?.text ?? "", /Use \/resume/);
  } finally {
    await app.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a WhatsApp Upsy redirect paste is answered and does not start a turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-oauth-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  try {
    await acceptWhatsAppMessage(app, {
      channel: "whatsapp",
      chatId: JID,
      senderId: JID,
      messageId: "oauth-1",
      text: "http://127.0.0.1:33418/callback?code=abc&state=xyz",
    });
    const reply = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id='whatsapp:oauth:oauth-1:0'",
    );
    assert.equal(reply?.channel, "whatsapp");
    assert.match(reply?.text ?? "", /not the sign-in/);
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a WhatsApp OAuth notice uses the bound chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-oauth-chat-"));
  const store = new Store(dir);
  const lid = "999000111222333@lid";
  const phone = "15550007777@s.whatsapp.net";
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: ["15550001111"],
    onMessage: async () => {},
    socketFactory: () => socketHarness().socket,
  });
  try {
    store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      lid,
      "c1",
    );
    store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      phone,
      "c1",
    );
    assert.equal(
      whatsAppOauthChat(store, "15550001111", (chat) => chat),
      phone,
    );
    store.run("DELETE FROM channel_chats");
    store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      lid,
      "c1",
    );
    await writeFile(
      join(dir, "whatsapp-lid-map.json"),
      JSON.stringify({ [lid]: phone }),
    );
    await gateway.start();
    assert.equal(
      whatsAppOauthChat(store, "15550001111", (chat) =>
        gateway.outboundChat(chat),
      ),
      phone,
    );
    store.run("DELETE FROM channel_chats");
    assert.equal(
      whatsAppOauthChat(store, "15550001111", (chat) =>
        gateway.outboundChat(chat),
      ),
      "15550001111@s.whatsapp.net",
    );
  } finally {
    await gateway.close();
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp image and voice follow VISION_MODE and the size caps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-media-cap-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const submitted: Array<{ text: string; images?: unknown }> = [];
  app.submit = (async (
    _conversationId,
    _requestId,
    text,
    _source,
    _chat,
    _authorize,
    images,
  ) => {
    submitted.push({ text, images });
    return { submissionId: 1, conversationId: "c", requestId: "r" };
  }) as typeof app.submit;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(960, 20);
  const picture = png.toString("base64");
  const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString("base64");
  const voice = new Uint8Array(10 * 1024 * 1024 + 1);
  const previous = process.env.VISION_MODE;
  const chat = "15550007777@s.whatsapp.net";
  const inbound = (
    messageId: string,
    extra: Partial<InboundMessage>,
  ): InboundMessage => ({
    channel: "whatsapp",
    chatId: chat,
    senderId: chat,
    messageId,
    text: "cap",
    ...extra,
  });
  try {
    process.env.VISION_MODE = "text";
    await acceptWhatsAppMessage(
      app,
      inbound("img-text", {
        image: { data: picture, mimeType: "image/png" },
      }),
    );
    assert.match(submitted[0]?.text ?? "", /no model reads images/);
    assert.equal(submitted[0]?.images, undefined);
    process.env.VISION_MODE = "native";
    await acceptWhatsAppMessage(
      app,
      inbound("img-native", {
        image: { data: picture, mimeType: "image/png" },
      }),
    );
    assert.equal(Array.isArray(submitted[1]?.images), true);
    assert.match(submitted[1]?.text ?? "", /"model":"[^"]+\/[^"]+"/);
    await acceptWhatsAppMessage(
      app,
      inbound("img-big", { image: { data: huge, mimeType: "image/png" } }),
    );
    assert.match(submitted[2]?.text ?? "", /image exceeds the 5 MB limit/);
    assert.equal(submitted[2]?.images, undefined);
    await acceptWhatsAppMessage(
      app,
      inbound("aud-big", { audio: { data: voice, mimeType: "audio/ogg" } }),
    );
    assert.match(submitted[3]?.text ?? "", /audio exceeds the 10 MB limit/);
  } finally {
    if (previous === undefined) delete process.env.VISION_MODE;
    else process.env.VISION_MODE = previous;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an inbound WhatsApp message is answered on the same channel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-turn-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const sent: string[] = [];
  const channel = recordingChannel(async (_chat, text) => {
    sent.push(text);
    return { messageId: "reply-1" };
  });
  try {
    await acceptWhatsAppMessage(app, {
      channel: "whatsapp",
      chatId: JID,
      senderId: JID,
      messageId: "inbound-1",
      text: "ping",
    });
    const bound = app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM channel_chats WHERE channel='whatsapp' AND chatId=?",
      JID,
    );
    assert.ok(bound);
    const request = app.store.get<{ source: string; channel: string | null }>(
      "SELECT source,channel FROM requests WHERE conversationId=?",
      bound.conversationId,
    );
    assert.equal(request?.source, "whatsapp");
    app.store.run(
      "INSERT INTO meta(key,value) VALUES (?,?)",
      "whatsapp:seen:stale",
      String(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    await acceptWhatsAppMessage(app, {
      channel: "whatsapp",
      chatId: JID,
      senderId: JID,
      messageId: "inbound-1",
      text: "ping",
    });
    assert.equal(
      app.store.get("SELECT 1 FROM meta WHERE key=?", "whatsapp:seen:stale"),
      undefined,
    );
    assert.ok(
      app.store.get(
        "SELECT 1 FROM meta WHERE key=?",
        "whatsapp:seen:inbound-1",
      ),
    );
    await (await app.conversation(bound.conversationId)).waitForIdle(context);
    let sentRow: Delivery | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      await flushChannelDeliveries(app.store, channel);
      sentRow = app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE channel='whatsapp'",
      );
      if (sentRow?.state === "sent") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sentRow?.state, "sent");
    assert.match(sent.join("\n"), /Demo mode/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a LID and its phone stay one conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-alias-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const lid = "999000111222333@lid";
  try {
    const first = admitWhatsAppMessage({
      raw: {
        key: {
          remoteJid: lid,
          remoteJidAlt: JID,
          fromMe: false,
          id: "a",
        },
        message: { conversation: "hi" },
      },
      allowed: [OWNER],
      sentIds: new Set(),
    });
    assert.equal(first?.chatId, lid);
    assert.deepEqual(first?.aliases, [JID]);
    await acceptWhatsAppMessage(app, first!);
    const second = admitWhatsAppMessage({
      raw: {
        key: {
          remoteJid: JID,
          remoteJidAlt: lid,
          fromMe: false,
          id: "b",
        },
        message: { conversation: "again" },
      },
      allowed: [OWNER],
      sentIds: new Set(),
    });
    assert.equal(second?.chatId, JID);
    assert.deepEqual(second?.aliases, [lid]);
    await acceptWhatsAppMessage(app, second!);
    const rows = app.store.all<{ chatId: string; conversationId: string }>(
      "SELECT chatId, conversationId FROM channel_chats WHERE channel='whatsapp' ORDER BY chatId",
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.conversationId, rows[1]?.conversationId);
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 2);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp approvals are a numbered reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-approval-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const actions: string[] = [];
  app.mcpCalls = {
    decide: async (
      _conversationId: string,
      _id: string,
      action: "accept" | "decline" | "cancel",
    ) => {
      actions.push(action);
      return undefined;
    },
    close: async () => {},
  } as unknown as McpCalls;
  try {
    const id = await app.create("WhatsApp");
    app.store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      JID,
      id,
    );
    app.store.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_calls(
        id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL,
        tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
        binding TEXT NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_interactions(
        id TEXT PRIMARY KEY, callId TEXT NOT NULL, conversationId TEXT NOT NULL,
        server TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', response TEXT
      );
    `);
    app.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,?,?,?,?)",
      "call-1",
      id,
      "demo",
      "tools.demo.send",
      "{}",
      "pending",
      null,
      "binding",
      Date.now(),
    );
    app.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,?,?)",
      "int-1",
      "call-1",
      id,
      "demo",
      "form",
      JSON.stringify({
        message: "Send the mail?",
        requestedSchema: { type: "object", properties: {} },
      }),
      "pending",
      null,
    );
    queueWhatsappApprovals(app);
    const card = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id LIKE 'whatsapp:approval:%'",
    );
    assert.match(card?.text ?? "", /1\. Decline/);
    assert.equal((card?.text ?? "").includes("Approve"), false);
    assert.equal(card?.channel, "whatsapp");
    assert.equal(await takeNumberedApproval(app, id, JID, "9"), false);
    app.store.run("UPDATE deliveries SET state='sent' WHERE id=?", card!.id);
    assert.equal(await takeNumberedApproval(app, id, JID, "1"), true);
    assert.deepEqual(actions, ["decline"]);
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id LIKE 'whatsapp:approval-result:%'",
      )?.text ?? "",
      /Declined/,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp approval requires the full request delivered to the replying JID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-approval-binding-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const actions: string[] = [];
  app.mcpCalls = {
    decide: async (
      _conversationId: string,
      interactionId: string,
      action: string,
    ) => {
      actions.push(action);
      app.store.run(
        "UPDATE mcp_interactions SET state='accepted' WHERE id=?",
        interactionId,
      );
    },
    close: async () => {},
  } as unknown as McpCalls;
  try {
    const id = await app.create("WhatsApp");
    bindChannelChat(app.store, "whatsapp", JID, id);
    mcpTables(app.store);
    app.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,?,?,?,?)",
      "call-1",
      id,
      "gmail",
      "send_email",
      JSON.stringify({
        to: "recipient@example.test",
        subject: "Review",
        body: "Body",
      }),
      "pending",
      null,
      "binding",
      Date.now(),
    );
    app.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,?,?)",
      "int-1",
      "call-1",
      id,
      "gmail",
      "form",
      JSON.stringify({
        message: "Send?",
        requestedSchema: { type: "object", properties: {} },
      }),
      "pending",
      null,
    );
    queueWhatsappApprovals(app);
    const card = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id='whatsapp:approval:int-1:0'",
    )!;
    assert.match(card.text, /1\. Approve/);
    const assertPending = async (chat = JID) => {
      assert.equal(await takeNumberedApproval(app, id, chat, "1"), false);
      assert.deepEqual(actions, []);
      assert.equal(
        app.store.get<{ state: string }>(
          "SELECT state FROM mcp_interactions WHERE id='int-1'",
        )?.state,
        "pending",
      );
      assert.ok(
        app.store.get(
          "SELECT 1 FROM meta WHERE key=?",
          `whatsapp:approval:${id}`,
        ),
      );
    };
    for (const state of [
      "pending",
      "sending",
      "failed",
      "uncertain",
      "cancelled",
    ]) {
      app.store.run("UPDATE deliveries SET state=? WHERE id=?", state, card.id);
      await assertPending();
    }
    app.store.run("UPDATE deliveries SET state='sent' WHERE id=?", card.id);
    const other = "15550009999@s.whatsapp.net";
    bindChannelChat(app.store, "whatsapp", other, id);
    await assertPending(other);
    // A sent prompt for a different request does not authorize this one.
    app.store.run(
      "UPDATE deliveries SET id='whatsapp:approval:other:0' WHERE id=?",
      card.id,
    );
    await assertPending();
    app.store.run(
      "UPDATE deliveries SET id=? WHERE id='whatsapp:approval:other:0'",
      card.id,
    );
    queueWhatsApp(
      app.store,
      "whatsapp:approval:int-1:tail",
      JID,
      "More review",
      id,
    );
    await assertPending();
    app.store.run(
      "UPDATE deliveries SET state='sent' WHERE id LIKE 'whatsapp:approval:int-1:%'",
    );
    assert.equal(await takeNumberedApproval(app, id, JID, "1"), true);
    assert.deepEqual(actions, ["accept"]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale WhatsApp approval does not swallow the next reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-approval-stale-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const actions: string[] = [];
  app.mcpCalls = {
    decide: async (
      _conversationId: string,
      _id: string,
      action: "accept" | "decline" | "cancel",
    ) => {
      actions.push(action);
      return undefined;
    },
    close: async () => {},
  } as unknown as McpCalls;
  try {
    const id = await app.create("WhatsApp");
    app.store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      JID,
      id,
    );
    app.store.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_calls(
        id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL,
        tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
        binding TEXT NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_interactions(
        id TEXT PRIMARY KEY, callId TEXT NOT NULL, conversationId TEXT NOT NULL,
        server TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', response TEXT
      );
    `);
    const payload = JSON.stringify({
      message: "Send the mail?",
      requestedSchema: { type: "object", properties: {} },
    });
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      `whatsapp:approval:${id}`,
      JSON.stringify({ interactionId: "int-old", choices: ["decline"] }),
    );
    app.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,?,?)",
      "int-old",
      "call-old",
      id,
      "demo",
      "form",
      payload,
      "expired",
      null,
    );
    assert.equal(await takeNumberedApproval(app, id, JID, "1"), false);
    assert.deepEqual(actions, []);
    assert.equal(
      app.store.get(
        "SELECT 1 FROM meta WHERE key=?",
        `whatsapp:approval:${id}`,
      ),
      undefined,
    );
    app.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,?,?,?,?)",
      "call-new",
      id,
      "demo",
      "tools.demo.send",
      "{}",
      "pending",
      null,
      "binding",
      Date.now(),
    );
    app.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,?,?)",
      "int-new",
      "call-new",
      id,
      "demo",
      "form",
      payload,
      "pending",
      null,
    );
    queueWhatsappApprovals(app);
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id LIKE 'whatsapp:approval:%'",
      )?.text ?? "",
      /1\. Decline/,
    );
    app.store.run(
      "UPDATE deliveries SET state='sent' WHERE id LIKE 'whatsapp:approval:%'",
    );
    assert.equal(await takeNumberedApproval(app, id, JID, "1"), true);
    assert.deepEqual(actions, ["decline"]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup keeps one phone gateway and does not require a Telegram token for WhatsApp", async () => {
  assert.equal(routeWhatsappMenu("1"), "number");
  assert.equal(routeWhatsappMenu("2"), "pair");
  assert.equal(routeWhatsappMenu("3"), "code");
  const whatsapp = readConfig({}, undefined, undefined, {
    gateway: "whatsapp",
  });
  assert.equal(whatsapp.token, "");
  assert.throws(() => readConfig({}), SetupRequiredError);
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-setup-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredTelegram(db, ["42"], "123456:fake-local-only");
    writePhoneGateway(db, "telegram");
    writeStoredWhatsapp(db, ["+1 (555) 123-4567", "1 555 765 4321"]);
    writePhoneGateway(db, "whatsapp");
    assert.equal(readPhoneGateway(dir), "whatsapp");
    assert.deepEqual(readStoredWhatsapp(dir).users, [OWNER, "15557654321"]);
    writePhoneGateway(db, "telegram");
    assert.equal(readPhoneGateway(dir), "telegram");
    assert.deepEqual(readStoredWhatsapp(dir).users, [OWNER, "15557654321"]);
    assert.deepEqual(
      resolveWhatsappUsers({ WHATSAPP_ALLOWED_USERS: "15550001111" }, {}),
      ["15550001111"],
    );
    const with9 = "5500900000001";
    const without9 = "550000000001";
    assert.deepEqual(parseWhatsappNumbers(with9), [with9]);
    assert.deepEqual(parseWhatsappNumbers(`55 00 0000-0001`), [without9]);
    writeStoredWhatsapp(db, [with9]);
    assert.deepEqual(readStoredWhatsapp(dir).users, [with9]);
    writeStoredWhatsapp(db, [without9]);
    assert.deepEqual(readStoredWhatsapp(dir).users, [without9]);
    assert.equal(
      admitWhatsAppMessage({
        raw: textMessage("br-own", true, `${without9}@s.whatsapp.net`),
        allowed: ["19998887777"],
        ownJid: `${with9}:1@s.whatsapp.net`,
        sentIds: new Set(),
      })?.chatId,
      `${without9}@s.whatsapp.net`,
    );
    assert.equal(
      admitWhatsAppMessage({
        raw: textMessage("br-list", false, `${without9}@s.whatsapp.net`),
        allowed: [with9],
        sentIds: new Set(),
      })?.chatId,
      `${without9}@s.whatsapp.net`,
    );
    assert.equal(
      admitWhatsAppMessage({
        raw: textMessage("br-rev", false, `${with9}@s.whatsapp.net`),
        allowed: [without9],
        sentIds: new Set(),
      })?.chatId,
      `${with9}@s.whatsapp.net`,
    );
    assert.equal(
      admitWhatsAppMessage({
        raw: textMessage("br-other", false, "5500911111111@s.whatsapp.net"),
        allowed: [with9],
        sentIds: new Set(),
      }),
      undefined,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("a redelivered echo after restart does not start a turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-sent-"));
  const sessionDir = join(dir, "auth");
  const first = socketHarness();
  const gateway = new WhatsAppGateway({
    sessionDir,
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => first.socket,
  });
  try {
    await gateway.start();
    first.open();
    assert.equal(gateway.live, true);
    await gateway.sendText(JID, "pong");
    assert.equal(first.sent[0]?.text, "Pi: pong");
    const saved = JSON.parse(
      await readFile(join(dir, "whatsapp-sent.json"), "utf8"),
    ) as Array<{ id: string }>;
    assert.deepEqual(
      saved.map((row) => row.id),
      ["out-1"],
    );
    await gateway.close();
    assert.equal(gateway.live, false);
    const seen: string[] = [];
    const second = socketHarness();
    const again = new WhatsAppGateway({
      sessionDir,
      allowed: [OWNER],
      onMessage: async (message) => {
        seen.push(message.messageId);
      },
      socketFactory: () => second.socket,
    });
    await again.start();
    second.open();
    second.upsert(textMessage("out-1", true));
    await tick();
    assert.deepEqual(seen, []);
    await again.close();
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sent ids expire and stay capped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-sent-cap-"));
  const now = Date.now();
  const rows = [
    { id: "stale-echo", at: now - 8 * 24 * 60 * 60 * 1000 },
    { id: "echo-old", at: now - 10_000 },
  ];
  for (let index = 0; index < 200; index++)
    rows.push({ id: `keep-${index}`, at: now - 9_000 + index });
  await mkdir(join(dir, "auth"), { recursive: true });
  await writeFile(
    join(dir, "whatsapp-sent.json"),
    JSON.stringify(rows),
    "utf8",
  );
  const seen: string[] = [];
  const harness = socketHarness();
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async (message) => {
      seen.push(message.messageId);
    },
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    harness.upsert(textMessage("stale-echo", true));
    harness.upsert(textMessage("echo-old", true));
    harness.upsert(textMessage("keep-199", true));
    await tick();
    assert.deepEqual(seen, ["stale-echo", "echo-old"]);
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("history append does not start a turn and a recent append does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-append-"));
  const seen: string[] = [];
  const lines: string[] = [];
  const original = console.info;
  console.info = ((line?: unknown) => {
    lines.push(String(line));
  }) as typeof console.info;
  const harness = socketHarness();
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async (message) => {
      seen.push(message.messageId);
    },
    socketFactory: () => harness.socket,
  });
  const old = Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000);
  const recent = Math.floor(Date.now() / 1000);
  try {
    await gateway.start();
    harness.open();
    harness.upsert({ ...textMessage("old-notify"), messageTimestamp: old });
    harness.upsert(
      { ...textMessage("old-append"), messageTimestamp: old },
      "append",
    );
    harness.upsert(textMessage("no-time"), "append");
    harness.upsert(
      { ...textMessage("recent"), messageTimestamp: recent },
      "append",
    );
    harness.upsert(
      {
        ...textMessage("recent-long"),
        messageTimestamp: { low: recent >>> 0, high: 0 },
      },
      "append",
    );
    await tick();
    assert.deepEqual(seen, ["old-notify", "recent", "recent-long"]);
    const logged = lines.join("\n");
    assert.match(logged, /dropped inbound \(history\)/);
    assert.equal(logged.includes(OWNER), false);
  } finally {
    console.info = original;
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("typing and a changed LID pair use the phone JID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-pair-"));
  const lid = "999000111222333@lid";
  const first = "15550001111@s.whatsapp.net";
  const second = "15550002222@s.whatsapp.net";
  const presence: string[] = [];
  const harness = socketHarness();
  harness.socket.sendPresenceUpdate = async (_presence, jid) => {
    presence.push(jid);
  };
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: ["15550001111", "15550002222"],
    onMessage: async () => {},
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    harness.upsert({
      key: { remoteJid: lid, remoteJidAlt: first, id: "p1", fromMe: false },
      message: { conversation: "one" },
    });
    await tick();
    assert.deepEqual(presence, [first]);
    harness.upsert({
      key: { remoteJid: lid, remoteJidAlt: second, id: "p2", fromMe: false },
      message: { conversation: "two" },
    });
    await tick();
    assert.deepEqual(presence, [first, second]);
    await gateway.sendText(lid, "go");
    assert.equal(harness.sent.at(-1)?.jid, second);
    const map = JSON.parse(
      await readFile(join(dir, "whatsapp-lid-map.json"), "utf8"),
    ) as Record<string, string>;
    assert.equal(map[lid], second);
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a group or unknown image is not downloaded and does not write the LID map", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-admit-first-"));
  const harness = socketHarness();
  let downloads = 0;
  const seen: InboundMessage[] = [];
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async (message) => {
      seen.push(message);
    },
    downloadMedia: async () => {
      downloads += 1;
      return { data: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
    },
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    harness.upsert({
      key: {
        remoteJid: "120363000@g.us",
        participant: "999000111222333@lid",
        participantAlt: "15550001111@s.whatsapp.net",
        id: "group-img",
        fromMe: false,
      },
      message: { imageMessage: { mimetype: "image/jpeg" } },
    });
    harness.upsert({
      key: {
        remoteJid: "888000111222333@lid",
        remoteJidAlt: "15559998888@s.whatsapp.net",
        id: "stranger-img",
        fromMe: false,
      },
      message: { imageMessage: { mimetype: "image/jpeg" } },
    });
    harness.upsert({
      key: { remoteJid: JID, id: "owner-img", fromMe: false },
      message: { imageMessage: { mimetype: "image/jpeg" } },
    });
    await tick();
    assert.equal(downloads, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.messageId, "owner-img");
    assert.equal(seen[0]?.image?.mimeType, "image/jpeg");
    let map = "";
    try {
      map = await readFile(join(dir, "whatsapp-lid-map.json"), "utf8");
    } catch {
      map = "";
    }
    assert.equal(map.includes("999000111222333"), false);
    assert.equal(map.includes("888000111222333"), false);
    assert.equal(map.includes("15559998888"), false);
    assert.equal(map.includes("15550001111"), false);
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("@hosted is a phone JID and @hosted.lid stays a LID", async () => {
  const admitted = admitWhatsAppMessage({
    raw: textMessage("host", false, `${OWNER}@hosted`),
    allowed: [OWNER],
    sentIds: new Set(),
  });
  assert.equal(admitted?.chatId, `${OWNER}@hosted`);
  assert.equal(
    admitWhatsAppMessage({
      raw: textMessage("hlid", false, "123456789012345@hosted.lid"),
      allowed: [OWNER],
      sentIds: new Set(),
    }),
    undefined,
  );
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-hosted-"));
  const harness = socketHarness();
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    await gateway.sendText(`${OWNER}@hosted`, "hi");
    await gateway.sendText("123456789012345@hosted.lid", "x");
    assert.equal(harness.sent[0]?.jid, JID);
    assert.equal(harness.sent[1]?.jid, "123456789012345@hosted.lid");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connection, pairing and inbound errors mask long numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-mask-"));
  const lines: string[] = [];
  const original = console.error;
  console.error = ((line?: unknown) => {
    lines.push(String(line));
  }) as typeof console.error;
  const harness = socketHarness();
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    pairingPhone: OWNER,
    onQr: () => {},
    onMessage: async () => {
      throw new Error(`inbound ${OWNER}`);
    },
    onOpen: () => {
      throw new Error(`update ${OWNER}`);
    },
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.socket.requestPairingCode = async () => {
      throw new Error(`code failed ${OWNER}`);
    };
    harness.qr("qr");
    harness.open();
    harness.upsert(textMessage("mask-1"));
    await tick();
    const logged = lines.join("\n");
    assert.match(logged, /connection update failed/);
    assert.match(logged, /pairing code failed/);
    assert.match(logged, /inbound failed/);
    assert.equal(logged.includes(OWNER), false);
    assert.match(logged, /\*\*\*4567/);
  } finally {
    console.error = original;
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a WhatsApp reply is stored as plain text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-plain-"));
  const store = new Store(dir);
  try {
    store.queueTelegram(
      "md",
      JID,
      "para **bold**\n\n",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    const row = store.get<Delivery>("SELECT * FROM deliveries WHERE id='md:0'");
    assert.equal(row?.text, "para *bold*\n\n");
    assert.equal(row?.parseMode, null);
    store.queueTelegram(
      "fmt",
      JID,
      "## Title\nsee [docs](https://example.com/a)",
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    assert.equal(
      store.get<Delivery>("SELECT * FROM deliveries WHERE id='fmt:0'")?.text,
      "*Title*\nsee docs (https://example.com/a)",
    );
    store.queueTelegram("tg", "1", "para **bold**");
    const telegram = store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id='tg:0'",
    );
    assert.equal(telegram?.parseMode, "HTML");
    assert.match(telegram?.text ?? "", /<b>bold<\/b>/);
    const long = "a".repeat(4000);
    store.queueTelegram(
      "long",
      JID,
      long,
      3500,
      undefined,
      undefined,
      undefined,
      undefined,
      "whatsapp",
    );
    const parts = store.all<Delivery>(
      "SELECT * FROM deliveries WHERE id>=? AND id<? ORDER BY id",
      "long:",
      "long;",
    );
    assert.equal(parts.length, 2);
    assert.equal(parts[0]?.text.length, 3800);
    assert.equal(`${parts[0]?.text ?? ""}${parts[1]?.text ?? ""}`, long);
    assert.equal(parts[0]?.parseMode, null);
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("view-once and edited messages unwrap to the inner text", () => {
  const edited = admitWhatsAppMessage({
    raw: {
      key: { remoteJid: JID, id: "edit-1", fromMe: false },
      message: { editedMessage: { message: { conversation: "edited hello" } } },
    },
    allowed: [OWNER],
    sentIds: new Set(),
  });
  assert.equal(edited?.text, "edited hello");
  const once = admitWhatsAppMessage({
    raw: {
      key: { remoteJid: JID, id: "once-1", fromMe: false },
      message: {
        viewOnceMessageV2: {
          message: { conversation: "secret" },
        },
      },
    },
    allowed: [OWNER],
    sentIds: new Set(),
  });
  assert.equal(once?.text, "secret");
  const extension = admitWhatsAppMessage({
    raw: {
      key: { remoteJid: JID, id: "once-2", fromMe: false },
      message: {
        viewOnceMessageV2Extension: {
          message: { conversation: "more" },
        },
      },
    },
    allowed: [OWNER],
    sentIds: new Set(),
  });
  assert.equal(extension?.text, "more");
});

test("video and non-image documents get the Telegram notice and do not start a turn", async () => {
  const image = admitWhatsAppMessage({
    raw: {
      key: { remoteJid: JID, id: "doc-img", fromMe: false },
      message: {
        documentMessage: { mimetype: "image/png", caption: "shot" },
      },
    },
    allowed: [OWNER],
    sentIds: new Set(),
    media: { data: new Uint8Array([1, 2]), mimeType: "image/png" },
  });
  assert.equal(image?.unsupported, undefined);
  assert.equal(image?.text, "shot");
  assert.equal(image?.image?.mimeType, "image/png");
  const video = admitWhatsAppMessage({
    raw: {
      key: { remoteJid: JID, id: "vid-1", fromMe: false },
      message: { videoMessage: { caption: "look" } },
    },
    allowed: [OWNER],
    sentIds: new Set(),
  });
  assert.equal(video?.unsupported, true);
  assert.match(video?.text ?? "", /only read images/);
  assert.equal((video?.text ?? "").includes("look"), false);
  const pdf = admitWhatsAppMessage({
    raw: {
      key: { remoteJid: JID, id: "pdf-1", fromMe: false },
      message: { documentMessage: { mimetype: "application/pdf" } },
    },
    allowed: [OWNER],
    sentIds: new Set(),
  });
  assert.equal(pdf?.unsupported, true);
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-video-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  let downloads = 0;
  const seen: Array<{ unsupported?: boolean }> = [];
  const harness = socketHarness();
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async (message) => {
      seen.push(message);
    },
    downloadMedia: async () => {
      downloads += 1;
      return { data: new Uint8Array([1]), mimeType: "image/png" };
    },
    socketFactory: () => harness.socket,
  });
  try {
    await gateway.start();
    harness.open();
    harness.upsert({
      key: { remoteJid: JID, id: "vid-live", fromMe: false },
      message: { videoMessage: { caption: "look" } },
    });
    harness.upsert({
      key: { remoteJid: JID, id: "png-live", fromMe: false },
      message: { documentMessage: { mimetype: "image/png", caption: "shot" } },
    });
    await tick();
    assert.equal(downloads, 1);
    assert.equal(seen[0]?.unsupported, true);
    assert.equal(seen[1]?.unsupported, undefined);
    assert.ok(video);
    await acceptWhatsAppMessage(app, video);
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 0);
    const notice = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id LIKE 'whatsapp:unsupported:%'",
    );
    assert.match(notice?.text ?? "", /only read images/);
    assert.equal(notice?.parseMode, null);
  } finally {
    await gateway.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function mcpTables(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_calls(
      id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL,
      tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
      binding TEXT NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_interactions(
      id TEXT PRIMARY KEY, callId TEXT NOT NULL, conversationId TEXT NOT NULL,
      server TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', response TEXT
    );
  `);
}

test("a failed approval decision does not consume the reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-decide-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  let mode: "pending" | "expired" = "pending";
  app.mcpCalls = {
    decide: async (_conversationId: string, interactionId: string) => {
      if (mode === "expired")
        app.store.run(
          "UPDATE mcp_interactions SET state='expired' WHERE id=?",
          interactionId,
        );
      throw new Error("decide failed");
    },
    list: () => [],
    close: async () => {},
  } as unknown as McpCalls;
  try {
    const id = await app.create("WhatsApp");
    app.store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      JID,
      id,
    );
    mcpTables(app.store);
    const payload = JSON.stringify({
      message: "Send the mail?",
      requestedSchema: { type: "object", properties: {} },
    });
    app.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,?,?)",
      "int-1",
      "call-1",
      id,
      "demo",
      "form",
      payload,
      "pending",
      null,
    );
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      `whatsapp:approval:${id}`,
      JSON.stringify({ interactionId: "int-1", choices: ["decline"] }),
    );
    queueWhatsApp(app.store, "whatsapp:approval:int-1", JID, "1. Decline", id);
    app.store.run(
      "UPDATE deliveries SET state='sent' WHERE id LIKE 'whatsapp:approval:%'",
    );
    await acceptWhatsAppMessage(app, {
      channel: "whatsapp",
      chatId: JID,
      senderId: JID,
      messageId: "decide-1",
      text: "1",
    });
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 1);
    assert.ok(
      app.store.get(
        "SELECT 1 FROM meta WHERE key=?",
        `whatsapp:approval:${id}`,
      ),
    );
    assert.equal(
      app.store.get(
        "SELECT 1 FROM deliveries WHERE id LIKE 'whatsapp:approval-error:%'",
      ),
      undefined,
    );
    mode = "expired";
    await acceptWhatsAppMessage(app, {
      channel: "whatsapp",
      chatId: JID,
      senderId: JID,
      messageId: "decide-2",
      text: "1",
    });
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 2);
    assert.equal(
      app.store.get(
        "SELECT 1 FROM meta WHERE key=?",
        `whatsapp:approval:${id}`,
      ),
      undefined,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a WhatsApp approval expires after 24 hours and clears only its meta", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-expire-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  app.mcpCalls = {
    decide: async () => undefined,
    close: async () => {},
  } as unknown as McpCalls;
  try {
    const id = await app.create("WhatsApp");
    const other = await app.create("WhatsApp");
    mcpTables(app.store);
    const payload = JSON.stringify({
      message: "Send the mail?",
      requestedSchema: { type: "object", properties: {} },
    });
    const old = String(Date.now() - 25 * 60 * 60 * 1000);
    for (const item of [
      { id: "int-1", call: "call-1", conversation: id },
      { id: "int-2", call: "call-2", conversation: other },
    ]) {
      app.store.run(
        "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,?,?)",
        item.id,
        item.call,
        item.conversation,
        "demo",
        "form",
        payload,
        "pending",
        null,
      );
      app.store.run(
        "INSERT INTO meta VALUES (?,?)",
        `telegram:approval-at:${item.id}`,
        old,
      );
    }
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      `whatsapp:approval:${id}`,
      JSON.stringify({ interactionId: "int-newer", choices: ["decline"] }),
    );
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      `whatsapp:approval:${other}`,
      JSON.stringify({ interactionId: "int-2", choices: ["decline"] }),
    );
    app.store.run(
      "INSERT INTO channel_chats VALUES (?,?,?)",
      "whatsapp",
      JID,
      other,
    );
    await sweepMcpApprovals(app);
    assert.equal(
      app.store.get<{ state: string }>(
        "SELECT state FROM mcp_interactions WHERE id='int-2'",
      )?.state,
      "expired",
    );
    assert.ok(
      app.store.get(
        "SELECT 1 FROM meta WHERE key=?",
        `whatsapp:approval:${id}`,
      ),
    );
    assert.equal(
      app.store.get(
        "SELECT 1 FROM meta WHERE key=?",
        `whatsapp:approval:${other}`,
      ),
      undefined,
    );
    const notice = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id='whatsapp:approval-expired:int-2:0'",
    );
    assert.match(notice?.text ?? "", /within 24 hours/);
    assert.equal(notice?.parseMode, null);
    assert.equal(notice?.chat, JID);
    assert.equal(
      app.store.get(
        "SELECT 1 FROM deliveries WHERE id='whatsapp:approval-expired:int-1:0'",
      ),
      undefined,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-chat replies start with Pi: and other chats do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-pi-"));
  const harness = socketHarness(OWN_LID);
  const sent: Array<Record<string, unknown>> = [];
  harness.socket.sendMessage = async (_jid, content) => {
    sent.push(content);
    return { key: { id: `out-${sent.length}` } };
  };
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => harness.socket,
  });
  const photo = Buffer.from("img").toString("base64");
  try {
    await gateway.start();
    harness.open();
    await gateway.sendText(JID, "hello\n\n");
    await gateway.sendText(SELF_LID, "Pi: already");
    await gateway.sendText("15550009999@s.whatsapp.net", "plain");
    await gateway.sendMedia(JID, {
      kind: "photo",
      data: photo,
      mimeType: "image/jpeg",
      caption: "cap\n",
    });
    await gateway.sendMedia(SELF_LID, {
      kind: "photo",
      data: photo,
      mimeType: "image/jpeg",
      caption: "\n",
    });
    assert.equal(sent[0]?.text, "Pi: hello");
    assert.equal(sent[1]?.text, "Pi: already");
    assert.equal(sent[2]?.text, "plain");
    assert.equal(sent[3]?.caption, "Pi: cap");
    assert.equal("caption" in sent[4]!, false);
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty from-me sync is not logged and pairing stays quiet", async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = ((line?: unknown) => {
    lines.push(String(line));
  }) as typeof console.info;
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-quiet-"));
  try {
    admitWhatsAppMessage({
      raw: {
        key: { remoteJid: SELF_LID, id: "sync", fromMe: true },
        message: { protocolMessage: { type: 0 } },
      },
      allowed: [OWNER],
      ownJid: `${OWNER}:1@s.whatsapp.net`,
      ownLid: OWN_LID,
      sentIds: new Set(),
    });
    admitWhatsAppMessage({
      raw: {
        key: { remoteJid: JID, id: "blank", fromMe: false },
        message: {},
      },
      allowed: [OWNER],
      ownJid: `${OWNER}:1@s.whatsapp.net`,
      sentIds: new Set(),
    });
    const harness = socketHarness();
    const gateway = new WhatsAppGateway({
      sessionDir: join(dir, "auth"),
      allowed: [OWNER],
      quiet: true,
      onMessage: async () => {},
      socketFactory: () => harness.socket,
    });
    await gateway.start();
    harness.open();
    harness.upsert({
      key: { remoteJid: "120363000@g.us", id: "group", fromMe: false },
      message: { conversation: "nope" },
    });
    await tick();
    await gateway.close();
    const logged = lines.join("\n");
    assert.equal(logged.includes("fromMe=true"), false);
    assert.equal(logged.includes("dropped inbound (group)"), false);
    assert.match(
      logged,
      /dropped inbound \(empty\) \*\*\*4567 remote=pn alt=no fromMe=false/,
    );
    assert.equal(logged.includes(OWNER), false);
  } finally {
    console.info = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup pairing does not print inbound drops", async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = ((line?: unknown) => {
    lines.push(String(line));
  }) as typeof console.info;
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-pair-quiet-"));
  try {
    await pairWhatsApp(join(dir, "auth"), {
      socketFactory: () => {
        const harness = socketHarness();
        setTimeout(() => {
          harness.upsert({
            key: { remoteJid: "120363000@g.us", id: "g", fromMe: true },
            message: { conversation: "x" },
          });
          harness.upsert({
            key: { remoteJid: SELF_LID, id: "sync", fromMe: true },
            message: { protocolMessage: { type: 0 } },
          });
          harness.open();
        }, 0);
        return harness.socket;
      },
    });
    assert.equal(lines.join("\n").includes("dropped inbound"), false);
  } finally {
    console.info = original;
    await rm(dir, { recursive: true, force: true });
  }
});

function whatsappText(chatId: string, messageId: string, text: string) {
  return {
    channel: "whatsapp" as const,
    chatId,
    senderId: chatId,
    messageId,
    text,
  };
}

test("WhatsApp memory commands read and forget notes without starting a turn", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-memory-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "memory"));
  await writeFile(join(dir, "memory", "MEMORY.md"), "- Prefers tea\n");
  const chat = "15550001111@s.whatsapp.net";
  for (const [index, text] of [
    "/memoria",
    "/esquecer tea",
    "/memoria",
  ].entries())
    await acceptWhatsAppMessage(
      app,
      whatsappText(chat, `memory${index}`, text),
    );
  const replies = app.store.all<{ text: string }>(
    "SELECT text FROM deliveries WHERE channel='whatsapp' ORDER BY rowid",
  );
  assert.match(replies[0]?.text ?? "", /Prefers tea/);
  assert.match(replies[1]?.text ?? "", /Removed 1/);
  assert.match(replies[2]?.text ?? "", /Memory is empty/);
  assert.deepEqual(app.store.all("SELECT requestId FROM requests"), []);
});

test("a WhatsApp slash command replies and does not start a turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-cmd-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const chat = "15550001111@s.whatsapp.net";
  try {
    await acceptWhatsAppMessage(app, whatsappText(chat, "c1", "/status"));
    await acceptWhatsAppMessage(app, whatsappText(chat, "c1", "/help"));
    await acceptWhatsAppMessage(app, whatsappText(chat, "c2", "/nope"));
    await acceptWhatsAppMessage(app, whatsappText(chat, "c3", "  /Help"));
    await acceptWhatsAppMessage(app, whatsappText(chat, "c4", "/status extra"));
    const texts = app.store
      .all<Delivery>(
        "SELECT * FROM deliveries WHERE channel='whatsapp' ORDER BY rowid",
      )
      .map((row) => row.text);
    assert.equal(texts.length, 4);
    assert.match(texts[0] ?? "", /Runs in this chat/);
    assert.match(texts[0] ?? "", /^Models:/);
    assert.equal((texts[0] ?? "").startsWith("Pi:"), false);
    assert.match(texts[1] ?? "", /Unknown command\.\n\/status —/);
    assert.match(texts[2] ?? "", /^\/status —/);
    assert.match(texts[3] ?? "", /Unknown command/);
    await acceptWhatsAppMessage(app, whatsappText(chat, "c4b", "/model extra"));
    assert.match(
      app.store.get<Delivery>(
        "SELECT text FROM deliveries WHERE id=?",
        "whatsapp:cmd:c4b:0",
      )?.text ?? "",
      /Reply with the number/,
    );
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 0);
    await acceptWhatsAppMessage(app, whatsappText(chat, "c5", "//status"));
    await acceptWhatsAppMessage(app, whatsappText(chat, "c6", "ping"));
    const requests = app.store.all<{ text: string }>(
      "SELECT text FROM requests ORDER BY rowid",
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.text, "/status");
    assert.equal(requests[1]?.text, "ping");
    await acceptWhatsAppMessage(app, {
      ...whatsappText(chat, "c7", "/status"),
      image: { data: "not-an-image", mimeType: "image/jpeg" },
    });
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 3);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp /new keeps the previous conversation and binds the chat to the new one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-new-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const chat = "15550002222@s.whatsapp.net";
  try {
    await acceptWhatsAppMessage(app, whatsappText(chat, "n1", "/status"));
    const first = app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM channel_chats WHERE channel='whatsapp' AND chatId=?",
      chat,
    );
    await acceptWhatsAppMessage(app, whatsappText(chat, "n2", "/new"));
    const second = app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM channel_chats WHERE channel='whatsapp' AND chatId=?",
      chat,
    );
    assert.ok(first?.conversationId);
    assert.ok(second?.conversationId);
    assert.notEqual(first.conversationId, second.conversationId);
    assert.equal(app.store.conversationDeleted(first.conversationId), false);
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:n2:0'",
      )?.text ?? "",
      /previous one stays/,
    );
    await acceptWhatsAppMessage(app, whatsappText(chat, "n3", "hello"));
    const request = app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM requests WHERE requestId='wa:n3'",
    );
    assert.equal(request?.conversationId, second.conversationId);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp /new binds the phone after the LID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-new-order-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const lid = "999000111222444@lid";
  try {
    await acceptWhatsAppMessage(app, {
      ...whatsappText(JID, "order-1", "/new"),
      aliases: [lid],
    });
    const rows = app.store.all<{ chatId: string }>(
      "SELECT chatId FROM channel_chats WHERE channel='whatsapp' ORDER BY rowid",
    );
    assert.deepEqual(
      rows.map((row) => row.chatId),
      [lid, JID],
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp /stop cancels pending work and is admitted as a turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-stop-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const cancelled: string[] = [];
  app.mcpCalls = {
    cancelConversation(id: string) {
      cancelled.push(id);
    },
    close: async () => {},
  } as unknown as McpCalls;
  const chat = "15550003333@s.whatsapp.net";
  try {
    await acceptWhatsAppMessage(app, whatsappText(chat, "s1", "/stop"));
    const bound = app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM channel_chats WHERE channel='whatsapp' AND chatId=?",
      chat,
    );
    assert.deepEqual(cancelled, [bound?.conversationId]);
    const request = app.store.get<{ text: string }>(
      "SELECT text FROM requests WHERE requestId='wa:s1'",
    );
    assert.equal(request?.text, "/stop");
    assert.equal(
      app.store.get("SELECT 1 FROM deliveries WHERE id='whatsapp:cmd:s1:0'"),
      undefined,
    );
    await acceptWhatsAppMessage(app, whatsappText(chat, "s2", "/cancel"));
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:s2:0'",
      )?.text ?? "",
      /Unknown command/,
    );
    assert.equal(
      app.store.get("SELECT 1 FROM requests WHERE requestId='wa:s2'"),
      undefined,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp turns show the model notice and the busy line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-busy-"));
  const app = await Runtime.open({
    dir,
    mode: "live",
    gateway: { catalog: async () => [] },
  });
  app.submit = (async () => ({
    submissionId: 1,
    conversationId: "c",
    requestId: "r",
  })) as unknown as typeof app.submit;
  const chat = "15550006666@s.whatsapp.net";
  try {
    await acceptWhatsAppMessage(app, whatsappText(chat, "b1", "hello"));
    assert.match(
      app.store.get<Delivery>(
        "SELECT text FROM deliveries WHERE id='whatsapp:model-notice:b1:0'",
      )?.text ?? "",
      /no default model/,
    );
    await acceptWhatsAppMessage(app, whatsappText(chat, "b2", "again"));
    assert.equal(
      app.store.get(
        "SELECT 1 FROM deliveries WHERE id='whatsapp:model-notice:b2:0'",
      ),
      undefined,
    );
    app.isTurnBusy = () => true;
    app.markTurnBusyNotified = () => true;
    await acceptWhatsAppMessage(app, whatsappText(chat, "b3", "while busy"));
    assert.match(
      app.store.get<Delivery>(
        "SELECT text FROM deliveries WHERE id='whatsapp:busy:b3:0'",
      )?.text ?? "",
      /^Got it\. I will take that into account\. \/stop cancels\.$/,
    );
    await acceptWhatsAppMessage(app, whatsappText(chat, "b4", "/stop"));
    assert.equal(
      app.store.get("SELECT 1 FROM deliveries WHERE id='whatsapp:busy:b4:0'"),
      undefined,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a WhatsApp model number sets the model and an approval number wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-model-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const actions: string[] = [];
  app.mcpCalls = {
    decide: async (
      _conversationId: string,
      _id: string,
      action: "accept" | "decline" | "cancel",
    ) => {
      actions.push(action);
      return undefined;
    },
    close: async () => {},
  } as unknown as McpCalls;
  const chat = "15550004444@s.whatsapp.net";
  try {
    await acceptWhatsAppMessage(app, whatsappText(chat, "m1", "/model"));
    let guard = 0;
    while (guard < 4) {
      const open = app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE channel='whatsapp' ORDER BY rowid DESC LIMIT 1",
      );
      if (!open?.text.includes("Reply with the number")) break;
      guard += 1;
      await acceptWhatsAppMessage(
        app,
        whatsappText(chat, `m-pick-${guard}`, "1"),
      );
    }
    const last = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE channel='whatsapp' ORDER BY rowid DESC LIMIT 1",
    );
    assert.match(last?.text ?? "", /Model set to/);
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 0);
    await acceptWhatsAppMessage(app, whatsappText(chat, "m2", "/thinking"));
    await acceptWhatsAppMessage(app, whatsappText(chat, "m3", "1"));
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:m3:0'",
      )?.text ?? "",
      /^Effort set to/,
    );
    const id = app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM channel_chats WHERE channel='whatsapp' AND chatId=?",
      chat,
    )!.conversationId;
    app.store.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_calls(
        id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL,
        tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
        binding TEXT NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_interactions(
        id TEXT PRIMARY KEY, callId TEXT NOT NULL, conversationId TEXT NOT NULL,
        server TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', response TEXT
      );
    `);
    app.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,?,?,?,?)",
      "call-1",
      id,
      "demo",
      "tools.demo.send",
      "{}",
      "pending",
      null,
      "binding",
      Date.now(),
    );
    app.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,?,?)",
      "int-1",
      "call-1",
      id,
      "demo",
      "form",
      JSON.stringify({
        message: "Send the mail?",
        requestedSchema: { type: "object", properties: {} },
      }),
      "pending",
      null,
    );
    await acceptWhatsAppMessage(app, whatsappText(chat, "m4", "/thinking"));
    queueWhatsappApprovals(app);
    app.store.run(
      "UPDATE deliveries SET state='sent' WHERE id LIKE 'whatsapp:approval:%'",
    );
    await acceptWhatsAppMessage(app, whatsappText(chat, "m5", "1"));
    assert.deepEqual(actions, ["decline"]);
    assert.equal(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:m5:0'",
      ),
      undefined,
    );
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp /crons toggles a schedule in this chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-cron-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const chat = "15550005555@s.whatsapp.net";
  try {
    await acceptWhatsAppMessage(app, whatsappText(chat, "k1", "/crons"));
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:k1:0'",
      )?.text ?? "",
      /No schedules in this chat/,
    );
    const id = app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM channel_chats WHERE channel='whatsapp' AND chatId=?",
      chat,
    )!.conversationId;
    await app.tasks.create({
      title: "Morning",
      prompt: "Say hi",
      kind: "cron",
      schedule: "0 9 * * *",
      timezone: "UTC",
      conversationId: id,
      delivery: "none",
      enabled: true,
    });
    await acceptWhatsAppMessage(app, whatsappText(chat, "k2", "/crons"));
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:k2:0'",
      )?.text ?? "",
      /1\. Morning — on — 0 9 \* \* \*/,
    );
    await acceptWhatsAppMessage(app, whatsappText(chat, "k3", "1"));
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:k3:0'",
      )?.text ?? "",
      /^Off: Morning\./,
    );
    assert.equal(app.tasks.list()[0]?.enabled, false);
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp /compact and /resume reply without a model turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-compact-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const chat = "15550006666@s.whatsapp.net";
  try {
    await acceptWhatsAppMessage(app, whatsappText(chat, "p1", "/resume"));
    await acceptWhatsAppMessage(
      app,
      whatsappText(chat, "p2", "/compact focus"),
    );
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:p1:0'",
      )?.text ?? "",
      /Nothing is pending in this chat|Resumed /,
    );
    assert.match(
      app.store.get<Delivery>(
        "SELECT * FROM deliveries WHERE id='whatsapp:cmd:p2:0'",
      )?.text ?? "",
      /compact/i,
    );
    assert.equal(app.store.all("SELECT requestId FROM requests").length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a WhatsApp command reply is prefixed only in the linked account chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-cmd-prefix-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { catalog: async () => [] },
  });
  const harness = socketHarness(OWN_LID);
  const sent: Array<Record<string, unknown>> = [];
  harness.socket.sendMessage = async (_jid, content) => {
    sent.push(content);
    return { key: { id: `out-${sent.length}` } };
  };
  const gateway = new WhatsAppGateway({
    sessionDir: join(dir, "auth"),
    allowed: [OWNER],
    onMessage: async () => {},
    socketFactory: () => harness.socket,
  });
  try {
    await acceptWhatsAppMessage(app, whatsappText(JID, "pre1", "/help"));
    const stored = app.store.get<Delivery>(
      "SELECT * FROM deliveries WHERE id='whatsapp:cmd:pre1:0'",
    );
    assert.match(stored?.text ?? "", /\/status —/);
    assert.equal((stored?.text ?? "").startsWith("Pi:"), false);
    await gateway.start();
    harness.open();
    await flushChannelDeliveries(app.store, gateway);
    await gateway.sendText("15550009999@s.whatsapp.net", stored?.text ?? "");
    assert.equal(sent[0]?.text, `Pi: ${stored?.text}`);
    assert.equal(sent[1]?.text, stored?.text);
  } finally {
    await gateway.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp downloads a URL attachment only from an allowed host, within the limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-wa-url-"));
  const harness = socketHarness();
  const sent: Array<Record<string, unknown>> = [];
  harness.socket.sendMessage = async (_jid, content) => {
    sent.push(content);
    return { key: { id: `out-${sent.length}` } };
  };
  const fetched: string[] = [];
  const routes: Record<string, () => Response> = {
    "https://files.example.com/a.jpg": () => new Response("img"),
    "https://files.example.com/hop": () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    "https://files.example.com/big": () => new Response("x".repeat(64)),
  };
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    fetched.push(url);
    const route = routes[url];
    return route ? route() : new Response("nope", { status: 404 });
  }) as typeof fetch;
  const make = (hosts: string[]) =>
    new WhatsAppGateway({
      sessionDir: join(dir, "auth"),
      allowed: [OWNER],
      onMessage: async () => {},
      socketFactory: () => harness.socket,
      fetchImpl,
      ...(hosts.length
        ? { attachmentUrls: { hosts, timeoutMs: 5000, maxBytes: 16 } }
        : {}),
    });
  const other = "15550009999@s.whatsapp.net";
  const refused = (pattern: RegExp) => (error: unknown) => {
    assert.ok(error instanceof ChannelNotSent);
    assert.match(error.message, pattern);
    return true;
  };
  const byDefault = make([]);
  try {
    await byDefault.start();
    harness.open();
    await assert.rejects(
      () =>
        byDefault.sendMedia(other, {
          kind: "photo",
          url: "https://files.example.com/a.jpg",
        }),
      refused(/not allowed/),
    );
    assert.equal(fetched.length, 0);
  } finally {
    await byDefault.close();
  }
  const gateway = make(["files.example.com"]);
  try {
    await gateway.start();
    harness.open();
    await gateway.sendMedia(other, {
      kind: "photo",
      url: "https://files.example.com/a.jpg",
    });
    assert.equal(sent.length, 1);
    for (const url of [
      "http://files.example.com/a.jpg",
      "https://127.0.0.1/a.jpg",
      "https://user:pw@files.example.com/a.jpg",
    ])
      await assert.rejects(
        () => gateway.sendMedia(other, { kind: "photo", url }),
        refused(/not allowed/),
      );
    await assert.rejects(
      () =>
        gateway.sendMedia(other, {
          kind: "photo",
          url: "https://files.example.com/hop",
        }),
      refused(/not allowed/),
    );
    await assert.rejects(
      () =>
        gateway.sendMedia(other, {
          kind: "photo",
          url: "https://files.example.com/big",
        }),
      refused(/larger/),
    );
    assert.equal(sent.length, 1);
    assert.equal(
      fetched.includes("http://169.254.169.254/latest/meta-data"),
      false,
    );
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

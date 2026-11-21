import {
  type AttachmentUrlPolicy,
  loadHarnessConfig,
} from "./harness-config.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import qrcode from "qrcode-terminal";
import lockfile from "proper-lockfile";
import {
  ChannelNotSent,
  ChannelOffline,
  maskLogText,
  type Channel,
  type ChannelSendResult,
  type InboundMessage,
} from "./channel.js";
import type { OutboundMedia } from "./outbound.js";

/** Baileys `DisconnectReason.loggedOut`. The session must be paired again. */
const WHATSAPP_LOGGED_OUT = 401;
/** Echo ids kept across a restart. Older than this, a redelivery is a new message. */
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SENT_CAP = 200;
/** Bodies kept so a retry receipt can resend the real message. */
const RESEND_CAP = 100;
/**
 * `messages.upsert` type `append` is history and offline backlog. History must
 * not start a turn. A message from the last day is the backlog from a
 * reconnect, and is still read. Not an env var: one day is the bound.
 */
const APPEND_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Same sentence Telegram sends. The file is not passed to the model. */
const UNSUPPORTED_ATTACHMENT =
  "Attachment received, but for now I only read images (photo or JPEG/PNG/WebP/GIF) and voice notes.";
const IMAGE_DOCUMENT = /^image\/(jpeg|png|webp|gif)$/i;

interface WaKey {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
}

/** Phone JID, LID, or both. `id` may carry a device suffix (`:NN`). */
interface WaAccount {
  id?: string;
  lid?: string;
  phoneNumber?: string;
}

/** The fields the gateway reads. Tests build this; Baileys messages satisfy it. */
export interface WaRawMessage {
  key?: WaKey | null;
  message?: Record<string, unknown> | null;
  /**
   * Seconds since epoch, a numeric string, or a Long (`low`/`high` or
   * `toNumber`). Used only to tell a recent offline `append` from history.
   */
  messageTimestamp?:
    | number
    | string
    | { toNumber?: () => number; low?: number; high?: number }
    | null;
}

export interface WaConnectionUpdate {
  connection?: "open" | "close" | "connecting";
  qr?: string;
  lastDisconnect?: { error?: { output?: { statusCode?: number } } };
}

export interface WaSocket {
  user?: WaAccount;
  /** Present on a Baileys socket. Used when `user` is not set yet. */
  authState?: { creds?: { me?: WaAccount } };
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
    options?: { quoted?: { key: WaKey } },
  ): Promise<
    { key?: { id?: string }; message?: Record<string, unknown> } | undefined
  >;
  sendPresenceUpdate?(
    presence: "composing" | "paused",
    jid: string,
  ): Promise<void>;
  requestPairingCode?(phone: string): Promise<string>;
  updateMediaMessage?: (message: WaRawMessage) => Promise<WaRawMessage>;
  end?(reason?: unknown): void;
  ev: {
    on(
      event: "connection.update",
      listener: (update: WaConnectionUpdate) => void,
    ): void;
    on(
      event: "messages.upsert",
      listener: (upsert: { messages?: WaRawMessage[]; type?: string }) => void,
    ): void;
    on(event: "creds.update", listener: () => void): void;
  };
}

export type WaSocketFactory = () => Promise<WaSocket> | WaSocket;

function phoneDigits(value: string) {
  const user = value.split("@")[0]?.split(":")[0] ?? "";
  return user.replace(/\D/g, "");
}

/** User JID without a device suffix, so one chat stays one conversation. */
function bareUserJid(value: string) {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const user = trimmed.slice(0, at).split(":")[0] ?? "";
  return `${user}@${trimmed.slice(at + 1)}`;
}

/**
 * Brazilian mobiles are country 55, a 2-digit area code, then 8 digits, with
 * an optional extra 9 after the area code. WhatsApp JIDs often omit that 9.
 * LIDs are not phone numbers and are not rewritten.
 */
function phoneAliases(digits: string) {
  const aliases = new Set<string>();
  if (digits) aliases.add(digits);
  if (digits.startsWith("55") && digits.length === 13 && digits[4] === "9")
    aliases.add(`${digits.slice(0, 4)}${digits.slice(5)}`);
  else if (digits.startsWith("55") && digits.length === 12)
    aliases.add(`${digits.slice(0, 4)}9${digits.slice(4)}`);
  return aliases;
}

/** Bare `@s.whatsapp.net` JID. A device suffix, `@c.us` and `@hosted` are normalized. */
function phoneJidOf(value: string | undefined) {
  if (!value?.trim()) return "";
  const digits = phoneDigits(value);
  if (digits.length < 8) return "";
  if (!value.includes("@")) return `${digits}@s.whatsapp.net`;
  const bare = bareUserJid(value);
  if (jidKind(bare) !== "pn") return "";
  if (
    bare.endsWith("@s.whatsapp.net") ||
    bare.endsWith("@c.us") ||
    bare.endsWith("@hosted")
  )
    return `${digits}@s.whatsapp.net`;
  return "";
}

function lidJidOf(value: string | undefined) {
  if (!value?.trim()) return "";
  const bare = bareUserJid(value);
  return jidKind(bare) === "lid" ? bare : "";
}

function jidKind(value: string): "lid" | "pn" | "other" {
  const bare = bareUserJid(value);
  if (bare.endsWith("@lid") || bare.endsWith("@hosted.lid")) return "lid";
  if (
    bare.endsWith("@s.whatsapp.net") ||
    bare.endsWith("@c.us") ||
    bare.endsWith("@hosted")
  )
    return "pn";
  return "other";
}

/**
 * Phone JID paired with a LID. Direct chats carry it on `remoteJidAlt`;
 * groups would carry it on `participantAlt` (those are dropped first).
 */
function phoneAlt(key: WaKey | null | undefined) {
  for (const value of [key?.participantAlt, key?.remoteJidAlt]) {
    const phone = phoneJidOf(value ?? undefined);
    if (phone) return phone;
  }
  return "";
}

/** Last four digits only. Shorter or empty values stay fully masked. */
function maskWhatsAppNumber(value: string) {
  const tail = phoneDigits(value).slice(-4);
  return tail.length === 4 ? `***${tail}` : "***";
}

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

type WhatsAppDropReason =
  | "group"
  | "broadcast"
  | "echo"
  | "not-allowed"
  | "not-self"
  | "empty"
  | "history";

function dropInbound(
  reason: WhatsAppDropReason,
  jid: string,
  key: WaKey | null | undefined,
  options?: { quiet?: boolean },
) {
  // An empty from-me event is protocol or history sync after pairing. It is
  // not a user message, and logging it prints `fromMe=true` over a prompt.
  const ownEmpty = reason === "empty" && Boolean(key?.fromMe);
  if (!options?.quiet && !ownEmpty) {
    const remote = key?.remoteJid?.trim() || "";
    const kind = remote ? jidKind(remote) : "other";
    const hasAlt = Boolean(
      key?.remoteJidAlt?.trim() || key?.participantAlt?.trim(),
    );
    console.info(
      `WhatsApp: dropped inbound (${reason}) ${maskWhatsAppNumber(jid)} remote=${kind} alt=${hasAlt ? "yes" : "no"} fromMe=${key?.fromMe ? "true" : "false"}`,
    );
  }
  return undefined;
}

/** Self-chat only. A reply that already starts with `Pi:` is left as it is. */
function withSelfPrefix(value: string) {
  const body = value.trimStart();
  if (body.startsWith("Pi:")) return body;
  return `Pi: ${body}`;
}

function prefixSelfChat(content: Record<string, unknown>) {
  if (typeof content.text === "string")
    content.text = withSelfPrefix(content.text);
  if (typeof content.caption === "string")
    content.caption = withSelfPrefix(content.caption);
}

interface OwnIds {
  phones: Set<string>;
  lids: Set<string>;
}

function addOwnId(
  own: OwnIds,
  value: string | undefined,
  force?: "lid" | "pn",
) {
  const digits = phoneDigits(value ?? "");
  if (digits.length < 8) return;
  const kind = force ?? (value ? jidKind(value) : "other");
  if (kind === "lid") {
    own.lids.add(digits);
    return;
  }
  for (const alias of phoneAliases(digits))
    if (alias.length >= 8) own.phones.add(alias);
}

/** Phone and LID of the linked account. A device suffix is ignored. */
function ownIds(input: {
  ownJid?: string;
  ownLid?: string;
  ownPhone?: string;
}): OwnIds {
  const own: OwnIds = { phones: new Set(), lids: new Set() };
  addOwnId(own, input.ownJid);
  addOwnId(own, input.ownLid, "lid");
  addOwnId(own, input.ownPhone, "pn");
  return own;
}

function matchesOwn(value: string | null | undefined, own: OwnIds) {
  const digits = phoneDigits(value ?? "");
  if (digits.length < 8 || !value?.trim()) return false;
  const kind = jidKind(value);
  if (kind === "lid") return own.lids.has(digits);
  for (const alias of phoneAliases(digits))
    if (own.phones.has(alias)) return true;
  return kind !== "pn" && own.lids.has(digits);
}

/**
 * The chat is the linked account. A LID chat with our phone on `remoteJidAlt`
 * counts only when we do not yet know our LID, or the LID is ours. A from-me
 * message to someone else carries their LID and must not match on our phone.
 */
function chatIsOwn(key: WaKey | null | undefined, own: OwnIds) {
  if (matchesOwn(key?.remoteJid, own)) return true;
  const chat = key?.remoteJid?.trim() || "";
  if (jidKind(chat) !== "lid" || !matchesOwn(key?.remoteJidAlt, own))
    return false;
  return own.lids.size === 0 || matchesOwn(chat, own);
}

/** Sender fields. `fromMe` on someone else's chat is not a self-chat. */
function senderIsOwn(key: WaKey | null | undefined, own: OwnIds) {
  if (key?.fromMe) return false;
  return (
    matchesOwn(key?.participant, own) || matchesOwn(key?.participantAlt, own)
  );
}

function isOwnAccount(key: WaKey | null | undefined, own: OwnIds) {
  return chatIsOwn(key, own) || senderIsOwn(key, own);
}

function numberAllowed(allowed: readonly string[], jid: string) {
  const aliases = phoneAliases(phoneDigits(jid));
  if (![...aliases].some((item) => item.length >= 8)) return false;
  return allowed.some((item) => {
    const theirs = phoneAliases(phoneDigits(item));
    for (const alias of aliases) if (theirs.has(alias)) return true;
    return false;
  });
}

function unwrap(
  message: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!message) return {};
  for (const key of [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "editedMessage",
    "documentWithCaptionMessage",
  ]) {
    const inner = message[key];
    if (inner && typeof inner === "object" && "message" in inner)
      return unwrap((inner as { message?: Record<string, unknown> }).message);
  }
  return message;
}

function textOf(message: Record<string, unknown>) {
  const extended = message.extendedTextMessage as { text?: string } | undefined;
  const image = message.imageMessage as { caption?: string } | undefined;
  const video = message.videoMessage as { caption?: string } | undefined;
  const document = message.documentMessage as { caption?: string } | undefined;
  return (
    (typeof message.conversation === "string" ? message.conversation : "") ||
    extended?.text ||
    image?.caption ||
    video?.caption ||
    document?.caption ||
    ""
  );
}

function documentMime(message: Record<string, unknown>) {
  const doc = message.documentMessage as { mimetype?: string } | undefined;
  return doc?.mimetype || "";
}

function mediaKind(message: Record<string, unknown>) {
  if (message.imageMessage) return "image" as const;
  if (message.audioMessage) {
    const audio = message.audioMessage as { ptt?: boolean };
    return audio.ptt ? ("ptt" as const) : ("audio" as const);
  }
  if (IMAGE_DOCUMENT.test(documentMime(message))) return "image" as const;
  if (
    message.videoMessage ||
    message.documentMessage ||
    message.stickerMessage ||
    message.ptvMessage
  )
    return "unsupported" as const;
  return "" as const;
}

function mimeOf(message: Record<string, unknown>, kind: string) {
  const image = message.imageMessage as { mimetype?: string } | undefined;
  const audio = message.audioMessage as { mimetype?: string } | undefined;
  if (kind === "image")
    return image?.mimetype || documentMime(message) || "image/jpeg";
  if (kind === "audio" || kind === "ptt") return audio?.mimetype || "audio/ogg";
  return "";
}

/** Seconds (or already milliseconds) to epoch ms. Missing and junk are absent. */
function messageTimeMs(raw: WaRawMessage) {
  const value = raw.messageTimestamp;
  let seconds: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) seconds = value;
  else if (typeof value === "string" && /^\d+$/.test(value))
    seconds = Number(value);
  else if (value && typeof value === "object") {
    if (typeof value.toNumber === "function") {
      const converted = value.toNumber();
      if (Number.isFinite(converted)) seconds = converted;
    }
    if (seconds === undefined && typeof value.low === "number") {
      const low = value.low >>> 0;
      const high = typeof value.high === "number" ? value.high >>> 0 : 0;
      seconds = high * 2 ** 32 + low;
    }
  }
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0)
    return undefined;
  return seconds > 1e12 ? seconds : seconds * 1000;
}

function recentAppend(raw: WaRawMessage) {
  const at = messageTimeMs(raw);
  if (at === undefined) return false;
  const age = Date.now() - at;
  return age <= APPEND_MAX_AGE_MS && age >= -60_000;
}

/**
 * Decides whether a WhatsApp message is admitted. Groups, broadcasts, other
 * people's numbers, and echoes of our own sends are dropped.
 *
 * The linked account's own chat is always admitted, allowlist or not. That
 * includes a phone JID with a device suffix, the account LID with no alt, and
 * a sender whose phone sits on `participantAlt`. `fromMe` may be false. A
 * from-me message to someone else stays dropped. The admitted `chatId` stays
 * the bare `remoteJid`, so an existing conversation does not split. A known
 * phone is returned in `aliases` and is where the reply is sent. Baileys 7
 * sends to an `@lid` with the LID identity; that send fails when the LID
 * session is missing, so the phone JID is used instead.
 */
export function admitWhatsAppMessage(input: {
  raw: WaRawMessage;
  allowed: readonly string[];
  ownJid?: string;
  /** `socket.user.lid` or `creds.me.lid`. A device suffix is ignored. */
  ownLid?: string;
  /** `socket.user.phoneNumber` or `creds.me.phoneNumber`. */
  ownPhone?: string;
  sentIds: ReadonlySet<string>;
  media?: { data: Uint8Array; mimeType: string };
  /**
   * Image or voice bytes are not downloaded yet. Do not drop the message
   * only because those bytes are missing.
   */
  pendingMedia?: boolean;
  /** Pairing. Drop lines are not printed, so they cannot land on a prompt. */
  quiet?: boolean;
}): InboundMessage | undefined {
  const key = input.raw.key;
  const rawChat = key?.remoteJid?.trim() || "";
  const messageId = key?.id?.trim() || "";
  if (!rawChat || !messageId) return undefined;
  const chatId = bareUserJid(rawChat);
  const altPhone = phoneAlt(key);
  const logged = altPhone || chatId;
  const drop = (reason: WhatsAppDropReason) =>
    dropInbound(reason, logged, key, { quiet: input.quiet });
  if (chatId.endsWith("@g.us")) return drop("group");
  if (
    chatId.includes("status@broadcast") ||
    chatId.endsWith("@broadcast") ||
    chatId.endsWith("@newsletter")
  )
    return drop("broadcast");
  if (input.sentIds.has(messageId)) return drop("echo");
  const fromMe = Boolean(key?.fromMe);
  const senderId = altPhone || key?.participant?.trim() || chatId;
  const ids = ownIds({
    ownJid: input.ownJid,
    ownLid: input.ownLid,
    ownPhone: input.ownPhone,
  });
  const own = isOwnAccount(key, ids);
  if (!own && fromMe) return drop("not-self");
  if (
    !own &&
    !numberAllowed(input.allowed, senderId) &&
    !numberAllowed(input.allowed, chatId)
  )
    return drop("not-allowed");
  const body = unwrap(input.raw.message);
  const kind = mediaKind(body);
  const text = textOf(body).trim();
  const image =
    kind === "image" && input.media
      ? {
          data: Buffer.from(input.media.data).toString("base64"),
          mimeType: input.media.mimeType,
        }
      : undefined;
  const audio =
    (kind === "audio" || kind === "ptt") && input.media
      ? { data: input.media.data, mimeType: input.media.mimeType }
      : undefined;
  const waitingForBytes =
    input.pendingMedia === true &&
    (kind === "image" || kind === "audio" || kind === "ptt") &&
    !image &&
    !audio;
  if (kind !== "unsupported" && !text && !image && !audio && !waitingForBytes)
    return drop("empty");
  const knownPhone =
    altPhone ||
    (jidKind(chatId) === "lid" && matchesOwn(chatId, ids)
      ? phoneJidOf(input.ownPhone) || phoneJidOf(input.ownJid)
      : "");
  const knownLid =
    jidKind(chatId) === "lid"
      ? ""
      : lidJidOf(key?.participantAlt ?? undefined) ||
        lidJidOf(key?.remoteJidAlt ?? undefined) ||
        (own ? lidJidOf(input.ownLid) : "");
  const aliases = [
    ...new Set([knownPhone, knownLid].filter((id) => id && id !== chatId)),
  ];
  const sender = own || fromMe ? chatId : senderId;
  if (kind === "unsupported")
    return {
      channel: "whatsapp",
      chatId,
      senderId: sender,
      messageId,
      text: UNSUPPORTED_ATTACHMENT,
      unsupported: true,
      ...(aliases.length ? { aliases } : {}),
    };
  return {
    channel: "whatsapp",
    chatId,
    senderId: sender,
    messageId,
    text,
    ...(aliases.length ? { aliases } : {}),
    ...(image ? { image } : {}),
    ...(audio ? { audio } : {}),
  };
}

function silentLogger() {
  const logger = {
    level: "silent",
    child() {
      return logger;
    },
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return logger;
}

function printQr(qr: string) {
  console.log(
    "WhatsApp: scan this QR in Linked devices, or run npm run setup.",
  );
  qrcode.generate(qr, { small: true });
}

/**
 * Trailing whitespace is a blank line in the WhatsApp bubble. Telegram's
 * client hides it. An empty text is not a message.
 */
function trimOutgoing(content: Record<string, unknown>) {
  const payload = { ...content };
  if (typeof payload.text === "string") {
    payload.text = payload.text.trimEnd();
    if (!payload.text) throw new ChannelNotSent("Nothing was sent.");
  }
  if (typeof payload.caption === "string") {
    const caption = payload.caption.trimEnd();
    if (caption) payload.caption = caption;
    else delete payload.caption;
  }
  return payload;
}

/** Ack and socket failures may already be on the wire. Local errors are not. */
function sendMayHaveLeft(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s*out|\btimeout\b|econnreset|econnrefused|\bepipe\b|socket hang up|connection closed|stream errored|\back\b/i.test(
    message,
  );
}

function createResendCache(cap = RESEND_CAP) {
  const order: string[] = [];
  const messages = new Map<string, Record<string, unknown>>();
  return {
    remember(id: string, message: Record<string, unknown>) {
      const at = order.indexOf(id);
      if (at >= 0) order.splice(at, 1);
      order.push(id);
      messages.set(id, message);
      while (order.length > cap) {
        const oldest = order.shift();
        if (oldest) messages.delete(oldest);
      }
    },
    get(id: string | null | undefined) {
      if (!id) return undefined;
      return messages.get(id);
    },
  };
}

/** The proto body a retry receipt should relay. Never an empty conversation. */
function retryBody(
  sent: { message?: unknown },
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const message = sent.message;
  if (message && typeof message === "object" && !Array.isArray(message))
    return message as Record<string, unknown>;
  if (typeof payload.text === "string" && payload.text)
    return { conversation: payload.text };
  return undefined;
}

async function openBaileysSocket(
  sessionDir: string,
  resend: (
    id: string | null | undefined,
  ) => Record<string, unknown> | undefined,
): Promise<WaSocket> {
  const baileys = await import("@whiskeysockets/baileys");
  const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir);
  const logger = silentLogger();
  const sock = baileys.makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["Pi Agent", "Chrome", "120.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key: { id?: string | null }) => resend(key?.id),
  });
  sock.ev.on("creds.update", saveCreds);
  return sock as unknown as WaSocket;
}

const MAX_ATTACHMENT_REDIRECTS = 3;

function allowedAttachmentUrl(value: string, policy: AttachmentUrlPolicy) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password)
    return undefined;
  return policy.hosts.includes(url.hostname.toLowerCase()) ? url : undefined;
}

/** The bot downloads a URL attachment only from an allowed HTTPS host, at every
 * redirect, within the deadline and the byte cap. */
async function mediaBytes(
  media: OutboundMedia,
  fetchImpl: typeof fetch,
  policy: AttachmentUrlPolicy,
) {
  if (media.data) return Buffer.from(media.data, "base64");
  if (!media.url) throw new Error("attachment has no bytes");
  const signal = AbortSignal.timeout(policy.timeoutMs);
  let next = media.url;
  for (let hop = 0; hop <= MAX_ATTACHMENT_REDIRECTS; hop += 1) {
    const url = allowedAttachmentUrl(next, policy);
    if (!url)
      throw new Error(
        "attachment URL not allowed: the host is not in whatsapp.attachment_urls.hosts",
      );
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: "manual", signal });
    } catch {
      throw new Error("attachment download failed");
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      next = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw new Error("attachment download failed");
    return limitedBody(response, policy.maxBytes);
  }
  throw new Error("attachment download failed: too many redirects");
}

async function limitedBody(response: Response, maxBytes: number) {
  const tooLarge = () =>
    new Error("attachment is larger than the allowed size");
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof Error && error.message === tooLarge().message)
      throw error;
    throw new Error("attachment download failed");
  }
  return Buffer.concat(chunks);
}

function contentFor(
  kind: OutboundMedia["kind"],
  bytes: Buffer,
  media: OutboundMedia,
) {
  const content: Record<string, unknown> =
    kind === "photo"
      ? { image: bytes, mimetype: media.mimeType || "image/jpeg" }
      : kind === "audio" || kind === "voice"
        ? {
            audio: bytes,
            mimetype: media.mimeType || "audio/ogg",
            ptt: kind === "voice",
          }
        : {
            document: bytes,
            mimetype: media.mimeType || "application/octet-stream",
            fileName: media.filename || "file",
          };
  if (typeof media.caption === "string") content.caption = media.caption;
  return content;
}

interface WhatsAppGatewayOptions {
  sessionDir: string;
  allowed: readonly string[];
  onMessage: (message: InboundMessage) => Promise<void>;
  socketFactory?: WaSocketFactory;
  /** Called with the QR text. Defaults to printing a terminal QR. */
  onQr?: (qr: string) => void;
  onCode?: (code: string) => void;
  onOpen?: () => void;
  /**
   * Fired after a logged-out session is set aside. The gateway keeps waiting
   * for a QR; this does not stop the process.
   */
  onLogout?: () => void;
  /** Digits of the handset being linked, for a pairing code instead of only a QR. */
  pairingPhone?: string;
  /**
   * Setup pairing. Inbound drops are not logged, so a sync line cannot land
   * on the Choice prompt.
   */
  quiet?: boolean;
  schedule?: (run: () => void, ms: number) => void;
  downloadMedia?: (
    message: WaRawMessage,
  ) => Promise<{ data: Uint8Array; mimeType: string } | undefined>;
  fetchImpl?: typeof fetch;
  /** Overrides `whatsapp.attachment_urls` from the harness config. */
  attachmentUrls?: AttachmentUrlPolicy;
}

/**
 * WhatsApp Web via Baileys. The session directory lives on the data volume.
 * One allowlist (the owner's number and any extras saved with it). A dropped
 * socket reconnects. A logged-out session is moved aside and the process
 * waits for a new QR. Tests pass `socketFactory` and never open a network
 * socket.
 */
export class WhatsAppGateway implements Channel {
  readonly id = "whatsapp" as const;
  /** True after logout until the replacement session connects. */
  waitingForPair = false;
  /**
   * Connected, waiting to pair again, or reconnecting after a drop that was
   * not a logout. Shutdown (`close`) is not live, so health updates stop.
   */
  get live() {
    return (
      !this.closed &&
      (this.connected || this.waitingForPair || this.reconnecting)
    );
  }
  private socket?: WaSocket;
  connected = false;
  private closed = false;
  private retiring = false;
  /** Keeps the process up between logout and the next open socket. */
  private life?: ReturnType<typeof setInterval>;
  /** Bare LID → bare `@s.whatsapp.net`. Learned from inbound keys and our identity. */
  private pnForLid = new Map<string, string>();
  /** `creds.json` `me`, so self-chat works before `socket.user` is set. */
  private cachedMe?: WaAccount;
  private sentIds = new Set<string>();
  /** When each sent id was remembered, so a restart can drop expired ones. */
  private sentAt = new Map<string, number>();
  private reconnecting = false;
  /** In-flight ingest per chat, so one upsert batch stays in arrival order. */
  private inboundTails = new Map<string, Promise<void>>();
  private codeRequested = false;
  private opening?: Promise<void>;
  private resend = createResendCache();
  constructor(private options: WhatsAppGatewayOptions) {}

  async start() {
    await mkdir(this.options.sessionDir, { recursive: true, mode: 0o700 });
    this.loadMap();
    this.loadSent();
    await this.readCachedMe();
    await this.openSocket();
  }

  async close() {
    this.closed = true;
    this.releaseProcess();
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    socket?.end?.();
  }

  async sendText(chatId: string, text: string): Promise<ChannelSendResult> {
    const sent = await this.send(chatId, { text });
    return { messageId: sent?.key?.id };
  }

  /** Body a retry receipt should resend. Missing ids are not an empty text. */
  retryMessage(id: string | null | undefined) {
    return this.resend.get(id);
  }

  async sendMedia(
    chatId: string,
    media: OutboundMedia,
  ): Promise<ChannelSendResult> {
    let bytes: Buffer;
    try {
      bytes = await mediaBytes(
        media,
        this.options.fetchImpl ?? fetch,
        this.options.attachmentUrls ??
          loadHarnessConfig().whatsappAttachmentUrls,
      );
    } catch (error) {
      throw new ChannelNotSent(
        error instanceof Error ? error.message : "Nothing was sent.",
        { cause: error },
      );
    }
    const sent = await this.send(chatId, contentFor(media.kind, bytes, media));
    return { messageId: sent?.key?.id };
  }

  async typing(chatId: string) {
    if (!this.connected || !this.socket?.sendPresenceUpdate) return;
    const jid = this.deliveryJid(chatId);
    if (!jid) return;
    await this.socket.sendPresenceUpdate("composing", jid);
  }

  private async send(chatId: string, content: Record<string, unknown>) {
    // Empty text is refused before the socket is asked. A caption that is
    // only trailing whitespace is omitted; the file still goes out.
    const payload = trimOutgoing(content);
    const socket = this.socket;
    if (!socket || !this.connected) throw new ChannelOffline();
    const jid = this.deliveryJid(chatId);
    if (!jid) throw new ChannelNotSent("Nothing was sent.");
    // Only the linked account's own chat. Every other number stays as written.
    if (this.isSelfChat(chatId) || this.isSelfChat(jid))
      prefixSelfChat(payload);
    // No `quoted` options. A stanza id without a message body crashes
    // Baileys 7.0.0-rc14 in `generateWAMessageFromContent`.
    try {
      const sent = await socket.sendMessage(jid, payload);
      if (sent?.key?.id) {
        this.rememberSent(sent.key.id);
        const message = retryBody(sent, payload);
        if (message) this.resend.remember(sent.key.id, message);
      }
      return sent;
    } catch (error) {
      if (error instanceof ChannelOffline || error instanceof ChannelNotSent)
        throw error;
      if (sendMayHaveLeft(error)) throw error;
      throw new ChannelNotSent(
        error instanceof Error ? error.message : "Nothing was sent.",
        { cause: error },
      );
    }
  }

  /** The chat is the paired account (its phone or its LID), not another number. */
  private isSelfChat(chatId: string) {
    const me = this.account();
    return matchesOwn(
      chatId,
      ownIds({
        ownJid: me.ownJid,
        ownLid: me.ownLid,
        ownPhone: me.ownPhone,
      }),
    );
  }

  /** JID a send would use: stored LID, then the number form. */
  outboundChat(chatId: string) {
    return this.deliveryJid(chatId);
  }

  /** Phone JID when we know one. The LID is only used when no phone is known. */
  private deliveryJid(chatId: string) {
    const bare = bareUserJid(chatId);
    if (jidKind(bare) === "pn") return phoneJidOf(bare) || bare;
    if (jidKind(bare) !== "lid") return bare;
    const known = this.pnForLid.get(bare);
    if (known) return known;
    const me = this.account();
    const ownLid = lidJidOf(me.ownLid);
    if (ownLid && ownLid === bare) {
      const phone = phoneJidOf(me.ownPhone) || phoneJidOf(me.ownJid);
      if (phone) return phone;
    }
    return bare;
  }

  private mapFile() {
    return join(dirname(this.options.sessionDir), "whatsapp-lid-map.json");
  }

  private loadMap() {
    try {
      const parsed = JSON.parse(
        readFileSync(this.mapFile(), "utf8"),
      ) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      for (const [lid, pn] of Object.entries(parsed))
        if (typeof pn === "string") this.storePair(lid, pn, false);
    } catch {
      /* No map yet, or it is unreadable. The next message fills it. */
    }
  }

  private storePair(lid: string, pn: string, persist: boolean) {
    const bareLid = lidJidOf(lid);
    const phone = phoneJidOf(pn);
    if (!bareLid || !phone || this.pnForLid.get(bareLid) === phone) return;
    this.pnForLid.set(bareLid, phone);
    if (!persist) return;
    try {
      writeJsonFile(this.mapFile(), Object.fromEntries(this.pnForLid));
    } catch {
      /* The in-memory map still routes this process. */
    }
  }

  private noteKey(key: WaKey | null | undefined) {
    if (!key) return;
    let lid = "";
    let pn = "";
    for (const value of [
      key.remoteJid,
      key.remoteJidAlt,
      key.participant,
      key.participantAlt,
    ]) {
      if (typeof value !== "string") continue;
      lid ||= lidJidOf(value);
      pn ||= phoneJidOf(value);
    }
    if (lid && pn) this.storePair(lid, pn, true);
  }

  private noteOwnIdentity() {
    const me = this.account();
    const lid = lidJidOf(me.ownLid);
    const phone = phoneJidOf(me.ownPhone) || phoneJidOf(me.ownJid);
    if (lid && phone) this.storePair(lid, phone, true);
  }

  private holdProcess() {
    if (this.life) return;
    this.life = setInterval(() => {
      /* Referenced on purpose: an unref'd timer lets a logged-out process exit. */
    }, 60_000);
  }

  private releaseProcess() {
    if (!this.life) return;
    clearInterval(this.life);
    this.life = undefined;
  }

  private account() {
    const live = this.socket?.user;
    const stored = this.socket?.authState?.creds?.me ?? this.cachedMe;
    return {
      ownJid: live?.id || stored?.id,
      ownLid: live?.lid || stored?.lid,
      ownPhone: live?.phoneNumber || stored?.phoneNumber,
    };
  }

  private async readCachedMe() {
    try {
      const raw = await readFile(
        join(this.options.sessionDir, "creds.json"),
        "utf8",
      );
      const me = JSON.parse(raw)?.me;
      if (!me || typeof me !== "object") return;
      this.cachedMe = {
        id: typeof me.id === "string" ? me.id : undefined,
        lid: typeof me.lid === "string" ? me.lid : undefined,
        phoneNumber:
          typeof me.phoneNumber === "string" ? me.phoneNumber : undefined,
      };
    } catch {
      /* Not paired yet, or the file is unreadable. */
    }
  }

  private async openSocket() {
    if (this.closed) return;
    if (this.opening) return this.opening;
    this.opening = this.connect().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async connect() {
    const socket = await (
      this.options.socketFactory ??
      (() =>
        openBaileysSocket(this.options.sessionDir, (id) =>
          this.retryMessage(id),
        ))
    )();
    if (this.closed) {
      socket.end?.();
      return;
    }
    this.socket = socket;
    this.connected = false;
    socket.ev.on("connection.update", (update) => {
      void this.onConnection(update).catch((error) => {
        const detail = error instanceof Error ? error.message : "unknown";
        console.error(
          `WhatsApp: connection update failed (${maskLogText(detail)}).`,
        );
      });
    });
    socket.ev.on("messages.upsert", (upsert) => {
      if (upsert.type !== "notify" && upsert.type !== "append") return;
      for (const message of upsert.messages ?? [])
        this.enqueueInbound(message, upsert.type);
    });
  }

  /**
   * Later messages of the same chat wait. Another chat is not held back.
   * The first message of a chat starts immediately, so a single upsert still
   * drops and answers before the caller continues.
   */
  private enqueueInbound(raw: WaRawMessage, upsertType: string) {
    const chat = bareUserJid(raw.key?.remoteJid ?? "") || "unknown";
    const previous = this.inboundTails.get(chat);
    const run = previous
      ? previous.catch(() => {}).then(() => this.ingest(raw, upsertType))
      : this.ingest(raw, upsertType);
    const settled = run.catch(() => {});
    this.inboundTails.set(chat, settled);
    void settled.finally(() => {
      if (this.inboundTails.get(chat) === settled)
        this.inboundTails.delete(chat);
    });
  }

  private async onConnection(update: WaConnectionUpdate) {
    if (update.qr) {
      (this.options.onQr ?? printQr)(update.qr);
      await this.maybePairingCode();
    }
    if (update.connection === "open") {
      this.connected = true;
      this.waitingForPair = false;
      this.releaseProcess();
      const me = this.account();
      if (me.ownJid || me.ownLid || me.ownPhone)
        this.cachedMe = {
          id: me.ownJid,
          lid: me.ownLid,
          phoneNumber: me.ownPhone,
        };
      this.noteOwnIdentity();
      this.options.onOpen?.();
      return;
    }
    if (update.connection !== "close") return;
    this.connected = false;
    const code = update.lastDisconnect?.error?.output?.statusCode;
    if (code === WHATSAPP_LOGGED_OUT) {
      if (this.closed || this.retiring || this.waitingForPair) return;
      this.retiring = true;
      this.waitingForPair = true;
      this.reconnecting = false;
      const socket = this.socket;
      this.socket = undefined;
      socket?.end?.();
      // The flush timer is unref'd and the socket has closed. Hold the process
      // before the first await, or Node exits and Docker restarts forever.
      this.holdProcess();
      console.error(
        "WhatsApp: session logged out. Pair again with npm run setup, or scan the QR in these logs.",
      );
      void this.finishLogout();
      return;
    }
    if (this.closed) return;
    this.scheduleReconnect();
  }

  private async finishLogout() {
    let moved = false;
    try {
      await this.retireSession();
      moved = true;
    } catch (error) {
      console.error(
        `WhatsApp: could not set the logged-out session aside (${error instanceof Error ? error.name : "error"}).`,
      );
    } finally {
      this.retiring = false;
      if (this.closed) this.releaseProcess();
    }
    if (this.closed) return;
    if (!moved) {
      this.scheduleRetry(() => {
        if (!this.closed) void this.finishLogout();
      });
      return;
    }
    this.codeRequested = false;
    try {
      this.options.onLogout?.();
    } catch (error) {
      console.error(
        `WhatsApp: logout handler failed (${error instanceof Error ? error.name : "error"}).`,
      );
    }
    this.scheduleReconnect();
  }

  /** Rename `whatsapp-auth` to `whatsapp-auth.loggedout-<timestamp>` and start empty. */
  private async retireSession() {
    const dir = this.options.sessionDir;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return;
    }
    if (entries.length === 0) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(dir, `${dir}.loggedout-${stamp}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  private async maybePairingCode() {
    const phone = this.options.pairingPhone?.replace(/\D/g, "");
    const request = this.socket?.requestPairingCode;
    if (!phone || !request || this.codeRequested) return;
    this.codeRequested = true;
    try {
      const code = await request(phone);
      (
        this.options.onCode ??
        ((value) => console.log(`WhatsApp pairing code: ${value}`))
      )(code);
    } catch (error) {
      this.codeRequested = false;
      const detail = error instanceof Error ? error.message : "unknown";
      console.error(`WhatsApp: pairing code failed (${maskLogText(detail)}).`);
    }
  }

  private scheduleRetry(run: () => void) {
    // The timer stays referenced. Unref here lets a normal close (HTTP 428)
    // exit the process before the socket reconnects.
    const schedule = this.options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    schedule(run, 2000);
  }

  private scheduleReconnect() {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    this.scheduleRetry(() => {
      this.reconnecting = false;
      // A rejected socket (bad creds.json, EACCES) must not be an unhandled
      // rejection: Node 24 exits the process on one.
      void this.openSocket().catch((error) => {
        const detail = error instanceof Error ? error.message : "unknown";
        console.error(`WhatsApp: reconnect failed (${maskLogText(detail)}).`);
        this.scheduleReconnect();
      });
    });
  }

  private async ingest(raw: WaRawMessage, upsertType = "notify") {
    if (upsertType === "append" && !recentAppend(raw)) {
      dropInbound("history", raw.key?.remoteJid?.trim() || "", raw.key, {
        quiet: this.options.quiet,
      });
      return;
    }
    const me = this.account();
    const identity = {
      raw,
      allowed: this.options.allowed,
      ownJid: me.ownJid,
      ownLid: me.ownLid,
      ownPhone: me.ownPhone,
      sentIds: this.sentIds,
      quiet: this.options.quiet,
    };
    // Groups and unknown numbers are refused before any download or LID write.
    if (!admitWhatsAppMessage({ ...identity, pendingMedia: true })) return;
    this.noteKey(raw.key);
    let media: { data: Uint8Array; mimeType: string } | undefined;
    const body = unwrap(raw.message);
    const kind = mediaKind(body);
    if (kind && kind !== "unsupported") {
      try {
        media = await (
          this.options.downloadMedia ??
          ((message) => downloadBaileysMedia(message, this.socket))
        )(raw);
        if (media && !media.mimeType)
          media = { ...media, mimeType: mimeOf(body, kind) };
      } catch {
        media = undefined;
      }
    }
    const message = admitWhatsAppMessage({ ...identity, media });
    if (!message) return;
    if (!message.unsupported) void this.typing(message.chatId).catch(() => {});
    try {
      await this.options.onMessage(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      console.error(`WhatsApp: inbound failed (${maskLogText(detail)}).`);
    }
  }

  private sentFile() {
    return join(dirname(this.options.sessionDir), "whatsapp-sent.json");
  }

  private loadSent() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.sentFile(), "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    const kept: Array<{ id: string; at: number }> = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const id = (row as { id?: unknown }).id;
      const at = (row as { at?: unknown }).at;
      if (typeof id !== "string" || !id || id.length > 128) continue;
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      if (now - at > SENT_TTL_MS) continue;
      kept.push({ id, at });
    }
    kept.sort((left, right) => left.at - right.at);
    for (const row of kept.slice(-SENT_CAP)) {
      this.sentIds.add(row.id);
      this.sentAt.set(row.id, row.at);
    }
  }

  private rememberSent(id: string) {
    if (!id || id.length > 128 || this.sentIds.has(id)) return;
    this.sentIds.add(id);
    this.sentAt.set(id, Date.now());
    this.persistSent();
  }

  private persistSent() {
    const now = Date.now();
    const rows = [...this.sentAt.entries()]
      .filter(([, at]) => now - at <= SENT_TTL_MS)
      .sort((left, right) => left[1] - right[1])
      .slice(-SENT_CAP);
    this.sentIds = new Set(rows.map(([id]) => id));
    this.sentAt = new Map(rows);
    try {
      writeJsonFile(
        this.sentFile(),
        rows.map(([id, at]) => ({ id, at })),
      );
    } catch {
      /* The in-memory set still drops echoes for this process. */
    }
  }
}

async function downloadBaileysMedia(message: WaRawMessage, socket?: WaSocket) {
  const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
  const bytes = await downloadMediaMessage(
    message as Parameters<typeof downloadMediaMessage>[0],
    "buffer",
    {},
    {
      logger: silentLogger(),
      reuploadRequest: async (value) => {
        const updated = await socket?.updateMediaMessage?.(
          value as WaRawMessage,
        );
        return (updated ?? value) as typeof value;
      },
    },
  );
  const body = unwrap(message.message);
  return {
    data: new Uint8Array(bytes),
    mimeType: mimeOf(body, mediaKind(body)),
  };
}

/** Blocks until the session is connected. Used by `npm run setup`. */
export async function pairWhatsApp(
  sessionDir: string,
  options: {
    phone?: string;
    socketFactory?: WaSocketFactory;
    onQr?: (qr: string) => void;
    onCode?: (code: string) => void;
  } = {},
) {
  const volume = dirname(sessionDir);
  const held = await lockfile
    .check(volume, {
      realpath: true,
      lockfilePath: join(volume, "owner.lock"),
      stale: 30_000,
    })
    .catch(() => false);
  if (held) throw new Error("o gateway já mostra o QR nos logs");
  return new Promise<void>((resolve, reject) => {
    // The reconnect timer is unref'd. Without this, a socket that closes
    // before the QR (and a readline that no longer holds stdin) lets the
    // process exit with the promise still pending.
    const keepAlive = setInterval(() => {
      /* Holds the process until the phone is connected or pairing fails. */
    }, 2 ** 30);
    const finish = (run: () => void) => {
      clearInterval(keepAlive);
      run();
    };
    const gateway = new WhatsAppGateway({
      sessionDir,
      allowed: [],
      onMessage: async () => {},
      socketFactory: options.socketFactory,
      pairingPhone: options.phone,
      onQr: options.onQr,
      onCode: options.onCode,
      quiet: true,
      onOpen: () => {
        void gateway.close().then(
          () => finish(resolve),
          (error) => finish(() => reject(error)),
        );
      },
    });
    void gateway.start().catch((error) => finish(() => reject(error)));
  });
}

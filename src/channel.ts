import type { OutboundMedia } from "./outbound.js";
import { type Store } from "./store.js";

/** Phone gateways. A later browser channel can be added without renaming these. */
type ChannelId = "telegram" | "whatsapp";

/** One inbound message. `channel` is the gateway that received it. */
export interface InboundMessage {
  channel: ChannelId;
  chatId: string;
  senderId: string;
  messageId: string;
  text: string;
  /**
   * Other ids of the same conversation. WhatsApp pairs a LID with a phone;
   * both stay bound to one conversation.
   */
  aliases?: readonly string[];
  image?: { data: string; mimeType: string };
  audio?: { data: Uint8Array; mimeType: string };
  /**
   * Video, sticker, or a document that is not an image. The text is a notice.
   * It is delivered and does not start a turn.
   */
  unsupported?: boolean;
}

export interface ChannelSendResult {
  messageId?: string;
}

/** Origin line shared by Telegram and WhatsApp before a converted message. */
export function originHeader(label: string, value: Record<string, unknown>) {
  return `[${label} · ${JSON.stringify(value)}]`;
}

/** Meta and delivery prefix for one WhatsApp approval. */
export function whatsappApprovalKey(id: string) {
  return `whatsapp:approval:${id}`;
}

/** The request id one WhatsApp inbound message is admitted under. */
export function whatsappRequestId(messageId: string) {
  const safe = messageId.replace(/[^\w:.-]/g, "_").slice(0, 140);
  return `wa:${safe || "msg"}`;
}

/** Last four digits only, for logs. Shorter runs stay as written. */
export function maskLogText(value: string) {
  return value.replace(/\d{8,}/g, (digits) => `***${digits.slice(-4)}`);
}

/**
 * What a phone channel sends with. Telegram keeps its own delivery engine.
 * Typing and close stay on the gateway class; nothing calls them through this.
 */
export interface Channel {
  readonly id: ChannelId;
  sendText(chatId: string, text: string): Promise<ChannelSendResult>;
  sendMedia(chatId: string, media: OutboundMedia): Promise<ChannelSendResult>;
}

/** Nothing was handed to the transport. The row stays pending and is tried later. */
export class ChannelOffline extends Error {
  constructor() {
    super("Channel is offline.");
  }
}

/**
 * The send failed before the transport was asked to deliver it. Nothing left
 * the process, so the row is failed and is not retried. This is not an
 * unknown outcome.
 */
export class ChannelNotSent extends Error {
  constructor(message = "Nothing was sent.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChannelNotSent";
  }
}

export interface ApprovalChoice {
  label: string;
  action: "accept" | "decline" | "remember";
}

/** Numbered list used when the channel cannot show buttons. */
export function numberedList(title: string, labels: readonly string[]) {
  const lines = [title.trim(), ""];
  labels.forEach((label, index) => {
    lines.push(`${index + 1}. ${label}`);
  });
  lines.push("", "Reply with the number.");
  return lines.join("\n");
}

export function numberedApproval(
  title: string,
  choices: readonly ApprovalChoice[],
) {
  return numberedList(
    title,
    choices.map((choice) => choice.label),
  );
}

/** A reply that is only a choice number. Anything else is a normal message. */
export function parseNumberedReply(text: string, count: number) {
  const match = /^(\d{1,2})$/.exec(text.trim());
  if (!match || count < 1) return undefined;
  const choice = Number(match[1]);
  if (!Number.isInteger(choice) || choice < 1 || choice > count)
    return undefined;
  return choice;
}

export function bindChannelChat(
  store: Store,
  channel: ChannelId,
  chatId: string,
  conversationId: string,
) {
  store.run(
    `INSERT INTO channel_chats(channel,chatId,conversationId) VALUES (?,?,?)
     ON CONFLICT(channel,chatId) DO UPDATE SET conversationId=excluded.conversationId`,
    channel,
    chatId,
    conversationId,
  );
}

/**
 * Where a WhatsApp sign-in notice goes. The newest bound chat wins, the same
 * row a send uses, then the gateway resolves a stored LID or the number.
 * With nothing bound, the owner number is the fallback.
 */
export function whatsAppOauthChat(
  store: Store,
  owner: string,
  resolve: (chatId: string) => string,
) {
  const bound = store.get<{ chatId: string }>(
    "SELECT chatId FROM channel_chats WHERE channel='whatsapp' ORDER BY rowid DESC LIMIT 1",
  );
  const digits = owner.replace(/\D/g, "");
  const chat = bound?.chatId || (digits ? `${digits}@s.whatsapp.net` : "");
  if (!chat) return chat;
  return resolve(chat) || chat;
}

export function channelChat(
  store: Store,
  channel: ChannelId,
  conversationId: string,
) {
  return store.get<{ chatId: string }>(
    "SELECT chatId FROM channel_chats WHERE channel=? AND conversationId=? ORDER BY rowid DESC LIMIT 1",
    channel,
    conversationId,
  );
}

/**
 * One line. Digits long enough to be a phone are masked; the body is not logged.
 */
function whatsAppSendFailure(
  error: unknown,
  redact?: (text: string) => string,
) {
  const source =
    error instanceof ChannelNotSent && error.cause instanceof Error
      ? error.cause
      : error;
  let detail =
    source instanceof Error && source.message ? source.message : "send failed";
  try {
    if (redact) detail = redact(detail);
  } catch {
    detail = "send failed";
  }
  return `WhatsApp: send failed (${maskLogText(detail)}).`;
}

/**
 * One flush at a time per channel. A second call waits, so a slow send of the
 * first chunk cannot be overtaken by the next chunk.
 */
const channelFlush = new WeakMap<Channel, Promise<void>>();

/**
 * Sends pending rows for one channel. The state machine matches Telegram:
 * pending is claimed as sending, a refusal or a pre-send error is failed and
 * not retried, any other error after the send started is uncertain and not
 * retried, and an offline channel puts the row back to pending.
 */
export function flushChannelDeliveries(
  store: Store,
  channel: Channel,
  redact?: (text: string) => string,
) {
  const running = channelFlush.get(channel);
  if (running) return running;
  const run = flushChannelOnce(store, channel, redact).finally(() => {
    if (channelFlush.get(channel) === run) channelFlush.delete(channel);
  });
  channelFlush.set(channel, run);
  return run;
}

/**
 * A volume runs one gateway. Rows left pending by the other one would wait
 * forever, so the gateway that is starting cancels them. A row with no
 * channel is a Telegram row from before channels existed.
 */
export function cancelInactiveGateway(store: Store, active: ChannelId) {
  const result =
    active === "whatsapp"
      ? store.run(
          "UPDATE deliveries SET state='cancelled', result=? WHERE state='pending' AND (channel IS NULL OR channel!=?)",
          "gateway inativo",
          active,
        )
      : store.run(
          "UPDATE deliveries SET state='cancelled', result=? WHERE state='pending' AND channel IS NOT NULL AND channel!=?",
          "gateway inativo",
          active,
        );
  if (result.changes) {
    console.log(
      `Inactive gateway: cancelled ${result.changes} pending deliveries.`,
    );
  }
  return result.changes;
}

async function flushChannelOnce(
  store: Store,
  channel: Channel,
  redact?: (text: string) => string,
) {
  const rows = store.all<{
    id: string;
    chat: string;
    text: string;
    media: string | null;
    state: string;
  }>(
    "SELECT * FROM deliveries WHERE state='pending' AND channel=? ORDER BY rowid",
    channel.id,
  );
  for (const delivery of rows) {
    const owner = store.get<{ conversationId: string }>(
      "SELECT conversationId FROM delivery_conversations WHERE deliveryId=?",
      delivery.id,
    );
    if (owner && store.conversationDeleted(owner.conversationId)) {
      store.run(
        "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
        "Conversation deleted before send.",
        delivery.id,
      );
      continue;
    }
    const claimed = store.run(
      "UPDATE deliveries SET state='sending' WHERE id=? AND state='pending'",
      delivery.id,
    ).changes;
    if (!claimed) continue;
    try {
      let sent: ChannelSendResult | undefined;
      const text = delivery.text
        ? (redact?.(delivery.text) ?? delivery.text)
        : "";
      if (text.trim()) sent = await channel.sendText(delivery.chat, text);
      const mediaResult: unknown[] = [];
      const media = delivery.media
        ? (JSON.parse(delivery.media) as OutboundMedia[])
        : [];
      for (let index = 0; index < media.length; index++) {
        const item = media[index]!;
        try {
          mediaResult.push(await channel.sendMedia(delivery.chat, item));
          // ChannelOffline puts the row back. Drop what already went out so
          // the retry sends only the tail.
          const rest = media.slice(index + 1);
          store.run(
            "UPDATE deliveries SET media=? WHERE id=?",
            rest.length ? JSON.stringify(rest) : null,
            delivery.id,
          );
        } catch (error) {
          // Offline and pre-send failures must retry or fail the row. Swallowing
          // them marked the file sent and dropped it.
          if (
            error instanceof ChannelOffline ||
            error instanceof ChannelNotSent
          )
            throw error;
          mediaResult.push({
            error: error instanceof Error ? error.message : "send failed",
          });
        }
      }
      store.run(
        "UPDATE deliveries SET state='sent',result=? WHERE id=?",
        JSON.stringify(
          mediaResult.length ? { sent, media: mediaResult } : sent,
        ),
        delivery.id,
      );
    } catch (error) {
      if (error instanceof ChannelOffline) {
        store.run(
          "UPDATE deliveries SET state='pending' WHERE id=? AND state='sending'",
          delivery.id,
        );
        break;
      }
      const notSent = error instanceof ChannelNotSent;
      // Only WhatsApp flushes here, so every send failure is logged.
      console.error(whatsAppSendFailure(error, redact));
      store.run(
        "UPDATE deliveries SET state=?,result=? WHERE id=?",
        notSent ? "failed" : "uncertain",
        error instanceof ChannelNotSent
          ? "Nothing was sent. It will not be resent."
          : "Send outcome unknown. Not resent automatically.",
        delivery.id,
      );
    }
  }
}

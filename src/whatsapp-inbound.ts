import type { ImageContent } from "@earendil-works/pi-ai";
import {
  bindChannelChat,
  channelChat,
  numberedApproval,
  originHeader,
  parseNumberedReply,
  whatsappApprovalKey,
  type ApprovalChoice,
  type InboundMessage,
} from "./channel.js";
import { resolveFunctions } from "./functions.js";
import { imageVerdict } from "./outbound.js";
import { mcpUncertainNeedsNotice, type McpCall } from "./mcp-calls.js";
import {
  acceptStoredOauthPaste,
  UPSY_OAUTH_CREDENTIAL,
  vaultFromStore,
} from "./mcp-oauth.js";
import { isRetryableError, type Runtime } from "./runtime.js";
import { childIds, queueWhatsApp } from "./store.js";
import { mcpApprovalPrompt } from "./telegram-approvals.js";
import { transcribeAudio } from "./transcribe.js";
import { describeImage } from "./vision.js";
import { chatSeesImages } from "./commands.js";
import {
  orderedPeerIds,
  peerIds,
  takeWhatsAppCommand,
  takeWhatsAppMenu,
} from "./whatsapp-commands.js";

const creating = new Map<string, Promise<string>>();
/** Seen ids older than this are dropped. Baileys does not redeliver them. */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Same caps Telegram applies after download. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;

async function conversationFor(app: Runtime, message: InboundMessage) {
  const ids = peerIds(message);
  let found: string | undefined;
  for (const id of ids) {
    const existing = app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM channel_chats WHERE channel=? AND chatId=?",
      message.channel,
      id,
    );
    if (existing && !app.store.conversationDeleted(existing.conversationId)) {
      found = existing.conversationId;
      break;
    }
  }
  const bindAll = (conversationId: string) => {
    for (const id of orderedPeerIds(ids))
      bindChannelChat(app.store, message.channel, id, conversationId);
  };
  if (found) {
    bindAll(found);
    return found;
  }
  const key = [...ids].sort().join("\n");
  const pending = creating.get(key);
  if (pending) return pending;
  const work = app.create("WhatsApp").then((id) => {
    bindAll(id);
    return id;
  });
  creating.set(key, work);
  try {
    return await work;
  } finally {
    creating.delete(key);
  }
}

async function turnText(app: Runtime, message: InboundMessage) {
  const functions = resolveFunctions(
    process.env,
    app.settings.setup(),
    app.settings.setupKeys(),
  );
  let text = message.text.trim();
  let images: ImageContent[] | undefined;
  if (message.image) {
    const bytes = Buffer.from(message.image.data, "base64").byteLength;
    const verdict =
      bytes > MAX_IMAGE_BYTES
        ? { ok: false as const, reason: "image exceeds the 5 MB limit" }
        : imageVerdict(message.image.data, message.image.mimeType);
    // `native` sends the picture. `text` always describes. `auto` sends it only
    // when the chat model reads images, same as Telegram.
    const native =
      functions.imageMode === "native" ||
      (functions.imageMode === "auto" && chatSeesImages(app));
    if (!verdict.ok)
      text = `${originHeader("image", { origin: "image", error: verdict.reason })}\n${text}`;
    else if (native) {
      images = [
        {
          type: "image",
          data: message.image.data,
          mimeType: message.image.mimeType,
        },
      ];
      const choice = app.settings.defaults();
      text = `${originHeader("image", { origin: "image", model: `${choice.provider}/${choice.modelId}` })}\n${text}`;
    } else if (functions.vision) {
      try {
        const description = await describeImage(
          functions.vision,
          message.image,
        );
        text = `${originHeader("image: automatic description", { origin: "image", model: functions.vision.modelId })}\n${text}\n${description}`;
      } catch {
        text = `${originHeader("image", { origin: "image", error: "could not describe" })}\n${text}`;
      }
    } else
      text = `${originHeader("image", { origin: "image", error: "no model reads images (set VISION_MODEL)" })}\n${text}`;
  }
  if (message.audio) {
    if (message.audio.data.byteLength > MAX_VOICE_BYTES)
      text = originHeader("audio", {
        origin: "audio",
        error: "audio exceeds the 10 MB limit",
      });
    else if (!functions.audio)
      text = originHeader("audio", {
        origin: "audio",
        error: "no model transcribes",
      });
    else {
      try {
        const spoken = await transcribeAudio(functions.audio, message.audio);
        text = `${originHeader("audio transcript", { origin: "audio", model: functions.audio.modelId })}\n${spoken}`;
      } catch {
        text = originHeader("audio", {
          origin: "audio",
          error: "transcription failed",
        });
      }
    }
  }
  return { text: text.trim() || "(attachment)", images };
}

/**
 * Same two notices Telegram shows before a turn: the one-time default-model
 * warning, and the busy line when a turn is already running. /stop is a turn,
 * so it gets the model notice and not the busy line.
 */
function noteAdmittedTurn(
  app: Runtime,
  message: InboundMessage,
  conversationId: string,
) {
  const notice = app.settings.pendingModelNotice(conversationId);
  if (notice) {
    app.settings.markModelNoticeShown(conversationId);
    queueWhatsApp(
      app.store,
      `whatsapp:model-notice:${message.messageId}`,
      message.chatId,
      notice,
      conversationId,
    );
  }
  const start = message.text.trimStart();
  const isCommand = start.startsWith("/") && !start.startsWith("//");
  if (
    !isCommand &&
    app.isTurnBusy(conversationId) &&
    app.markTurnBusyNotified(conversationId)
  ) {
    queueWhatsApp(
      app.store,
      `whatsapp:busy:${message.messageId}`,
      message.chatId,
      "Got it. I will take that into account. /stop cancels.",
      conversationId,
    );
  }
}

function requestIdFor(messageId: string) {
  const safe = messageId.replace(/[^\w:.-]/g, "_").slice(0, 140);
  return `wa:${safe || "msg"}`;
}

interface OpenApproval {
  interactionId: string;
  choices: ApprovalChoice["action"][];
}

function approvalKey(conversationId: string) {
  return whatsappApprovalKey(conversationId);
}

/**
 * The open numbered approval, or nothing. A row that is no longer pending
 * (restart expires it) is dropped, so the next approval can be queued and a
 * later number is an ordinary message.
 */
function openApproval(app: Runtime, conversationId: string) {
  const key = approvalKey(conversationId);
  const saved = app.store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key=?",
    key,
  );
  if (!saved) return undefined;
  const drop = () => {
    app.store.run("DELETE FROM meta WHERE key=?", key);
  };
  let open: OpenApproval;
  try {
    open = JSON.parse(saved.value) as OpenApproval;
  } catch {
    drop();
    return undefined;
  }
  if (
    !open ||
    typeof open.interactionId !== "string" ||
    !Array.isArray(open.choices)
  ) {
    drop();
    return undefined;
  }
  const row = app.store.get<{ state: string }>(
    "SELECT state FROM mcp_interactions WHERE id=? AND conversationId=?",
    open.interactionId,
    conversationId,
  );
  if (row?.state !== "pending") {
    drop();
    return undefined;
  }
  return open;
}

/** Plain notice for a WhatsApp chat. There is no button; /resume clears it. */
export function queueWhatsAppUncertainNotices(app: Runtime) {
  if (!app.mcpCalls) return;
  for (const call of app.store.all<McpCall>(
    "SELECT * FROM mcp_calls WHERE state='uncertain'",
  )) {
    if (!mcpUncertainNeedsNotice(call)) continue;
    if (
      app.mcpCalls
        .interactions(call.conversationId)
        .some((item) => item.callId === call.id && item.state === "pending")
    )
      continue;
    const bound = channelChat(app.store, "whatsapp", call.conversationId);
    if (!bound) continue;
    const prefix = `whatsapp:mcp-uncertain:${call.id}`;
    if (
      app.store.get(
        "SELECT 1 FROM deliveries WHERE id>=? AND id<?",
        ...childIds(prefix),
      )
    )
      continue;
    queueWhatsApp(
      app.store,
      prefix,
      bound.chatId,
      "Não sei se a chamada terminou. Use /resume.",
      call.conversationId,
    );
  }
}

/**
 * Pending MCP approvals for WhatsApp chats, as a numbered reply. Buttons stay
 * on Telegram; this only runs for conversations bound to WhatsApp.
 */
export function queueWhatsappApprovals(app: Runtime) {
  const rows = app.store.all<{
    id: string;
    callId: string;
    conversationId: string;
    server: string;
    kind: "form" | "url" | "resume";
    payload: string;
    state: string;
    response: string | null;
  }>("SELECT * FROM mcp_interactions WHERE state='pending' ORDER BY rowid");
  for (const item of rows) {
    const bound = channelChat(app.store, "whatsapp", item.conversationId);
    if (!bound) continue;
    if (openApproval(app, item.conversationId)) continue;
    const prefix = whatsappApprovalKey(item.id);
    if (
      app.store.get(
        "SELECT 1 FROM deliveries WHERE id>=? AND id<?",
        ...childIds(prefix),
      )
    )
      continue;
    const prompt = mcpApprovalPrompt(app, item);
    if (!prompt) continue;
    queueWhatsApp(
      app.store,
      prefix,
      bound.chatId,
      numberedApproval(prompt.display, prompt.choices),
      item.conversationId,
    );
    app.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      approvalKey(item.conversationId),
      JSON.stringify({
        interactionId: item.id,
        choices: prompt.choices.map((choice) => choice.action),
      } satisfies OpenApproval),
    );
  }
}

/** A numbered reply decides the open approval and does not start a turn. */
export async function takeNumberedApproval(
  app: Runtime,
  conversationId: string,
  chatId: string,
  text: string,
) {
  const open = openApproval(app, conversationId);
  if (!open) return false;
  const index = parseNumberedReply(text, open.choices.length);
  if (!index) return false;
  const action = open.choices[index - 1];
  if (action !== "accept" && action !== "decline") return false;
  const parts = app.store.all<{
    state: string;
    chat: string;
    channel: string | null;
    conversationId: string | null;
  }>(
    `SELECT d.state,d.chat,d.channel,c.conversationId FROM deliveries d
     LEFT JOIN delivery_conversations c ON c.deliveryId=d.id
     WHERE d.id>=? AND d.id<?`,
    ...childIds(whatsappApprovalKey(open.interactionId)),
  );
  if (
    !parts.length ||
    parts.some(
      (part) =>
        part.state !== "sent" ||
        part.channel !== "whatsapp" ||
        part.chat !== chatId ||
        part.conversationId !== conversationId,
    )
  )
    return false;
  try {
    await app.mcpCalls.decide(
      conversationId,
      open.interactionId,
      action,
      action === "accept" ? {} : undefined,
    );
    app.store.run("DELETE FROM meta WHERE key=?", approvalKey(conversationId));
    queueWhatsApp(
      app.store,
      `whatsapp:approval-result:${open.interactionId}`,
      chatId,
      action === "accept" ? "Approved." : "Declined.",
      conversationId,
    );
  } catch {
    // The number was not a decision. A later number can still decide while
    // the interaction is pending. This reply continues as a normal message.
    const row = app.store.get<{ state: string }>(
      "SELECT state FROM mcp_interactions WHERE id=?",
      open.interactionId,
    );
    if (row?.state !== "pending")
      app.store.run(
        "DELETE FROM meta WHERE key=?",
        approvalKey(conversationId),
      );
    return false;
  }
  return true;
}

/** Admits one WhatsApp message into the same agent loop Telegram uses. */
export async function acceptWhatsAppMessage(
  app: Runtime,
  message: InboundMessage,
) {
  if (message.channel !== "whatsapp") return;
  const seen = `whatsapp:seen:${message.messageId}`;
  app.store.run(
    "DELETE FROM meta WHERE key LIKE 'whatsapp:seen:%' AND CAST(value AS INTEGER) < ?",
    Date.now() - SEEN_TTL_MS,
  );
  const inserted = app.store.run(
    "INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)",
    seen,
    String(Date.now()),
  ).changes;
  if (!inserted) return;
  try {
    if (message.unsupported) {
      queueWhatsApp(
        app.store,
        `whatsapp:unsupported:${message.messageId}`,
        message.chatId,
        message.text,
      );
      return;
    }
    const conversationId = await conversationFor(app, message);
    // Same paste Telegram accepts. A loopback redirect finishes the Upsy login
    // already in progress and is not sent to the model. The login itself is unchanged.
    const oauthPaste = await acceptStoredOauthPaste(
      vaultFromStore(app.store),
      UPSY_OAUTH_CREDENTIAL,
      message.text,
    );
    if (oauthPaste.handled) {
      queueWhatsApp(
        app.store,
        `whatsapp:oauth:${message.messageId}`,
        message.chatId,
        oauthPaste.message,
        conversationId,
      );
      return;
    }
    if (
      await takeNumberedApproval(
        app,
        conversationId,
        message.chatId,
        message.text,
      )
    )
      return;
    if (await takeWhatsAppCommand(app, message, conversationId)) return;
    if (await takeWhatsAppMenu(app, message, conversationId)) return;
    noteAdmittedTurn(app, message, conversationId);
    const escaped =
      !message.image &&
      !message.audio &&
      message.text.trimStart().startsWith("//");
    const { text, images } = await turnText(
      app,
      escaped ? { ...message, text: message.text.replace("/", "") } : message,
    );
    await app.submit(
      conversationId,
      requestIdFor(message.messageId),
      text,
      "whatsapp",
      message.chatId,
      undefined,
      images,
      true,
    );
  } catch (error) {
    if (isRetryableError(error))
      app.store.run("DELETE FROM meta WHERE key=?", seen);
    // Baileys does not redeliver after this process has seen the message, so a
    // log line alone drops it. The chat is told to send it again.
    queueWhatsApp(
      app.store,
      `whatsapp:inbound-failed:${message.messageId}`,
      message.chatId,
      "Não consegui processar esta mensagem; envie de novo.",
    );
    throw error;
  }
}

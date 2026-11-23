import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import {
  bindChannelChat,
  numberedList,
  parseNumberedReply,
  type InboundMessage,
} from "./channel.js";
import {
  CommandError,
  COMPACTION_STATUS,
  commandStatus,
  commandReceipt,
  resumeReport,
  type CommandAccess,
} from "./commands.js";
import type { Runtime } from "./runtime.js";
import { SettingsError } from "./settings.js";
import { queueWhatsApp } from "./store.js";
import { TaskError } from "./tasks.js";

const MENU_CAP = 30;

const HELP = [
  "/status — status, tokens and cost",
  "/recibo [n] — turn receipt",
  "/stop — stop this chat",
  "/new — new conversation in this chat (the previous one stays)",
  "/resume — resume a stuck task, or dismiss an uncertain MCP result",
  "/compact — compact this chat (optional instructions after the command)",
  "/memory — show saved memory",
  "/forget <text> — remove matching lines from memory",
  "/model — choose a model (reply with the number)",
  "/thinking — choose effort (reply with the number)",
  "/crons — schedules in this chat (reply with the number to turn one on or off)",
  "/help — this list",
  "A message that starts with // is sent as text, not as a command.",
].join("\n");

type OpenMenu =
  | { kind: "provider"; choices: string[] }
  | { kind: "model"; provider: string; choices: string[] }
  | { kind: "thinking"; choices: string[] }
  | { kind: "cron"; choices: string[] };

function menuKey(conversationId: string) {
  return `whatsapp:menu:${conversationId}`;
}

function accessFor(message: InboundMessage): CommandAccess {
  return {
    source: "whatsapp",
    user: message.chatId,
    chat: message.chatId,
  };
}

export function peerIds(message: InboundMessage) {
  return [
    ...new Set(
      [message.chatId, ...(message.aliases ?? [])].filter((id) => id.trim()),
    ),
  ];
}

/** Phone JIDs last, so the newest channel_chats row is the number sends use. */
export function orderedPeerIds(ids: readonly string[]) {
  const phones = ids.filter((id) => id.endsWith("@s.whatsapp.net"));
  const rest = ids.filter((id) => !phones.includes(id));
  return [...rest, ...phones];
}

function reply(
  app: Runtime,
  message: InboundMessage,
  conversationId: string,
  text: string,
) {
  // Plain text. The gateway adds `Pi: ` only when this chat is the linked account.
  queueWhatsApp(
    app.store,
    `whatsapp:cmd:${message.messageId}`,
    message.chatId,
    text,
    conversationId,
  );
}

function clearMenu(app: Runtime, conversationId: string) {
  app.store.run("DELETE FROM meta WHERE key=?", menuKey(conversationId));
}

function saveMenu(app: Runtime, conversationId: string, menu: OpenMenu) {
  app.store.run(
    "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    menuKey(conversationId),
    JSON.stringify(menu),
  );
}

function readMenu(app: Runtime, conversationId: string): OpenMenu | undefined {
  const row = app.store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key=?",
    menuKey(conversationId),
  );
  if (!row) return undefined;
  try {
    const menu = JSON.parse(row.value) as OpenMenu;
    if (
      !menu ||
      !Array.isArray(menu.choices) ||
      menu.choices.some((choice) => typeof choice !== "string")
    )
      return undefined;
    if (
      menu.kind === "provider" ||
      menu.kind === "thinking" ||
      menu.kind === "cron" ||
      (menu.kind === "model" && typeof menu.provider === "string")
    )
      return menu;
  } catch {
    /* A broken menu is dropped below. */
  }
  return undefined;
}

async function modelProviders(app: Runtime, conversationId: string) {
  const rows = (
    await Promise.all(
      app.models.getProviders().map(async (provider) => {
        try {
          if (!(await app.models.checkAuth(provider.id))) return undefined;
          const models = app.settings.catalog(provider.id);
          if (!models.length) return undefined;
          return { id: provider.id, name: provider.name, models };
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((row) => row !== undefined);
  if (rows.length) return rows;
  const current = await app.settings.conversation(conversationId);
  const models = app.settings.catalog(current.provider);
  return models.length
    ? [{ id: current.provider, name: current.provider, models }]
    : [];
}

function showModels(
  app: Runtime,
  message: InboundMessage,
  conversationId: string,
  provider: string,
  models: { id: string; name: string }[],
) {
  const shown = models.slice(0, MENU_CAP);
  saveMenu(app, conversationId, {
    kind: "model",
    provider,
    choices: shown.map((model) => model.id),
  });
  const title =
    shown.length < models.length
      ? `Model (${provider}). Showing the first ${shown.length}.`
      : `Model (${provider}).`;
  reply(
    app,
    message,
    conversationId,
    numberedList(
      title,
      shown.map((model) => `${model.name} (${model.id})`),
    ),
  );
}

/**
 * A leading `/` is a command. `//` is not. A photo or voice note is not.
 * Returns true when the message was handled and must not start a turn.
 */
export async function takeWhatsAppCommand(
  app: Runtime,
  message: InboundMessage,
  conversationId: string,
) {
  const start = message.text.trimStart();
  if (!start.startsWith("/") || start.startsWith("//")) return false;
  const parsed = /^\/([a-z]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i.exec(
    message.text.trim(),
  );
  const name = parsed?.[1]?.toLowerCase() ?? "";
  const args = parsed?.[2]?.trim() ?? "";
  // Same as Telegram: /stop cancels MCP, then the text is a normal turn.
  // A caption on a photo or voice note counts. /cancel is not a command.
  if (name === "stop") {
    app.mcpCalls?.cancelConversation(conversationId);
    void app.stopSubagents(conversationId);
    return false;
  }
  if (message.image || message.audio) return false;
  try {
    await runCommand(app, message, conversationId, name, args);
  } catch (error) {
    if (
      error instanceof CommandError ||
      error instanceof SettingsError ||
      error instanceof TaskError
    ) {
      reply(app, message, conversationId, error.message);
      return true;
    }
    throw error;
  }
  return true;
}

async function runCommand(
  app: Runtime,
  message: InboundMessage,
  conversationId: string,
  name: string,
  args: string,
) {
  clearMenu(app, conversationId);
  const access = accessFor(message);
  // Extra text after /model or /thinking is ignored: WhatsApp has no buttons,
  // so the command still opens the numbered list, as /model does on Telegram.
  const takesArgs =
    name === "compact" ||
    name === "model" ||
    name === "thinking" ||
    name === "forget" ||
    name === "recibo";
  if (name && args && !takesArgs) {
    reply(app, message, conversationId, `Unknown command.\n${HELP}`);
    return;
  }
  if (name === "help" || name === "start") {
    reply(app, message, conversationId, HELP);
    return;
  }
  if (name === "status") {
    reply(
      app,
      message,
      conversationId,
      `${await commandStatus(app, conversationId, access, "chat")}\n${COMPACTION_STATUS}`,
    );
    return;
  }
  if (name === "recibo") {
    reply(
      app,
      message,
      conversationId,
      commandReceipt(app, conversationId, access, args),
    );
    return;
  }
  if (name === "new") {
    const created = await app.create("WhatsApp");
    for (const chat of orderedPeerIds(peerIds(message)))
      bindChannelChat(app.store, "whatsapp", chat, created);
    reply(
      app,
      message,
      created,
      "New conversation in this chat. The previous one stays on the volume and its history was not deleted. Uncertain MCP results were not dismissed; use /resume for that.",
    );
    return;
  }
  if (name === "resume") {
    app.commands.authorize(conversationId, access);
    const cleared = app.mcpCalls?.clearUncertain(conversationId) ?? 0;
    const resumed = await app.resumeParked(conversationId);
    reply(app, message, conversationId, resumeReport(cleared, resumed, "chat"));
    return;
  }
  if (name === "compact") {
    app.commands.authorize(conversationId, access);
    reply(
      app,
      message,
      conversationId,
      await app.compactConversation(conversationId, args || undefined),
    );
    return;
  }
  if (name === "memory" || name === "forget") {
    app.commands.authorize(conversationId, access);
    const text =
      name === "memory" ? app.memory?.show() : app.memory?.forget(args);
    reply(app, message, conversationId, text ?? "Memory is disabled.");
    return;
  }
  if (name === "model" || name === "thinking") {
    app.commands.authorize(conversationId, access);
    if (name === "thinking") {
      await showThinking(app, message, conversationId);
      return;
    }
    const providers = await modelProviders(app, conversationId);
    if (!providers.length) {
      reply(app, message, conversationId, "No model available.");
      return;
    }
    if (providers.length === 1) {
      showModels(
        app,
        message,
        conversationId,
        providers[0]!.id,
        providers[0]!.models,
      );
      return;
    }
    const shown = providers.slice(0, MENU_CAP);
    saveMenu(app, conversationId, {
      kind: "provider",
      choices: shown.map((provider) => provider.id),
    });
    reply(
      app,
      message,
      conversationId,
      numberedList(
        "Provider.",
        shown.map((provider) =>
          provider.name === provider.id
            ? provider.id
            : `${provider.name} (${provider.id})`,
        ),
      ),
    );
    return;
  }
  if (name === "crons") {
    app.commands.authorize(conversationId, access);
    const tasks = app.tasks
      .list()
      .filter((task) => task.conversationId === conversationId);
    if (!tasks.length) {
      reply(app, message, conversationId, "No schedules in this chat.");
      return;
    }
    const shown = tasks.slice(0, MENU_CAP);
    saveMenu(app, conversationId, {
      kind: "cron",
      choices: shown.map((task) => task.id),
    });
    reply(
      app,
      message,
      conversationId,
      numberedList(
        shown.length < tasks.length
          ? `Schedules. Showing the first ${shown.length}. Reply with the number to turn one on or off.`
          : "Schedules. Reply with the number to turn one on or off.",
        shown.map(
          (task) =>
            `${task.title} — ${task.enabled ? "on" : "off"} — ${task.schedule}`,
        ),
      ),
    );
    return;
  }
  reply(app, message, conversationId, `Unknown command.\n${HELP}`);
}

async function showThinking(
  app: Runtime,
  message: InboundMessage,
  conversationId: string,
) {
  const current = await app.settings.conversation(conversationId);
  const model = app.models.getModel(current.provider, current.modelId);
  const efforts = model ? getSupportedThinkingLevels(model) : [];
  if (!efforts.length) {
    reply(app, message, conversationId, "This model has no effort levels.");
    return;
  }
  saveMenu(app, conversationId, { kind: "thinking", choices: [...efforts] });
  reply(
    app,
    message,
    conversationId,
    numberedList(`Effort. Current: ${current.effort}.`, [...efforts]),
  );
}

/**
 * A bare number answers an open model, effort, or schedule list.
 * Anything else stays a normal message, and an approval number is decided first.
 */
export async function takeWhatsAppMenu(
  app: Runtime,
  message: InboundMessage,
  conversationId: string,
) {
  if (message.image || message.audio) return false;
  const menu = readMenu(app, conversationId);
  if (!menu) return false;
  const index = parseNumberedReply(message.text, menu.choices.length);
  if (!index) return false;
  const choice = menu.choices[index - 1];
  if (!choice) return false;
  try {
    app.commands.authorize(conversationId, accessFor(message));
    if (menu.kind === "provider") {
      const providers = await modelProviders(app, conversationId);
      const provider = providers.find((item) => item.id === choice);
      if (!provider) {
        clearMenu(app, conversationId);
        reply(
          app,
          message,
          conversationId,
          "That provider is not available. Use /model again.",
        );
        return true;
      }
      showModels(app, message, conversationId, provider.id, provider.models);
      return true;
    }
    if (menu.kind === "model") {
      const native = app.models.getModel(menu.provider, choice);
      if (!native) {
        clearMenu(app, conversationId);
        reply(
          app,
          message,
          conversationId,
          "Model not available. Use /model again.",
        );
        return true;
      }
      const current = await app.settings.conversation(conversationId);
      const saved = await app.settings.saveConversation(conversationId, {
        provider: menu.provider,
        modelId: choice,
        effort: clampThinkingLevel(native, current.effort),
      });
      clearMenu(app, conversationId);
      reply(
        app,
        message,
        conversationId,
        `Model set to ${saved.provider}/${saved.modelId}, effort ${saved.effort}.`,
      );
      return true;
    }
    if (menu.kind === "thinking") {
      const current = await app.settings.conversation(conversationId);
      const saved = await app.settings.saveConversation(conversationId, {
        provider: current.provider,
        modelId: current.modelId,
        effort: choice,
      });
      clearMenu(app, conversationId);
      reply(app, message, conversationId, `Effort set to ${saved.effort}.`);
      return true;
    }
    const task = app.tasks.get(choice);
    if (!task || task.conversationId !== conversationId) {
      clearMenu(app, conversationId);
      reply(
        app,
        message,
        conversationId,
        "That schedule is gone. Use /crons again.",
      );
      return true;
    }
    const next = app.tasks.setEnabled(task.id, !task.enabled);
    clearMenu(app, conversationId);
    reply(
      app,
      message,
      conversationId,
      `${next.enabled ? "On" : "Off"}: ${next.title}.`,
    );
    return true;
  } catch (error) {
    if (
      error instanceof CommandError ||
      error instanceof SettingsError ||
      error instanceof TaskError
    ) {
      reply(app, message, conversationId, error.message);
      return true;
    }
    throw error;
  }
}

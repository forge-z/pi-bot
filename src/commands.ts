import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { readAppInfo } from "./app-info.js";
import { resolveFunctions } from "./functions.js";
import { formatMcpStatus, MCP_DISCOVERY_UNANSWERED } from "./mcp.js";
import {
  formatRememberedApprovals,
  RememberedApprovals,
  revokeRememberedApproval,
} from "./remembered-approvals.js";
import type { Runtime } from "./runtime.js";
import {
  GOAL_HELP,
  GoalError,
  formatGoalEnd,
  parseGoalCommand,
} from "./goals.js";
import { TaskError } from "./tasks.js";
import {
  telegramConversationRoute,
  telegramRouteAuthorized,
  type TelegramRoute,
} from "./task-telegram.js";
import type { Store } from "./store.js";

export function commandReceipt(
  app: Runtime,
  conversationId: string,
  access: CommandAccess,
  argument: string,
) {
  app.commands.authorize(conversationId, access);
  return app.turnReceipts.show(conversationId, argument);
}

function rememberedApprovals(app: Runtime) {
  return (
    app.mcpCalls?.rememberedApprovals ?? new RememberedApprovals(app.store)
  );
}

/** `/approvals`: the reads that no longer ask, numbered for `/revoke`. */
export function commandApprovals(
  app: Runtime,
  conversationId: string,
  access: CommandAccess,
) {
  app.commands.authorize(conversationId, access);
  return formatRememberedApprovals(rememberedApprovals(app).list());
}

/** `/revoke <n>`: that read asks for approval again, in chats and scheduled runs. */
export function commandRevoke(
  app: Runtime,
  conversationId: string,
  access: CommandAccess,
  argument: string,
) {
  app.commands.authorize(conversationId, access);
  return revokeRememberedApproval(rememberedApprovals(app), argument);
}

/**
 * `/job`: the latest async job of this conversation, from what the poller stored.
 * No model turn and no MCP call; honest about a stale observation.
 */
export function commandJob(
  app: Runtime,
  conversationId: string,
  access: CommandAccess,
) {
  app.commands.authorize(conversationId, access);
  return app.pendingJobs.jobLine(conversationId);
}

export interface GoalCheckAuthority {
  route: TelegramRoute;
  authorizationVersion: string;
  topicStateVersion: string | null;
}

function goalTopicStateVersion(store: Store, route: TelegramRoute) {
  return (
    store.get<{ version: string }>(
      `SELECT json_array(stateUpdateId,stateBotId,stateDate) AS version
     FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=?`,
      route.chat,
      route.user,
      route.messageThreadId,
    )?.version ?? null
  );
}

export function freezeGoalCheckAuthority(
  store: Store,
  route: TelegramRoute,
): GoalCheckAuthority {
  return {
    route,
    authorizationVersion: store.authorizationVersion(
      route,
      route.conversationId,
    ),
    topicStateVersion: goalTopicStateVersion(store, route),
  };
}

export function goalCheckAuthorized(
  store: Store,
  authority: GoalCheckAuthority,
) {
  const { route, authorizationVersion, topicStateVersion } = authority;
  return (
    telegramRouteAuthorized(store, route) &&
    store.authorizationVersion(route, route.conversationId) ===
      authorizationVersion &&
    goalTopicStateVersion(store, route) === topicStateVersion
  );
}

/** `/goal`: persistent goals, Telegram-only, created in the exact
 * chat/user/bot/topic of the incoming update. A public GitHub PR target is a
 * read-only PR goal; any other objective is a kind='goal' task checked by a
 * scheduled model round. Scoped controls: /goal list, /goal check and
 * /goal cancel — a goal never appears in /crons or the generic task APIs. */
export async function commandGoal(
  app: Runtime,
  conversationId: string,
  access: CommandAccess,
  args: string,
  updateId: number,
  handler?: {
    active: () => boolean;
    goalCheck?: GoalCheckAuthority;
    reply: (text: string, authority?: GoalCheckAuthority) => void;
  },
) {
  if (access.source !== "telegram")
    throw new CommandError(
      "Persistent goals are Telegram-only in this milestone.",
    );
  app.commands.authorize(conversationId, access);
  let command;
  try {
    command = parseGoalCommand(args);
  } catch (error) {
    if (error instanceof GoalError) throw new CommandError(error.message);
    throw error;
  }
  const respond = (text: string, authority?: GoalCheckAuthority) => {
    handler?.reply(text, authority);
    return text;
  };
  if (command.action === "help") return respond(GOAL_HELP);
  // Invalid list/cancel input and refused creations are safe command replies,
  // never a failed update on the transport.
  try {
    if (command.action === "list")
      return respond(app.tasks.goalList(conversationId));
    if (command.action === "cancel")
      return respond(app.tasks.cancelGoal(conversationId, command.index));
    if (command.action === "check") {
      const store = app.store;
      const denied = () =>
        new CommandError("Conversation not authorized in this chat.");
      if (!handler?.goalCheck) throw denied();
      const authority = handler.goalCheck;
      const { route } = authority;
      if (
        route.conversationId !== conversationId ||
        route.chat !== access.chat ||
        route.user !== access.user ||
        route.messageThreadId !== (access.messageThreadId ?? null)
      )
        throw denied();
      const authorize = () => {
        if (!handler.active() || !goalCheckAuthorized(store, authority))
          throw denied();
        app.assertConversationAvailable(conversationId);
      };
      const text = await app.tasks
        .checkGoalNow(conversationId, command.index, authorize)
        .catch((error: unknown) => {
          if (!(error instanceof TaskError)) throw error;
          authorize();
          return error.message;
        });
      // Native control replies do not themselves re-check conversation authority at queue time.
      authorize();
      return respond(text, authority);
    }
  } catch (error) {
    if (error instanceof TaskError) throw new CommandError(error.message);
    throw error;
  }
  // Freeze the destination from THIS update's route, never a current selection.
  const route = telegramConversationRoute(app.store, conversationId);
  if (
    !route ||
    route.chat !== access.chat ||
    route.user !== access.user ||
    route.messageThreadId !== (access.messageThreadId ?? null)
  )
    throw new CommandError(
      "The goal destination must be this chat and topic. The goal was not saved.",
    );
  const requestId = `telegram:goal-create:${updateId}`;
  app.store.savepoint("goal_create_origin", () => {
    app.store.run(
      "INSERT OR IGNORE INTO requests(conversationId,requestId,text,source,chat,status) VALUES (?,?,?,'telegram',?,'done')",
      conversationId,
      requestId,
      "Confirmed persistent goal in this topic.",
      access.chat,
    );
    app.store.run(
      "INSERT OR IGNORE INTO request_telegram_routes VALUES (?,?,?,?,?,?,'authorized',NULL)",
      conversationId,
      requestId,
      route.chat,
      route.user,
      route.botId,
      route.messageThreadId,
    );
  });
  const origin = { source: "telegram" as const, conversationId, requestId };
  try {
    if (command.action === "objective")
      await app.tasks.createObjectiveGoal(
        conversationId,
        origin,
        command.objective,
        command.intervalMin,
        command.maxAttempts,
        command.endAt ?? null,
      );
    else
      await app.tasks.createGoal(
        conversationId,
        origin,
        command.target,
        command.intervalMin,
        command.maxAttempts,
      );
  } catch (error) {
    if (error instanceof TaskError) throw new CommandError(error.message);
    throw error;
  }
  if (command.action === "objective")
    return respond(
      `Goal saved: watching for "${command.objective}". Checking every ${command.intervalMin} minutes, at most ${command.maxAttempts} checks${command.endAt !== undefined ? `, until ${formatGoalEnd(command.endAt)}` : ""}. Nothing is sent until it happens; then you are told once and the goal ends. Use /goal list and /goal cancel <number>.`,
    );
  return respond(
    `Goal saved: notify this chat when ${command.target.owner}/${command.target.repo}#${command.target.prNumber} is merged. Checking every ${command.intervalMin} minutes, at most ${command.maxAttempts} checks. Use /goal list and /goal cancel <number>.`,
  );
}

export type CommandAccess = {
  source: "telegram" | "whatsapp";
  user: string;
  chat: string;
  messageThreadId?: number;
};
export class CommandError extends Error {}
export class Commands {
  constructor(private app: Runtime) {}
  key(requestId: string, access: CommandAccess) {
    const topic =
      access.messageThreadId === undefined
        ? ""
        : `topic:${access.messageThreadId}:`;
    return `${access.source}:${access.chat}:${access.user}:${topic}${requestId}`;
  }
  allowed(access: CommandAccess) {
    if (access.source === "whatsapp")
      return this.app.store.all<{ id: string; title: string }>(
        `SELECT c.id,c.title FROM conversations c
         JOIN channel_chats ch ON ch.conversationId=c.id
         WHERE ch.channel='whatsapp' AND ch.chatId=?
         AND c.id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL)
         ORDER BY c.rowid DESC`,
        access.chat,
      );
    const rows = this.app.store.all<{ id: string; title: string }>(
      "SELECT c.id,c.title FROM conversations c JOIN telegram_grants g ON g.conversationId=c.id WHERE g.chat=? AND g.user=? AND c.id NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY c.rowid DESC",
      access.chat,
      access.user,
    );
    return rows.filter((row) => {
      if (!this.app.telegramChats.dedicated(row.id))
        return access.messageThreadId === undefined;
      if (!this.app.telegramChats.owns(row.id, access)) return false;
      try {
        this.app.telegramChats.authorize(row.id, access);
        return true;
      } catch {
        return false;
      }
    });
  }
  authorize(id: string, access: CommandAccess) {
    if (access.source === "whatsapp") {
      if (!this.allowed(access).some((item) => item.id === id))
        throw new CommandError("Conversation not authorized in this chat.");
      this.app.assertConversationAvailable(id);
      return;
    }
    if (
      this.app.telegramChats.dedicated(id) &&
      this.app.telegramChats.owns(id, access)
    )
      // A listing may omit temporarily unavailable rows. An admission must
      // preserve the actual error so polling can retry rather than reject it.
      this.app.telegramChats.authorize(id, access);
    if (!this.allowed(access).some((item) => item.id === id))
      throw new CommandError("Conversation not authorized in this chat.");
    this.app.assertConversationAvailable(id);
  }
  async active(access: CommandAccess) {
    const ids = new Set(this.allowed(access).map((item) => item.id));
    const inspection = await this.app.harness.inspect(context);
    return inspection.tasks
      .filter(({ record }) => ids.has(String(record.conversationId)))
      .map(({ record, state }) => ({
        id: String(record.id),
        kind: record.kind,
        conversationId: String(record.conversationId),
        background: record.background,
        abortRequested: record.abortRequested,
        status: record.state.status,
        phase: state.kind,
      }));
  }
}

function featureLabel(
  feature: { modelId: string; language?: string } | undefined,
  whenMissing: string,
) {
  if (!feature) return whenMissing;
  return feature.language
    ? `${feature.modelId} (${feature.language})`
    : feature.modelId;
}

/** Whether the chat model reads images. A setup probe beats the catalog default. */
export function chatSeesImages(app: Runtime) {
  const probed = app.settings.setup()?.chatVision;
  if (probed !== undefined) return probed;
  const choice = app.settings.defaults();
  const model = app.models.getModel(choice.provider, choice.modelId);
  return Boolean(model?.input?.includes("image"));
}

/**
 * The `/status` body. Telegram says "topic"; WhatsApp says "chat".
 * The command menu reload stays with the caller: only Telegram has one.
 */
export async function commandStatus(
  app: Runtime,
  id: string,
  access: CommandAccess,
  where: "topic" | "chat" = "topic",
) {
  const mcp = app.mcpStatusSnapshot();
  const settings = await app.settings.conversation(id);
  const active = await app.commands.active(access);
  const info = readAppInfo();
  const calls =
    app.mcpCalls
      ?.list(id)
      .filter((call) =>
        ["paused", "running", "uncertain", "abandoned"].includes(call.state),
      ) ?? [];
  const pending =
    app.mcpCalls?.interactions(id).filter((item) => item.state === "pending")
      .length ?? 0;
  const ledger =
    calls
      .map((call) => `${call.server} / ${call.tool}: ${call.state}`)
      .join("\n") || "No pending or uncertain calls.";
  if (mcp.unanswered) console.warn(`Pi-Agent: ${MCP_DISCOVERY_UNANSWERED}`);
  const functions = resolveFunctions(
    process.env,
    app.settings.setup(),
    app.settings.setupKeys(),
  );
  const usage = await app.usageLine(id);
  return [
    "Models:",
    `Text: ${settings.modelId} · Effort: ${settings.effort}`,
    `Vision: ${featureLabel(functions.vision, chatSeesImages(app) ? "same as chat" : "off")}`,
    `Audio: ${featureLabel(functions.audio, "off")}`,
    "",
    `Runs in this ${where}: ${active.length} · Pending approvals: ${pending}`,
    usage,
    "",
    "MCP ledger:",
    ledger,
    "",
    "MCPs:",
    formatMcpStatus(mcp.servers),
    "",
    app.pendingJobs.healthLine(),
    "",
    `Version: ${info.version ?? "dev"} (${info.commit ?? "no SHA"})`,
  ].join("\n");
}

/** Kept as its own line so both channels append the same sentence. */
export const COMPACTION_STATUS =
  "Automatic compaction: this conversation's active model and effort.";

/** One reply for /resume: parked work, an uncertain MCP result, both, or neither. */
export function resumeReport(
  cleared: number,
  resumed: { id: string; kind: string }[],
  where: "topic" | "chat" = "topic",
) {
  const parts: string[] = [];
  if (cleared)
    parts.push(
      `${cleared} uncertain MCP result(s) in this conversation dismissed. History was not changed. The call may already have been executed (for example, an email may have gone out) before the agent continues.`,
    );
  if (resumed.length)
    parts.push(
      `Resumed ${resumed.map((task) => `${task.kind} #${task.id}`).join(", ")}.`,
    );
  return parts.join("\n") || `Nothing is pending in this ${where}.`;
}

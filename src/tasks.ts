import { createHash, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { ConversationBusyError, type Runtime } from "./runtime.js";
import { channelChat } from "./channel.js";
import {
  isBlankMessage,
  queueTaskTelegram,
  taskTelegramAvailable,
  telegramConversationRoute,
  telegramRouteAuthorized,
  type TelegramRoute,
} from "./task-telegram.js";
import { logFailure } from "./log.js";
import { MAX_TEXT, REQUEST_ID, truncateTaskSummary } from "./limits.js";
import {
  GOAL_ATTEMPTS_MAX,
  GOAL_INTERVAL_MAX,
  GOAL_INTERVAL_MIN,
  formatGoalEnd,
  observePrMerged,
  type GoalFetcher,
  type GoalTarget,
  type PrObservation,
} from "./goals.js";

type TaskDelivery = "legacy" | "web" | "web_telegram" | "none";
/**
 * Runs as callers see them: `trigger` is derived from the stored `scheduled` flag, so a
 * manual run is named without a second column to keep in sync.
 */
const RUN_SELECT = `SELECT *, CASE scheduled WHEN 1 THEN 'scheduled' ELSE 'manual' END AS trigger FROM task_runs`;

/** The execution log keeps seven days, the window an operator actually reads. */
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_SWEEP_MS = 60 * 60 * 1000;
/** How often stale in-flight runs are checked for timeout. */
const RUN_WATCH_MS = 30 * 1000;
const MEMORY_CONSOLIDATION_CRON = "0 3 * * *";
const DEFAULT_RUN_TIMEOUT_MIN = 30;
/** Goal checks per tick pass: ordinary admissions run first, the rest stays due. */
const GOAL_CHECKS_PER_TICK = 2;
/** Model rounds of free-objective goals admitted per tick; the rest stays due. */
const GOAL_ROUNDS_PER_TICK = 1;
const GOAL_LIST_LIMIT = 20;
/** A PR goal is a kind='goal' task with task_goals metadata; a free-objective
 * goal is a kind='goal' task without it, run by the ordinary model pipeline. */
const PR_GOAL = (alias: string) =>
  `EXISTS (SELECT 1 FROM task_goals pg WHERE pg.taskId=${alias}.id)`;
const OBJECTIVE_GOAL = (alias: string) =>
  `${alias}.kind='goal' AND NOT ${PR_GOAL(alias)}`;
/** Additive, nullable or defaulted: an older row reads as a pending goal with
 * no attempts and the default cap, and older explicit-column INSERTs still work. */
const GOAL_COLUMNS: Record<string, string> = {
  goalState: "TEXT",
  goalEvidence: "TEXT",
  goalAttempts: "INTEGER NOT NULL DEFAULT 0",
  goalMaxAttempts: "INTEGER",
  goalEndAt: "INTEGER",
};
const GOAL_EVERY = /^every-([1-9][0-9]{0,4})m$/;
const GOAL_EVIDENCE_MAX = 2000;
const GOAL_REACHED_OUTSIDE =
  "goal_reached is only available in a scheduled goal check. Nothing was recorded.";
const GOAL_REACHED_NO_EVIDENCE =
  "goal_reached needs evidence: what you observed, with the value and its source. Nothing was recorded.";
const GOAL_MERGED_REASON = "The pull request was merged.";
const GOAL_NOT_FOUND_REASON =
  "The pull request was not found on GitHub: it does not exist, was renamed, or became private.";
const GOAL_RATE_LIMITED = "GitHub rate limited the check.";

interface GoalRow {
  taskId: string;
  owner: string;
  repo: string;
  prNumber: number;
  intervalMin: number;
  maxAttempts: number;
  attempts: number;
  state: "pending" | "completed" | "blocked" | "cancelled";
  reason: string | null;
  lastResult: string | null;
  /** When the current run of rate-limited reads began; NULL when not rate limited. */
  rateLimitedAt: number | null;
}
/** A due goal read as one row: the task carries the frozen destination. */
interface GoalTask {
  id: string;
  conversationId: string;
  enabled: number;
  nextRun: number | null;
  destinationChat: string | null;
  destinationUser: string | null;
  destinationBotId: string | null;
  destinationMessageThreadId: number | null;
  destinationReason: string | null;
  originSource: string | null;
  originRequestId: string | null;
  owner: string;
  repo: string;
  prNumber: number;
  intervalMin: number;
  maxAttempts: number;
  attempts: number;
  goalState: string;
}

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

export interface TaskOrigin {
  source: "web" | "telegram" | "whatsapp";
  conversationId: string;
  requestId: string;
}
interface TaskDestination {
  destinationChat: string | null;
  destinationUser: string | null;
  destinationBotId: string | null;
  destinationMessageThreadId: number | null;
  destinationReason: string | null;
  originSource: "web" | "telegram" | "whatsapp" | null;
  originConversationId: string | null;
  originRequestId: string | null;
}
export interface Task extends TaskDestination {
  id: string;
  title: string;
  prompt: string;
  conversationId: string;
  kind: "once" | "cron" | "goal";
  schedule: string;
  timezone: string;
  delivery: TaskDelivery;
  enabled: boolean;
  nextRun: number | null;
  lastError: string | null;
}
interface TaskRun extends TaskDestination {
  delivery: TaskDelivery;
  conversationId: string;
  id: string;
  /** `manual` when an operator triggered it: it has no planned time, only a trigger one. */
  trigger: "scheduled" | "manual";
  scheduledAt: number;
  state: "pending" | "done" | "failed";
  requestId: string;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** `ok`, `erro` or `silencioso`; null while the occurrence is still pending. */
  status: string | null;
  /** Short answer of the run, or the reason it failed. */
  summary: string | null;
  /** MCP tools that completed during the run, comma separated; the external-action indicator. */
  external: string | null;
}
interface GoalColumns {
  /** NULL or 'pending' while watching; then 'met', 'blocked' or 'cancelled'. */
  goalState: string | null;
  goalEvidence: string | null;
  goalAttempts: number;
  /** NULL means the default cap, GOAL_ATTEMPTS_MAX. */
  goalMaxAttempts: number | null;
  /** Explicit end time in epoch ms; NULL when the user stated none. */
  goalEndAt: number | null;
}
type TaskRow = Omit<Task, "enabled"> &
  GoalColumns & { enabled: number; deleted: number };
type PendingRun = TaskRun & {
  taskId: string;
  conversationId: string;
  prompt: string;
  taskKind?: string;
};
/** One /goal list entry: a PR goal carries its task_goals row, a free one does not. */
interface GoalEntry extends GoalColumns {
  taskId: string;
  conversationId: string;
  title: string;
  prompt: string;
  enabled: number;
  nextRun: number | null;
  lastError: string | null;
  pr: GoalRow | null;
}
type TaskRuntime = Pick<
  Runtime,
  "store" | "create" | "conversation" | "submit"
> &
  Partial<Pick<Runtime, "options" | "durableTasks">>;

function text(value: unknown, field: string, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new TaskError(`${field} is invalid (maximum ${limit} characters)`);
  return value;
}
function nextCron(schedule: string, timezone: string, now: number) {
  if (schedule.split(/\s+/).length !== 5 || /\bH\b/i.test(schedule))
    throw new TaskError("Cron must have exactly 5 fields, with no H/hash");
  try {
    return CronExpressionParser.parse(schedule, {
      tz: timezone,
      currentDate: now,
    })
      .next()
      .getTime();
  } catch {
    throw new TaskError("Invalid cron expression");
  }
}
function onceDate(schedule: string, now: number) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      schedule,
    );
  const timestamp = Date.parse(schedule);
  if (!match || !Number.isFinite(timestamp) || timestamp <= now)
    throw new TaskError(
      "A one-time date must be ISO with Z/offset and in the future",
    );
  const [, year, month, day, hour, minute, second, offset] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second ?? 0) > 59 ||
    (offset !== "Z" &&
      (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
  )
    throw new TaskError("Invalid one-time date");
  return timestamp;
}
/** A goal's next check: `every-<minutes>m` from now; a cron expression otherwise. */
function nextGoal(schedule: string, timezone: string, now: number) {
  const every = GOAL_EVERY.exec(schedule);
  return every
    ? now + Number(every[1]) * 60_000
    : nextCron(schedule, timezone, now);
}
/** Creation keeps the goal floor: a model round at most once an hour. */
function goalCreationNext(schedule: string, now: number) {
  const every = GOAL_EVERY.exec(schedule);
  const minutes = every ? Number(every[1]) : NaN;
  if (!(minutes >= GOAL_INTERVAL_MIN && minutes <= GOAL_INTERVAL_MAX))
    throw new TaskError(
      `A goal schedule is every-<minutes>m, from ${GOAL_INTERVAL_MIN} to ${GOAL_INTERVAL_MAX} minutes`,
    );
  return now + minutes * 60_000;
}
function publicTask(row: TaskRow): Task {
  // Goal state surfaces through /goal only; the generic task shape is unchanged.
  const {
    deleted: _deleted,
    goalState: _state,
    goalEvidence: _evidence,
    goalAttempts: _attempts,
    goalMaxAttempts: _max,
    ...task
  } = row;
  void [_deleted, _state, _evidence, _attempts, _max];
  return { ...task, enabled: Boolean(row.enabled) };
}
function goalLabel(entry: Pick<GoalEntry, "pr" | "prompt">) {
  if (entry.pr)
    return `${entry.pr.owner}/${entry.pr.repo}#${entry.pr.prNumber}`;
  const flat = entry.prompt.replace(/\s+/g, " ").trim();
  return `"${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}"`;
}
function goalEntryState(entry: GoalEntry) {
  return entry.pr ? entry.pr.state : (entry.goalState ?? "pending");
}

/** Calendar admission only. Pi's Harness owns model execution and durable input replay.
 * See pi-durable/dist/harness/scheduler.js and TaskRuntime.sleepUntil in dist/types.d.ts.
 * No OS cron, shell invocation, or independent model executor is used here.
 */
export class Tasks {
  private tail: Promise<unknown> = Promise.resolve();
  private admitted = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private ticking?: Promise<void>;
  private memoryConsolidation?: {
    key: string;
    timezone: string;
    run: (signal: AbortSignal) => Promise<void>;
    shutdown: AbortController;
  };
  private memoryConsolidationWork?: Promise<void>;
  /** The one read-only GitHub GET of a goal check; replaced in tests. */
  goalFetcher: GoalFetcher = (url, init) => fetch(url, init);
  constructor(
    private runtime: TaskRuntime,
    private clock = () => Date.now(),
  ) {
    runtime.store.db.exec(`
      CREATE TABLE IF NOT EXISTS task_goals (
        taskId TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL,
        prNumber INTEGER NOT NULL, intervalMin INTEGER NOT NULL,
        maxAttempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending', reason TEXT, lastResult TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        conversationId TEXT NOT NULL, kind TEXT NOT NULL, schedule TEXT NOT NULL,
        timezone TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'legacy',
        enabled INTEGER NOT NULL, nextRun INTEGER,
        lastError TEXT, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, scheduledAt INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', requestId TEXT NOT NULL UNIQUE, error TEXT,
        scheduled INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS task_pending ON task_runs(taskId) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversationId);
      CREATE TABLE IF NOT EXISTS task_run_keys(requestId TEXT PRIMARY KEY, runId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_creations(creationKey TEXT PRIMARY KEY, taskId TEXT NOT NULL, input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_delivery_changes(changeKey TEXT PRIMARY KEY,taskId TEXT NOT NULL,delivery TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS archived_task_insert BEFORE INSERT ON tasks
      WHEN EXISTS (SELECT 1 FROM conversation_lifecycle WHERE conversationId=NEW.conversationId AND deletedAt IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'Conversation deleted'); END;
      CREATE TRIGGER IF NOT EXISTS archived_task_enable BEFORE UPDATE OF enabled ON tasks
      WHEN NEW.enabled=1 AND EXISTS (SELECT 1 FROM conversation_lifecycle WHERE conversationId=NEW.conversationId AND deletedAt IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'Conversation deleted'); END;
      -- A pre-goal binary's INSERT omits state and relies on the default
      -- 'pending'; only an explicit 'checking' row can represent a goal
      -- attempt. The trigger persists in this SQLite schema and refuses the
      -- exact pre-goal binary's default-pending INSERT (what the offline base
      -- check measures); it replaces no backup restore, certifies no other
      -- version, mixed use or schema change, and never undoes an admission,
      -- delivery or effect that already happened.
      -- Scoped to PR goals (rows with task_goals metadata): a free-objective
      -- goal is a kind='goal' task whose round is an ordinary 'pending' run.
      DROP TRIGGER IF EXISTS task_goal_run_state;
      CREATE TRIGGER task_goal_run_state BEFORE INSERT ON task_runs
      WHEN NEW.state IS NOT 'checking' AND EXISTS (SELECT 1 FROM task_goals WHERE taskId=NEW.taskId)
      BEGIN SELECT RAISE(ABORT,'A goal check is admitted as checking only.'); END;
    `);
    // Additive, nullable: existing goal rows read as "not rate limited", and
    // the previous code's explicit-column INSERT and SELECT * keep working.
    if (
      !runtime.store
        .all<{ name: string }>("PRAGMA table_info(task_goals)")
        .some((column) => column.name === "rateLimitedAt")
    )
      runtime.store.db.exec(
        "ALTER TABLE task_goals ADD COLUMN rateLimitedAt INTEGER",
      );
    if (
      !runtime.store
        .all<{ name: string }>("PRAGMA table_info(tasks)")
        .some((column) => column.name === "delivery")
    )
      runtime.store.db.exec(
        "ALTER TABLE tasks ADD COLUMN delivery TEXT NOT NULL DEFAULT 'legacy'",
      );
    const hadOrigins = runtime.store
      .all<{ name: string }>("PRAGMA table_info(tasks)")
      .some((c) => c.name === "originSource");
    const destinationColumns: Record<string, string> = {
      destinationChat: "TEXT",
      destinationUser: "TEXT",
      destinationBotId: "TEXT",
      destinationMessageThreadId: "INTEGER",
      destinationReason: "TEXT",
      originSource: "TEXT",
      originConversationId: "TEXT",
      originRequestId: "TEXT",
    };
    for (const table of ["tasks", "task_runs"]) {
      const columns = new Set(
        runtime.store
          .all<{ name: string }>(`PRAGMA table_info(${table})`)
          .map((c) => c.name),
      );
      const additions =
        table === "task_runs"
          ? {
              ...destinationColumns,
              delivery: "TEXT",
              conversationId: "TEXT",
              startedAt: "INTEGER",
              finishedAt: "INTEGER",
              status: "TEXT",
              summary: "TEXT",
              external: "TEXT",
              timeoutNotified: "INTEGER NOT NULL DEFAULT 0",
            }
          : { ...destinationColumns, ...GOAL_COLUMNS };
      for (const [name, type] of Object.entries(additions))
        if (!columns.has(name))
          runtime.store.db.exec(
            `ALTER TABLE ${table} ADD COLUMN ${name} ${type}`,
          );
    }
    if (
      !runtime.store
        .all<{ name: string }>("PRAGMA table_info(task_notifications)")
        .some((c) => c.name === "reason")
    )
      runtime.store.db.exec(
        "ALTER TABLE task_notifications ADD COLUMN reason TEXT",
      );
    // Never derive an admitted legacy occurrence's destination from today's route.
    runtime.store.db.exec(`
      UPDATE task_runs SET conversationId=(SELECT conversationId FROM tasks WHERE id=task_runs.taskId)
        WHERE conversationId IS NULL;
      UPDATE task_runs SET delivery='legacy',destinationReason='Legacy destination was not proven. Select the destination for future runs.'
        WHERE delivery IS NULL;
      UPDATE tasks SET destinationReason='Legacy destination was not proven. Select the destination for future runs.'
        WHERE delivery IN ('legacy','web_telegram') AND destinationChat IS NULL AND destinationReason IS NULL;
    `);
    if (!hadOrigins)
      runtime.store.db.exec(`
      UPDATE tasks SET enabled=0,nextRun=NULL,destinationReason='Legacy destination was not proven. Explicitly select the destination for future runs.',
        lastError='Legacy destination was not proven. Explicitly select the destination for future runs.'
      WHERE delivery='web' AND originSource IS NULL AND destinationReason IS NULL AND NOT EXISTS (
        SELECT 1 FROM task_creations c WHERE c.taskId=tasks.id
        AND CASE WHEN json_valid(c.input) THEN json_extract(c.input,'$.delivery')='web' ELSE 0 END
      );
    `);
    this.installDestinationRevocations();
  }
  private installDestinationRevocations() {
    const invalidate = (condition: string) =>
      ["tasks", "task_runs"]
        .map(
          (table) => `
      UPDATE ${table} SET destinationReason='Telegram link revoked. Select the destination for future runs.'
      ${table === "tasks" ? ",lastError='Telegram link revoked. Select the destination for future runs.'" : ""}
      WHERE destinationChat IS NOT NULL AND destinationReason IS NULL AND (${condition});`,
        )
        .join("\n");
    const grant =
      "destinationChat=OLD.chat AND destinationUser=OLD.user AND conversationId=OLD.conversationId";
    const mapping =
      "destinationChat=OLD.chat AND destinationUser=OLD.user AND conversationId NOT IN (SELECT conversationId FROM telegram_conversations)";
    const config = `CASE WHEN json_valid(NEW.value) THEN
      json_extract(NEW.value,'$.enabled') IS NOT 1
      OR CAST(json_extract(NEW.value,'$.bot.id') AS TEXT) IS NOT destinationBotId
      OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedUsers'),json_array(json_extract(NEW.value,'$.userId')))) WHERE value=destinationUser)
      OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedChats'),json_array(json_extract(NEW.value,'$.chatId')))) WHERE value=destinationChat) ELSE 1 END`;
    this.runtime.store.db.exec(`
      DROP TRIGGER IF EXISTS task_destination_config_update;
      DROP TRIGGER IF EXISTS task_destination_config_insert;
      CREATE TRIGGER IF NOT EXISTS task_destination_grant_delete AFTER DELETE ON telegram_grants BEGIN ${invalidate(grant)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_grant_update AFTER UPDATE ON telegram_grants
        WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user OR OLD.conversationId IS NOT NEW.conversationId
        BEGIN ${invalidate(grant)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_mapping_delete AFTER DELETE ON telegram BEGIN ${invalidate(mapping)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_mapping_update AFTER UPDATE ON telegram
        WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user BEGIN ${invalidate(mapping)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_mapping_insert AFTER INSERT ON telegram BEGIN
        ${invalidate("destinationChat=NEW.chat AND destinationUser IS NOT NEW.user AND conversationId NOT IN (SELECT conversationId FROM telegram_conversations)")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_config_delete AFTER DELETE ON meta WHEN OLD.key='telegram:connection' BEGIN ${invalidate("1")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_config_update AFTER UPDATE OF value ON meta WHEN NEW.key='telegram:connection' BEGIN ${invalidate(config)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_config_insert AFTER INSERT ON meta WHEN NEW.key='telegram:connection' BEGIN ${invalidate(config)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_update AFTER UPDATE ON telegram_topic_conversations
        WHEN OLD.messageThreadId IS NOT NEW.messageThreadId BEGIN ${invalidate("conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_delete AFTER DELETE ON telegram_topic_conversations BEGIN ${invalidate("conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_dedicated_delete AFTER DELETE ON telegram_conversations BEGIN ${invalidate("conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_dedicated_update AFTER UPDATE ON telegram_conversations
        WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user BEGIN ${invalidate("conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_insert AFTER INSERT ON telegram_topic_conversations BEGIN
        ${invalidate("conversationId=NEW.conversationId AND destinationMessageThreadId IS NOT NEW.messageThreadId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_closed_insert AFTER INSERT ON telegram_known_topics WHEN NEW.closed=1 BEGIN
        ${invalidate("destinationChat=NEW.chat AND destinationUser=NEW.user AND destinationMessageThreadId=NEW.messageThreadId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_closed AFTER UPDATE OF closed ON telegram_known_topics WHEN NEW.closed=1 BEGIN
        ${invalidate("destinationChat=NEW.chat AND destinationUser=NEW.user AND destinationMessageThreadId=NEW.messageThreadId")} END;
    `);
  }
  list(): Task[] {
    // Goal rows are not ordinary schedules: they surface only through /goal list
    // and /goal cancel, never through the generic task APIs or /crons.
    return this.runtime.store
      .all<TaskRow>(
        "SELECT * FROM tasks WHERE deleted=0 AND kind!='goal' ORDER BY rowid",
      )
      .map(publicTask);
  }
  get(id: string): Task | undefined {
    // A kind='goal' row is invisible here, so every generic edit/toggle/
    // run-now/remove path (they all resolve through require()) refuses it.
    const row = this.runtime.store.get<TaskRow>(
      "SELECT * FROM tasks WHERE id=? AND deleted=0 AND kind!='goal'",
      id,
    );
    return row ? publicTask(row) : undefined;
  }
  private require(id: string) {
    const task = this.get(id);
    if (!task) throw new TaskError("Task not found");
    return task;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new TaskError("Scheduler is shutting down"));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  create(
    input: unknown,
    creationKey?: string,
    origin?: TaskOrigin,
  ): Promise<Task> {
    return this.serialize(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new TaskError("Invalid task");
      const data = input as Record<string, unknown>;
      const title = text(data.title, "Title", 120).trim();
      const prompt = text(data.prompt, "Prompt", MAX_TEXT);
      const schedule = text(data.schedule, "Schedule", 200).trim();
      if (
        origin &&
        ((origin.source !== "web" &&
          origin.source !== "telegram" &&
          origin.source !== "whatsapp") ||
          !REQUEST_ID.test(origin.requestId) ||
          !origin.conversationId ||
          data.conversationId !== origin.conversationId)
      )
        throw new TaskError("The task origin does not match the conversation");
      const requestedDelivery =
        data.delivery === undefined
          ? undefined
          : this.newDelivery(data.delivery);
      const delivery = this.creationDelivery(requestedDelivery, origin);
      const timezone = text(
        data.timezone === undefined ? "America/Sao_Paulo" : data.timezone,
        "Fuso",
        100,
      );
      try {
        // Intl also accepts fixed offsets; require an IANA name (UTC is valid).
        if (/^[+-]/.test(timezone))
          throw new TaskError("Invalid IANA timezone");
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
      } catch {
        throw new TaskError("Invalid IANA timezone");
      }
      if (data.kind !== "once" && data.kind !== "cron" && data.kind !== "goal")
        throw new TaskError("Invalid task type");
      if (data.enabled !== undefined && typeof data.enabled !== "boolean")
        throw new TaskError("enabled must be a boolean");
      // The receipt and schedule commit together, before a replay-safe tool returns.
      // Resolve a receipt before checking the current time or quota: a once schedule
      // may already be in the past when its interrupted tool is resumed.
      const signatureInput: Record<string, unknown> = {
        title,
        prompt,
        kind: data.kind,
        schedule,
        timezone,
        enabled: data.enabled !== false,
        conversationId: data.conversationId ?? null,
      };
      // Keep the prior signature for interrupted tool replays that omit the
      // newly optional field.
      if (requestedDelivery !== undefined)
        signatureInput.delivery = requestedDelivery;
      if (origin) signatureInput.origin = origin;
      const signature = JSON.stringify(signatureInput);
      if (creationKey !== undefined) {
        if (!REQUEST_ID.test(creationKey))
          throw new TaskError("Invalid creation key");
        const receipt = this.runtime.store.get<{
          taskId: string;
          input: string;
        }>(
          "SELECT taskId,input FROM task_creations WHERE creationKey=?",
          creationKey,
        );
        if (receipt) {
          const priorSignatureInput = { ...signatureInput };
          delete priorSignatureInput.origin;
          const priorSignature = origin
            ? JSON.stringify(priorSignatureInput)
            : undefined;
          // An interrupted pre-origin tool replay returns its existing ambiguous
          // destination. It never repairs provenance or reroutes old work.
          if (receipt.input !== signature && receipt.input !== priorSignature)
            throw new TaskError(
              "Creation key already used with different content",
            );
          return this.created(receipt.taskId);
        }
      }
      const nextRun =
        data.kind === "once"
          ? onceDate(schedule, this.clock())
          : data.kind === "goal"
            ? goalCreationNext(schedule, this.clock())
            : nextCron(schedule, timezone, this.clock());
      if (this.list().length >= 100)
        throw new TaskError("Limit of 100 tasks reached");
      let conversationId: string;
      if (data.conversationId !== undefined) {
        conversationId = text(data.conversationId, "Conversation", 100);
        await this.runtime.conversation(conversationId);
      } else {
        if (delivery === "web_telegram")
          throw new TaskError(
            "Telegram is not connected and authorized for this conversation. Choose a conversation linked to the bot.",
          );
        conversationId = await this.runtime.create(title);
      }
      const destination = this.destination(delivery, conversationId, origin);
      const id = randomUUID();
      if (this.runtime.store.conversationDeleted(conversationId))
        throw new TaskError(
          "Conversation deleted. Restore it before creating a task.",
        );
      this.runtime.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.runtime.store.run(
          "INSERT INTO tasks(id,title,prompt,conversationId,kind,schedule,timezone,delivery,enabled,nextRun,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,originSource,originConversationId,originRequestId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          title,
          prompt,
          conversationId,
          data.kind,
          schedule,
          timezone,
          delivery,
          data.enabled === false ? 0 : 1,
          data.enabled === false ? null : nextRun,
          destination.destinationChat,
          destination.destinationUser,
          destination.destinationBotId,
          destination.destinationMessageThreadId,
          destination.destinationReason,
          origin?.source ?? null,
          origin?.conversationId ?? null,
          origin?.requestId ?? null,
        );
        if (creationKey !== undefined)
          this.runtime.store.run(
            "INSERT INTO task_creations VALUES (?,?,?)",
            creationKey,
            id,
            signature,
          );
        this.runtime.store.db.exec("COMMIT");
      } catch (error) {
        this.runtime.store.db.exec("ROLLBACK");
        throw error;
      }
      return this.created(id);
    });
  }
  /** The row create() just wrote; a goal is returned even though get() hides it. */
  private created(id: string) {
    const row = this.runtime.store.get<TaskRow>(
      "SELECT * FROM tasks WHERE id=? AND deleted=0",
      id,
    );
    if (!row) throw new TaskError("Task not found");
    return publicTask(row);
  }
  setEnabled(id: string, enabled: boolean): Task {
    return this.update(id, { enabled });
  }
  telegramAvailability(conversationId: string) {
    return taskTelegramAvailable(this.runtime.store, conversationId);
  }
  /** Edit schedule content only; channel, origin and captured destination are immutable here. */
  edit(id: string, input: unknown): Task {
    if (this.closing) throw new TaskError("Scheduler is shutting down");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new TaskError("Invalid task update");
    const data = input as Record<string, unknown>;
    if (
      !Object.keys(data).length ||
      Object.keys(data).some(
        (key) => !["title", "prompt", "schedule", "timezone"].includes(key),
      )
    )
      throw new TaskError("Invalid update field");
    const task = this.require(id);
    if (this.runtime.store.conversationDeleted(task.conversationId))
      throw new TaskError(
        "Conversation deleted. Restore it before changing the task.",
      );
    const title = text(data.title ?? task.title, "Title", 120).trim();
    const prompt = text(data.prompt ?? task.prompt, "Prompt", MAX_TEXT);
    if (
      prompt !== task.prompt &&
      this.runtime.store.get(
        "SELECT 1 FROM task_runs WHERE taskId=? AND state='pending'",
        id,
      )
    )
      throw new TaskError(
        "An occurrence is pending. Wait for it to finish before editing the instruction.",
      );
    const schedule = text(
      data.schedule ?? task.schedule,
      "Schedule",
      200,
    ).trim();
    const timezone = text(
      data.timezone ?? task.timezone,
      "Timezone",
      100,
    ).trim();
    try {
      if (/^[+-]/.test(timezone)) throw new Error();
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    } catch {
      throw new TaskError("Invalid IANA timezone");
    }
    const reschedule = schedule !== task.schedule || timezone !== task.timezone;
    let nextRun = task.nextRun;
    if (reschedule) {
      if (
        task.kind === "once" &&
        this.runtime.store.get(
          "SELECT 1 FROM task_runs WHERE taskId=? AND scheduled=1",
          id,
        )
      )
        throw new TaskError("One-time task already ran");
      const next =
        task.kind === "once"
          ? onceDate(schedule, this.clock())
          : nextCron(schedule, timezone, this.clock());
      nextRun = task.enabled ? next : null;
    }
    this.runtime.store.run(
      "UPDATE tasks SET title=?,prompt=?,schedule=?,timezone=?,nextRun=? WHERE id=?",
      title,
      prompt,
      schedule,
      timezone,
      nextRun,
      id,
    );
    return this.require(id);
  }
  update(id: string, input: unknown): Task {
    if (this.closing) throw new TaskError("Scheduler is shutting down");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new TaskError("Invalid task update");
    const data = input as Record<string, unknown>;
    if (data.enabled === undefined && data.delivery === undefined)
      throw new TaskError("Provide a change to the task");
    if (Object.keys(data).some((key) => !["enabled", "delivery"].includes(key)))
      throw new TaskError("Invalid update field");
    const task = this.require(id);
    if (this.runtime.store.conversationDeleted(task.conversationId))
      throw new TaskError(
        "Conversation deleted. Restore it before changing the task.",
      );
    const enabled = data.enabled ?? task.enabled;
    if (typeof enabled !== "boolean")
      throw new TaskError("enabled must be a boolean");
    const delivery =
      data.delivery === undefined
        ? task.delivery
        : this.newDelivery(data.delivery, task.delivery === "legacy");
    if (
      data.delivery !== undefined &&
      delivery === "web_telegram" &&
      task.originSource !== "whatsapp" &&
      !taskTelegramAvailable(this.runtime.store, task.conversationId)
    )
      throw new TaskError(
        "Telegram is not connected and authorized for this conversation. Connect the bot and link the chosen conversation.",
      );
    const destination =
      data.delivery === undefined
        ? task
        : this.destination(
            delivery,
            task.conversationId,
            task.originSource === "whatsapp"
              ? {
                  source: "whatsapp",
                  conversationId: task.conversationId,
                  requestId: task.originRequestId ?? "origin",
                }
              : undefined,
          );
    if (task.enabled === enabled && data.delivery === undefined) return task;
    let nextRun = task.nextRun;
    if (enabled !== task.enabled) {
      nextRun = null;
      if (enabled) {
        if (task.kind === "once") {
          const consumed = this.runtime.store.get(
            "SELECT id FROM task_runs WHERE taskId=? AND scheduled=1",
            id,
          );
          if (consumed) throw new TaskError("One-time task already ran");
          nextRun = Date.parse(task.schedule);
        } else nextRun = nextCron(task.schedule, task.timezone, this.clock());
      }
    }
    this.runtime.store.run(
      "UPDATE tasks SET enabled=?,nextRun=?,delivery=?,destinationChat=?,destinationUser=?,destinationBotId=?,destinationMessageThreadId=?,destinationReason=?,lastError=? WHERE id=?",
      enabled ? 1 : 0,
      nextRun,
      delivery,
      destination.destinationChat,
      destination.destinationUser,
      destination.destinationBotId,
      destination.destinationMessageThreadId,
      destination.destinationReason,
      destination.destinationReason ??
        (data.delivery === undefined ? task.lastError : null),
      id,
    );
    return this.require(id);
  }
  private creationDelivery(
    requested: TaskDelivery | undefined,
    origin?: TaskOrigin,
  ): TaskDelivery {
    // A captured human request keeps the originating chat. Telegram freezes
    // the topic; WhatsApp uses the chat bound to the conversation.
    // Delivery "web" is only a stored value for rows that already exist.
    if (requested === "web" || origin?.source === "web")
      throw new TaskError(
        "The destination is fixed to the original chat/topic.",
      );
    if (origin) {
      if (origin.source !== "telegram" && origin.source !== "whatsapp")
        throw new TaskError("Schedules require a human request in this topic.");
      if (requested && requested !== "web_telegram")
        throw new TaskError(
          "The destination is fixed to the original chat/topic.",
        );
      return "web_telegram";
    }
    // Scheduler calls with no human request keep a local row. They do not
    // invent a Telegram destination. Production tools always pass an origin.
    if (requested === "web_telegram" || requested === "none") return requested;
    if (requested)
      throw new TaskError(
        "The destination is fixed to the original chat/topic.",
      );
    return "web";
  }
  private destination(
    delivery: TaskDelivery,
    conversationId: string,
    origin?: TaskOrigin,
  ) {
    let route: TelegramRoute | undefined;
    if (delivery === "web_telegram") {
      if (origin?.source === "whatsapp") {
        const bound = channelChat(
          this.runtime.store,
          "whatsapp",
          conversationId,
        );
        if (!bound)
          throw new TaskError(
            "This conversation is not linked to a WhatsApp chat.",
          );
        return {
          destinationChat: bound.chatId,
          destinationUser: null,
          destinationBotId: null,
          destinationMessageThreadId: null,
          destinationReason: null,
        };
      }
      const captured =
        origin &&
        this.runtime.store.get<
          TelegramRoute & { state: string; reason: string | null }
        >(
          "SELECT * FROM request_telegram_routes WHERE conversationId=? AND requestId=?",
          origin.conversationId,
          origin.requestId,
        );
      if (
        captured ||
        origin?.source === "telegram" ||
        (origin &&
          this.runtime.store.telegramThread(origin.conversationId) !==
            undefined)
      ) {
        if (
          !captured ||
          captured.state !== "authorized" ||
          !telegramRouteAuthorized(this.runtime.store, captured)
        )
          throw new TaskError(
            "The origin Telegram route is missing or revoked. The task was not created; explicitly select a destination for a new request.",
          );
        route = captured;
      } else
        route = telegramConversationRoute(this.runtime.store, conversationId);
    }
    if (delivery === "web_telegram" && !route)
      throw new TaskError(
        "Telegram is not connected and authorized for this conversation. Select an authorized destination.",
      );
    return {
      destinationChat: route?.chat ?? null,
      destinationUser: route?.user ?? null,
      destinationBotId: route?.botId ?? null,
      destinationMessageThreadId: route?.messageThreadId ?? null,
      destinationReason:
        delivery === "legacy"
          ? "Legacy destination was not proven. Select the destination for future runs."
          : null,
    };
  }
  private newDelivery(value: unknown, allowLegacy = false): TaskDelivery {
    if (
      value === "none" ||
      value === "web" ||
      value === "web_telegram" ||
      (allowLegacy && value === "legacy")
    )
      return value;
    throw new TaskError(
      "Invalid destination: use origin (original topic) or none (no delivery)",
    );
  }
  remove(id: string) {
    if (this.closing) throw new TaskError("Scheduler is shutting down");
    this.require(id);
    // Preserve admitted occurrences and their conversations, even across a restart.
    this.runtime.store.run(
      "UPDATE tasks SET deleted=1,enabled=0,nextRun=NULL WHERE id=?",
      id,
    );
  }
  runs(
    id: string,
    filter: { since?: number; until?: number; limit?: number } = {},
  ): TaskRun[] {
    const conditions = ["taskId=?"];
    const values: number[] = [];
    if (filter.since !== undefined) {
      conditions.push("scheduledAt>=?");
      values.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push("scheduledAt<=?");
      values.push(filter.until);
    }
    return this.runtime.store.all<TaskRun>(
      `${RUN_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
      id,
      ...values,
      Math.min(Math.max(Math.trunc(filter.limit ?? 20), 1), 50),
    );
  }
  /** Settle one admitted occurrence with its outcome. Called when the request settles. */
  finishRun(
    conversationId: string,
    requestId: string,
    outcome: {
      status: "ok" | "erro" | "silencioso";
      summary: string;
      /** Why it failed, as pi-durable reported it; null keeps any existing value. */
      error?: string | null;
      external: string | null;
    },
  ) {
    const state = outcome.status === "erro" ? "failed" : "done";
    this.runtime.store.run(
      "UPDATE task_runs SET finishedAt=?,state=?,status=?,summary=?,error=COALESCE(?,error),external=? WHERE requestId=? AND COALESCE(conversationId,(SELECT conversationId FROM tasks WHERE id=task_runs.taskId))=?",
      this.clock(),
      state,
      outcome.status,
      truncateTaskSummary(outcome.summary, 1000),
      outcome.error ?? null,
      outcome.external,
      requestId,
      conversationId,
    );
    for (const row of this.runtime.store.all<{ id: string }>(
      "SELECT id FROM task_runs WHERE requestId=? AND COALESCE(conversationId,(SELECT conversationId FROM tasks WHERE id=task_runs.taskId))=?",
      requestId,
      conversationId,
    )) {
      this.admitted.delete(row.id);
      this.settleGoalRound(row.id);
    }
  }
  private sweptAt = 0;
  private watchedAt = 0;
  private runTimeoutMs() {
    const minutes = Number(process.env.TASK_RUN_TIMEOUT_MIN);
    return (
      (Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_RUN_TIMEOUT_MIN) * 60_000
    );
  }
  private sweepRuns() {
    const now = this.clock();
    if (now - this.sweptAt < RUN_SWEEP_MS) return;
    this.sweptAt = now;
    const store = this.runtime.store;
    store.run(
      "DELETE FROM task_runs WHERE state!='pending' AND scheduledAt<?",
      now - RUN_RETENTION_MS,
    );
    store.run(
      "DELETE FROM task_run_keys WHERE runId NOT IN (SELECT id FROM task_runs)",
    );
  }
  /** Closes runs that started but never settled; alerts the destination once. */
  private watchStaleRuns() {
    const now = this.clock();
    if (now - this.watchedAt < RUN_WATCH_MS) return;
    this.watchedAt = now;
    const store = this.runtime.store;
    const timeout = this.runTimeoutMs();
    for (const run of store.all<PendingRun & { timeoutNotified: number }>(
      `SELECT r.*,t.prompt,t.kind AS taskKind FROM task_runs r JOIN tasks t ON t.id=r.taskId
       WHERE r.state='pending' AND r.startedAt IS NOT NULL AND r.finishedAt IS NULL
         AND NOT ${PR_GOAL("t")} AND r.startedAt<?`,
      now - timeout,
    )) {
      const summary = `Run expired after ${Math.round(timeout / 60_000)} minutes without finishing.`;
      store.run(
        "UPDATE task_runs SET state='failed',finishedAt=?,status='erro',summary=?,error=COALESCE(error,?) WHERE id=?",
        now,
        summary.slice(0, 400),
        summary,
        run.id,
      );
      store.run(
        "UPDATE requests SET status='stale' WHERE conversationId=? AND requestId=? AND status='pending'",
        run.conversationId,
        run.requestId,
      );
      store.run("UPDATE tasks SET lastError=? WHERE id=?", summary, run.taskId);
      this.admitted.delete(run.id);
      // A goal stays silent until it is reached or blocked; /goal list shows the error.
      if (run.taskKind === "goal") {
        this.settleGoalRound(run.id);
        continue;
      }
      if (!run.timeoutNotified) {
        store.run("UPDATE task_runs SET timeoutNotified=1 WHERE id=?", run.id);
        queueTaskTelegram(
          store,
          run.conversationId,
          run.requestId,
          `The scheduled task did not finish in time (${summary}). See /crons or the web panel.`,
        );
      }
    }
  }
  /** True while a run of this conversation is executing: a run must not start another.
   * A PR goal read is not a model turn, so it never counts as in-flight here;
   * a free-objective goal round is one, so it does. */
  inFlight(conversationId: string) {
    return !!this.runtime.store.get(
      `SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.taskId
       WHERE r.conversationId=? AND r.state='pending' AND r.startedAt IS NOT NULL
         AND NOT ${PR_GOAL("t")}`,
      conversationId,
    );
  }
  runNow(id: string, requestId?: string): Promise<TaskRun> {
    return this.serialize(async () => {
      const task = this.require(id);
      await this.runtime.conversation(task.conversationId);
      if (
        requestId !== undefined &&
        (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
      )
        throw new TaskError("Invalid run requestId");
      // Bound the final Pi input key to 160 characters even for long client keys.
      const manualRequestId =
        requestId === undefined
          ? undefined
          : `task-manual:${id}:${createHash("sha256").update(requestId).digest("hex")}`;
      this.refresh();
      const run = this.claim(id, this.clock(), false, manualRequestId)!;
      await this.dispatch();
      return this.runtime.store.get<TaskRun>(
        `${RUN_SELECT} WHERE id=?`,
        run.id,
      )!;
    });
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.serialize(async () => {
      this.refresh();
      // Authentication changes delay admission; do not consume an occurrence.
      if (this.runtime.store.credentialMutation) return;
      const now = this.clock();
      this.admitMemoryConsolidation(now);
      // An explicit end time ends its goal before any due check runs, with
      // the same terminal path and single notification as an exhausted cap.
      if (this.runtime.options?.phoneGateway !== "whatsapp")
        this.expireGoals(now);
      // PR goals stay disabled at rest and are read by goalPass below.
      const store = this.runtime.store;
      let goalRounds = 0;
      for (const task of store.all<TaskRow>(
        `SELECT * FROM tasks t WHERE deleted=0 AND enabled=1 AND kind IN ('once','cron','goal') AND nextRun<=?
           AND NOT ${PR_GOAL("t")} AND COALESCE(goalState,'pending')='pending'
           AND conversationId NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY nextRun`,
        now,
      )) {
        if (task.kind === "goal") {
          // Goals are Telegram-only, and one model round per tick: a list of
          // due goals never fans out into N rounds at once. The rest stays due.
          if (
            this.runtime.options?.phoneGateway === "whatsapp" ||
            goalRounds >= GOAL_ROUNDS_PER_TICK ||
            store.get(
              "SELECT 1 FROM task_runs WHERE taskId=? AND state='pending'",
              task.id,
            )
          )
            continue;
          if (this.claim(task.id, now, true)) goalRounds += 1;
          continue;
        }
        this.claim(task.id, now, true);
      }
      await this.dispatch();
      await this.runtime.durableTasks?.tick();
      await this.goalPass();
      this.watchStaleRuns();
      this.sweepRuns();
      this.refresh();
    }).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  scheduleMemoryConsolidation(
    timezone: string,
    run: (signal: AbortSignal) => Promise<void>,
  ) {
    try {
      timezone = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
      }).resolvedOptions().timeZone;
    } catch {
      timezone = "UTC";
    }
    const key = `memory:consolidation:next:${timezone}`;
    const now = this.clock();
    const minuteStart = Math.floor(now / 60_000) * 60_000;
    this.runtime.store.run(
      `INSERT INTO meta(key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value
       WHERE CAST(meta.value AS INTEGER) < ?`,
      key,
      String(nextCron(MEMORY_CONSOLIDATION_CRON, timezone, minuteStart - 1)),
      minuteStart,
    );
    this.memoryConsolidation = {
      key,
      timezone,
      run,
      shutdown: new AbortController(),
    };
  }

  private admitMemoryConsolidation(now: number) {
    const schedule = this.memoryConsolidation;
    if (!schedule || this.closing || this.memoryConsolidationWork) return;
    const store = this.runtime.store;
    const due = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=? AND CAST(value AS INTEGER)<=?",
      schedule.key,
      now,
    );
    if (!due) return;
    const next = nextCron(MEMORY_CONSOLIDATION_CRON, schedule.timezone, now);
    const claim = store.run(
      "UPDATE meta SET value=? WHERE key=? AND value=?",
      String(next),
      schedule.key,
      due.value,
    );
    if (!claim.changes) return;
    this.memoryConsolidationWork = Promise.resolve()
      .then(() => schedule.run(schedule.shutdown.signal))
      .catch((error: unknown) =>
        logFailure("Memory consolidation failed", error),
      )
      .finally(() => {
        this.memoryConsolidationWork = undefined;
      });
  }

  private claim(
    id: string,
    now: number,
    scheduled: boolean,
    manualRequestId?: string,
  ): TaskRun | undefined {
    const store = this.runtime.store;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const task = store.get<TaskRow>(
        "SELECT * FROM tasks WHERE id=? AND deleted=0",
        id,
      );
      if (task && store.conversationDeleted(task.conversationId))
        throw new TaskError("Conversation deleted");
      const pending = store.get<TaskRun>(
        "SELECT * FROM task_runs WHERE taskId=? AND state='pending'",
        id,
      );
      const existing = manualRequestId
        ? store.get<TaskRun>(
            "SELECT r.* FROM task_runs r JOIN task_run_keys k ON k.runId=r.id WHERE k.requestId=?",
            manualRequestId,
          )
        : undefined;
      if (existing) {
        store.db.exec("COMMIT");
        return existing;
      }
      if (
        !task ||
        (scheduled &&
          (!task.enabled || task.nextRun === null || task.nextRun > now))
      ) {
        store.db.exec("COMMIT");
        return undefined;
      }
      if (task.kind === "goal") {
        if (store.get("SELECT 1 FROM task_goals WHERE taskId=?", id))
          throw new TaskError("A PR goal is checked by its own observer.");
        const state = task.goalState ?? "pending";
        if (state !== "pending") {
          if (!scheduled)
            throw new TaskError(`That goal already ended: ${state}.`);
          store.db.exec("COMMIT");
          return undefined;
        }
        // A crash after the last round but before its settlement: block now
        // instead of spending one more round.
        if (
          scheduled &&
          task.goalAttempts >= (task.goalMaxAttempts ?? GOAL_ATTEMPTS_MAX)
        ) {
          this.blockGoal(task);
          store.db.exec("COMMIT");
          return undefined;
        }
      }
      if (pending) {
        // A manual trigger never joins someone else's execution: if this schedule is
        // already running, refuse. The catch below rolls back, so no ROLLBACK here.
        if (!scheduled)
          throw new TaskError("A run of this schedule is already in progress.");
        store.db.exec("COMMIT");
        return pending;
      }
      const run: TaskRun = {
        id: randomUUID(),
        trigger: scheduled ? "scheduled" : "manual",
        scheduledAt: scheduled ? task.nextRun! : now,
        state: "pending",
        requestId: "",
        error: null,
        startedAt: null,
        finishedAt: null,
        status: null,
        summary: null,
        external: null,
        conversationId: task.conversationId,
        delivery: task.delivery,
        originSource: task.originSource,
        originConversationId: task.originConversationId,
        originRequestId: task.originRequestId,
        destinationChat: task.destinationChat,
        destinationUser: task.destinationUser,
        destinationBotId: task.destinationBotId,
        destinationMessageThreadId: task.destinationMessageThreadId,
        destinationReason: task.destinationReason,
      };
      run.requestId = manualRequestId ?? `task:${run.id}`;
      store.run(
        "INSERT INTO task_runs(id,taskId,scheduledAt,requestId,scheduled,conversationId,delivery,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,originSource,originConversationId,originRequestId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        run.id,
        id,
        run.scheduledAt,
        run.requestId,
        scheduled ? 1 : 0,
        task.conversationId,
        task.delivery,
        task.destinationChat,
        task.destinationUser,
        task.destinationBotId,
        task.destinationMessageThreadId,
        task.destinationReason,
        task.originSource,
        task.originConversationId,
        task.originRequestId,
      );
      if (manualRequestId)
        store.run(
          "INSERT INTO task_run_keys VALUES (?,?)",
          manualRequestId,
          run.id,
        );
      if (scheduled) {
        // After downtime execute ONE overdue occurrence; skip the backlog by advancing from now.
        // A goal reschedules like a cron and spends one attempt per scheduled round.
        const nextRun =
          task.kind === "cron"
            ? nextCron(task.schedule, task.timezone, now)
            : task.kind === "goal"
              ? nextGoal(task.schedule, task.timezone, now)
              : null;
        store.run(
          "UPDATE tasks SET nextRun=?,enabled=?,lastError=destinationReason,goalAttempts=goalAttempts+? WHERE id=?",
          nextRun,
          task.kind === "once" ? 0 : 1,
          task.kind === "goal" ? 1 : 0,
          id,
        );
      }
      store.db.exec("COMMIT");
      return run;
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }
  private refresh() {
    const store = this.runtime.store;
    for (const run of store.all<PendingRun>(
      "SELECT r.*,t.prompt FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE r.state='pending'",
    )) {
      const request = store.get<{ status: string }>(
        "SELECT status FROM requests WHERE conversationId=? AND requestId=?",
        run.conversationId,
        run.requestId,
      );
      if (!request || request.status === "pending") continue;
      if (run.finishedAt !== null) {
        this.admitted.delete(run.id);
        continue;
      }
      // A successful turn is settled by monitorSubmission (summary, delivery, status).
      if (request.status === "done") {
        store.run(
          "UPDATE task_runs SET state='done',finishedAt=?,status=COALESCE(status,'silencioso'),summary=COALESCE(summary,'') WHERE id=?",
          Date.now(),
          run.id,
        );
        this.admitted.delete(run.id);
        this.settleGoalRound(run.id);
        continue;
      }
      const error = `Request ended with status: ${request.status}`;
      store.run(
        "UPDATE task_runs SET state='failed',error=COALESCE(error,?),finishedAt=?,status=COALESCE(status,'erro'),summary=COALESCE(summary,?) WHERE id=?",
        error,
        Date.now(),
        `The task did not finish: ${error}`,
        run.id,
      );
      store.run(
        "UPDATE tasks SET lastError=COALESCE(?,destinationReason) WHERE id=?",
        error,
        run.taskId,
      );
      this.admitted.delete(run.id);
      this.settleGoalRound(run.id);
    }
  }
  private async dispatch() {
    const store = this.runtime.store;
    for (const run of store.all<PendingRun>(
      `SELECT r.*,t.prompt,t.kind AS taskKind FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE r.state='pending' AND NOT ${PR_GOAL("t")} ORDER BY r.rowid`,
    )) {
      if (this.admitted.has(run.id)) continue;
      if (
        this.inFlight(run.conversationId) &&
        !store.get(
          "SELECT 1 FROM task_runs WHERE id=? AND startedAt IS NOT NULL",
          run.id,
        )
      )
        continue;
      // A login may start between two awaited admissions. Keep unsent runs
      // pending with the same requestId so a later tick can admit them once.
      if (store.credentialMutation) return;
      try {
        // Replayed after a crash with the SAME requestId; Runtime/Pi deduplicate admission.
        await this.runtime.submit(
          run.conversationId,
          run.requestId,
          run.prompt,
          "task",
          null,
        );
        this.admitted.add(run.id);
        store.run(
          "UPDATE task_runs SET startedAt=? WHERE id=? AND startedAt IS NULL",
          this.clock(),
          run.id,
        );
      } catch (cause) {
        // Model settings and archive reservations can temporarily block the
        // conversation before admission. Retry this unsent run on the next tick.
        if (cause instanceof ConversationBusyError) continue;
        const error = cause instanceof Error ? cause.message : String(cause);
        store.run(
          "UPDATE tasks SET lastError=COALESCE(?,destinationReason) WHERE id=?",
          error,
          run.taskId,
        );
        const request = store.get(
          "SELECT requestId FROM requests WHERE conversationId=? AND requestId=?",
          run.conversationId,
          run.requestId,
        );
        // A committed input may still execute. Preserve it for idempotent recovery.
        if (!request) {
          store.savepoint("task_admission_failure", () => {
            // A goal stays silent until reached or blocked; /goal list shows the error.
            if (run.taskKind !== "goal")
              queueTaskTelegram(
                store,
                run.conversationId,
                run.requestId,
                "The task could not start. Check your connection and the task state in /crons on Telegram or the origin channel's web panel.",
              );
            store.run(
              "UPDATE task_runs SET state='failed',error=? WHERE id=?",
              error,
              run.id,
            );
            this.settleGoalRound(run.id);
          });
        }
      }
    }
  }
  // ---- Persistent goals -------------------------------------------------
  // A goal is a kind='goal' task row plus task_goals metadata. It rides the
  // ordinary tick above: no second scheduler, no Runtime.submit for its runs,
  // and the generic task APIs cannot see or mutate it (see get()/list()).
  // /goal list and /goal cancel are its scoped controls.

  /** Both goal kinds of one chat, numbered as /goal list shows them. */
  private goalsOf(conversationId: string): GoalEntry[] {
    return this.runtime.store
      .all<
        Omit<GoalEntry, "pr"> &
          Partial<Omit<GoalRow, "taskId">> & { prTaskId: string | null }
      >(
        `SELECT t.id AS taskId,t.conversationId,t.title,t.prompt,t.enabled,t.nextRun,t.lastError,
           t.goalState,t.goalEvidence,t.goalAttempts,t.goalMaxAttempts,t.goalEndAt,
           g.taskId AS prTaskId,g.owner,g.repo,g.prNumber,g.intervalMin,g.maxAttempts,g.attempts,
           g.state,g.reason,g.lastResult,g.rateLimitedAt
         FROM tasks t LEFT JOIN task_goals g ON g.taskId=t.id
         WHERE t.conversationId=? AND t.deleted=0 AND (g.taskId IS NOT NULL OR t.kind='goal')
         ORDER BY t.rowid`,
        conversationId,
      )
      .map((row) => ({
        taskId: row.taskId,
        conversationId: row.conversationId,
        title: row.title,
        prompt: row.prompt,
        enabled: row.enabled,
        nextRun: row.nextRun,
        lastError: row.lastError,
        goalState: row.goalState,
        goalEvidence: row.goalEvidence,
        goalAttempts: row.goalAttempts,
        goalMaxAttempts: row.goalMaxAttempts,
        goalEndAt: row.goalEndAt,
        pr: row.prTaskId
          ? {
              taskId: row.prTaskId,
              owner: row.owner!,
              repo: row.repo!,
              prNumber: row.prNumber!,
              intervalMin: row.intervalMin!,
              maxAttempts: row.maxAttempts!,
              attempts: row.attempts!,
              state: row.state!,
              reason: row.reason ?? null,
              lastResult: row.lastResult ?? null,
              rateLimitedAt: row.rateLimitedAt ?? null,
            }
          : null,
      }));
  }

  private goalAt(conversationId: string, index: number) {
    if (!Number.isInteger(index) || index < 1)
      throw new TaskError("Invalid goal number. Use /goal list.");
    const goal = this.goalsOf(conversationId)[index - 1];
    if (!goal) throw new TaskError("Invalid goal number. Use /goal list.");
    return goal;
  }

  goalList(conversationId: string) {
    const goals = this.goalsOf(conversationId);
    if (!goals.length)
      return "No goals in this chat. Use /goal <what to watch for> a cada <N> horas, or /goal pr owner/repo#123 <minutes> <max checks>.";
    return goals
      .map((goal, index) => {
        const state = goalEntryState(goal);
        const [attempts, max] = goal.pr
          ? [goal.pr.attempts, goal.pr.maxAttempts]
          : [goal.goalAttempts, goal.goalMaxAttempts ?? GOAL_ATTEMPTS_MAX];
        const next =
          state === "pending" && goal.nextRun
            ? `next check ${new Date(goal.nextRun).toISOString()}`
            : goal.pr
              ? (goal.pr.reason ?? goal.pr.lastResult ?? state)
              : state === "met"
                ? `reached: ${truncateTaskSummary(goal.goalEvidence ?? "", 200)}`
                : (goal.lastError ?? state);
        // An explicit limit shows what is left; the default cap stays silent.
        const left: string[] = [];
        if (!goal.pr && goal.goalMaxAttempts !== null)
          left.push(
            `${Math.max(goal.goalMaxAttempts - goal.goalAttempts, 0)} checks left`,
          );
        if (!goal.pr && goal.goalEndAt !== null) {
          const remaining = goal.goalEndAt - this.clock();
          left.push(
            `ends ${formatGoalEnd(goal.goalEndAt)}, ${
              remaining < 86_400_000
                ? `${Math.max(Math.ceil(remaining / 3_600_000), 0)} hours`
                : `${Math.ceil(remaining / 86_400_000)} days`
            } left`,
          );
        }
        const limitText = left.length ? ` — ${left.join(", ")}` : "";
        return `${index + 1}. [${goal.pr ? "pr" : "goal"}] ${goalLabel(goal)} — ${state} — attempt ${attempts}/${max}${limitText} — ${next}`;
      })
      .join("\n");
  }

  cancelGoal(conversationId: string, index: number) {
    const goal = this.goalAt(conversationId, index);
    const state = goalEntryState(goal);
    if (state !== "pending")
      throw new TaskError(`That goal already ended: ${state}.`);
    // The due-goal selections require a pending state, so this stops all
    // future checks and even mid-flight results get discarded.
    this.runtime.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (goal.pr)
        this.runtime.store.run(
          "UPDATE task_goals SET state='cancelled' WHERE taskId=? AND state='pending'",
          goal.taskId,
        );
      else
        this.runtime.store.run(
          "UPDATE tasks SET goalState='cancelled' WHERE id=? AND COALESCE(goalState,'pending')='pending'",
          goal.taskId,
        );
      this.runtime.store.run(
        "UPDATE tasks SET enabled=0,nextRun=NULL WHERE id=?",
        goal.taskId,
      );
      this.runtime.store.db.exec("COMMIT");
    } catch (error) {
      this.runtime.store.db.exec("ROLLBACK");
      throw error;
    }
    return `Goal cancelled: ${goalLabel(goal)}. No further checks or messages.`;
  }

  /** `/goal check N`: one immediate read outside the schedule. It never
   * reserves an attempt, moves nextRun or creates a run; only a merged or
   * not-found answer settles the goal, exactly as a scheduled read would. */
  checkGoalNow(
    conversationId: string,
    index: number,
    authorize: () => void,
  ): Promise<string> {
    return this.serialize(async () => {
      authorize();
      const entry = this.goalAt(conversationId, index);
      const label = goalLabel(entry);
      const entryState = goalEntryState(entry);
      if (entryState !== "pending")
        throw new TaskError(
          `Goal ${index} (${label}) is finished: ${entryState}. There is nothing to check.`,
        );
      if (!entry.pr) {
        // The same model round a scheduled check runs, admitted now as a
        // manual run: no attempt is spent and nextRun does not move.
        await this.runtime.conversation(conversationId);
        authorize();
        this.refresh();
        this.claim(entry.taskId, this.clock(), false);
        await this.dispatch();
        authorize();
        return `Goal ${index}: checking ${label} now. Not counted as an attempt. You will hear from it only if the condition happened.`;
      }
      const goal = entry.pr;
      const observation = await observePrMerged(
        { owner: goal.owner, repo: goal.repo, prNumber: goal.prNumber },
        this.goalFetcher,
      );
      authorize();
      const head = `Goal ${index}:`;
      const uncounted = "Not counted as an attempt.";
      if (observation.kind === "merged" || observation.kind === "not_found") {
        const [state, reason] =
          observation.kind === "merged"
            ? (["completed", GOAL_MERGED_REASON] as const)
            : (["blocked", GOAL_NOT_FOUND_REASON] as const);
        const store = this.runtime.store;
        store.db.exec("BEGIN IMMEDIATE");
        let settled: boolean;
        try {
          // A cancel or archive that landed during the read wins.
          settled =
            store.run(
              "UPDATE task_goals SET state=?,reason=? WHERE taskId=? AND state='pending'",
              state,
              reason,
              goal.taskId,
            ).changes > 0;
          if (settled)
            store.run(
              "UPDATE tasks SET enabled=0,nextRun=NULL,lastError=? WHERE id=?",
              reason,
              goal.taskId,
            );
          store.db.exec("COMMIT");
        } catch (error) {
          store.db.exec("ROLLBACK");
          throw error;
        }
        if (!settled)
          return `${head} ${label} ended while it was being checked. Use /goal list.`;
        return observation.kind === "merged"
          ? `${head} ${label} was merged. Goal reached and closed.`
          : `${head} ${label} — ${GOAL_NOT_FOUND_REASON} Goal blocked.`;
      }
      if (observation.kind === "open")
        return `${head} ${label} is still open. ${uncounted}`;
      if (observation.kind === "closed_unmerged")
        return `${head} ${label} was closed without being merged. ${uncounted} The goal stays pending until its next scheduled check.`;
      if (observation.kind === "rate_limited")
        return `${head} GitHub rate limited the check of ${label}. ${uncounted} Try again later.`;
      return `${head} no definite answer for ${label} (${observation.reason}). ${uncounted}`;
    });
  }

  /** Creating a goal authorizes one read-only observer, never a model turn. */
  createGoal(
    conversationId: string,
    origin: TaskOrigin,
    target: GoalTarget,
    intervalMin: number,
    maxAttempts: number,
  ): Promise<void> {
    return this.serialize(async () => {
      if (
        origin.source !== "telegram" ||
        origin.conversationId !== conversationId ||
        !REQUEST_ID.test(origin.requestId)
      )
        throw new TaskError("The goal origin does not match this conversation");
      // Durable receipt, same table as ordinary tasks: an update replayed after
      // the commit but before Telegram's own update receipt confirms the same
      // goal instead of creating a second one. A distinct update has a distinct
      // key and is never suppressed.
      const creationKey = `goal:${conversationId}:${origin.requestId}`;
      const signature = JSON.stringify({
        conversationId,
        owner: target.owner,
        repo: target.repo,
        prNumber: target.prNumber,
        intervalMin,
        maxAttempts,
      });
      const receipt = this.runtime.store.get<{
        taskId: string;
        input: string;
      }>(
        "SELECT taskId,input FROM task_creations WHERE creationKey=?",
        creationKey,
      );
      if (receipt) {
        if (receipt.input !== signature)
          throw new TaskError(
            "A goal for this message was already saved with different content.",
          );
        return;
      }
      if (
        !Number.isInteger(intervalMin) ||
        intervalMin < GOAL_INTERVAL_MIN ||
        intervalMin > GOAL_INTERVAL_MAX ||
        !Number.isInteger(maxAttempts) ||
        maxAttempts < 1 ||
        maxAttempts > GOAL_ATTEMPTS_MAX
      )
        throw new TaskError("Invalid goal cadence or check limit");
      await this.runtime.conversation(conversationId);
      if (this.runtime.store.conversationDeleted(conversationId))
        throw new TaskError(
          "Conversation deleted. Restore it before creating a goal.",
        );
      // After the receipt check: a replay of THIS message still confirms.
      const goals = this.goalsOf(conversationId);
      const duplicate = goals.findIndex(
        ({ pr }) =>
          pr?.state === "pending" &&
          pr.owner === target.owner &&
          pr.repo === target.repo &&
          pr.prNumber === target.prNumber,
      );
      if (duplicate >= 0)
        throw new TaskError(
          `Goal ${duplicate + 1} already watches ${target.owner}/${target.repo}#${target.prNumber} in this chat. Use /goal cancel ${duplicate + 1} first to replace it.`,
        );
      if (goals.length >= GOAL_LIST_LIMIT)
        throw new TaskError(
          `Limit of ${GOAL_LIST_LIMIT} goals per chat reached.`,
        );
      // destination() freezes the chat/user/bot/topic captured for THIS
      // request and refuses revoked routes.
      const destination = this.destination("web_telegram", conversationId, {
        ...origin,
        source: "telegram",
      });
      const id = randomUUID();
      this.runtime.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.runtime.store.run(
          "INSERT INTO tasks(id,title,prompt,conversationId,kind,schedule,timezone,delivery,enabled,nextRun,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,originSource,originConversationId,originRequestId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          `GitHub PR ${target.owner}/${target.repo}#${target.prNumber} merged`,
          `Persistent goal: notify this chat when ${target.owner}/${target.repo}#${target.prNumber} is merged.`,
          conversationId,
          "goal",
          `every-${intervalMin}m`,
          "UTC",
          "web_telegram",
          // Disabled at rest: a pre-goal binary never claims a goal row. The
          // goal scheduler owns due-ness through nextRun while it stays disabled.
          0,
          this.clock(),
          destination.destinationChat,
          destination.destinationUser,
          destination.destinationBotId,
          destination.destinationMessageThreadId,
          destination.destinationReason,
          origin.source,
          origin.conversationId,
          origin.requestId,
        );
        this.runtime.store.run(
          "INSERT INTO task_goals(taskId,owner,repo,prNumber,intervalMin,maxAttempts) VALUES (?,?,?,?,?,?)",
          id,
          target.owner,
          target.repo,
          target.prNumber,
          intervalMin,
          maxAttempts,
        );
        this.runtime.store.run(
          "INSERT INTO task_creations VALUES (?,?,?)",
          creationKey,
          id,
          signature,
        );
        this.runtime.store.db.exec("COMMIT");
      } catch (error) {
        this.runtime.store.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** A free objective becomes a kind='goal' task: the objective is its prompt,
   * and the ordinary tick runs it as a model round until goal_reached. An
   * explicit end time (epoch ms, null when none) ends the goal as expired. */
  createObjectiveGoal(
    conversationId: string,
    origin: TaskOrigin,
    objective: string,
    intervalMin: number,
    maxAttempts: number,
    endAt: number | null,
  ): Promise<void> {
    return this.serialize(async () => {
      if (
        origin.source !== "telegram" ||
        origin.conversationId !== conversationId ||
        !REQUEST_ID.test(origin.requestId)
      )
        throw new TaskError("The goal origin does not match this conversation");
      // Same durable receipt as a PR goal: a replayed update confirms, never duplicates.
      const creationKey = `goal:${conversationId}:${origin.requestId}`;
      // endAt is omitted when null, so a pre-end-time replay receipt keeps
      // its signature.
      const signatureInput: Record<string, unknown> = {
        conversationId,
        objective,
        intervalMin,
        maxAttempts,
      };
      if (endAt !== null) signatureInput.endAt = endAt;
      const signature = JSON.stringify(signatureInput);
      const receipt = this.runtime.store.get<{ input: string }>(
        "SELECT input FROM task_creations WHERE creationKey=?",
        creationKey,
      );
      if (receipt) {
        if (receipt.input !== signature)
          throw new TaskError(
            "A goal for this message was already saved with different content.",
          );
        return;
      }
      const prompt = text(objective, "Objective", MAX_TEXT).trim();
      if (
        !Number.isInteger(intervalMin) ||
        intervalMin < GOAL_INTERVAL_MIN ||
        intervalMin > GOAL_INTERVAL_MAX ||
        !Number.isInteger(maxAttempts) ||
        maxAttempts < 1 ||
        maxAttempts > GOAL_ATTEMPTS_MAX
      )
        throw new TaskError("Invalid goal cadence or check limit");
      if (endAt !== null && (!Number.isInteger(endAt) || endAt <= 0))
        throw new TaskError("Invalid goal end time");
      await this.runtime.conversation(conversationId);
      if (this.runtime.store.conversationDeleted(conversationId))
        throw new TaskError(
          "Conversation deleted. Restore it before creating a goal.",
        );
      const goals = this.goalsOf(conversationId);
      const duplicate = goals.findIndex(
        (goal) =>
          !goal.pr &&
          goalEntryState(goal) === "pending" &&
          goal.prompt === prompt,
      );
      if (duplicate >= 0)
        throw new TaskError(
          `Goal ${duplicate + 1} already watches this in this chat. Use /goal cancel ${duplicate + 1} first to replace it.`,
        );
      if (goals.length >= GOAL_LIST_LIMIT)
        throw new TaskError(
          `Limit of ${GOAL_LIST_LIMIT} goals per chat reached.`,
        );
      const destination = this.destination("web_telegram", conversationId, {
        ...origin,
        source: "telegram",
      });
      const flat = prompt.replace(/\s+/g, " ");
      const title = `Goal: ${flat.length > 110 ? `${flat.slice(0, 109)}…` : flat}`;
      const id = randomUUID();
      this.runtime.store.db.exec("BEGIN IMMEDIATE");
      try {
        // Enabled with nextRun now: the next tick runs the first check.
        this.runtime.store.run(
          "INSERT INTO tasks(id,title,prompt,conversationId,kind,schedule,timezone,delivery,enabled,nextRun,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,originSource,originConversationId,originRequestId,goalMaxAttempts,goalEndAt) VALUES (?,?,?,?,'goal',?,'UTC','web_telegram',1,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          title,
          prompt,
          conversationId,
          `every-${intervalMin}m`,
          this.clock(),
          destination.destinationChat,
          destination.destinationUser,
          destination.destinationBotId,
          destination.destinationMessageThreadId,
          destination.destinationReason,
          origin.source,
          origin.conversationId,
          origin.requestId,
          // The default cap is stored as NULL: only an explicit limit shows in /goal list.
          maxAttempts === GOAL_ATTEMPTS_MAX ? null : maxAttempts,
          endAt,
        );
        this.runtime.store.run(
          "INSERT INTO task_creations VALUES (?,?,?)",
          creationKey,
          id,
          signature,
        );
        this.runtime.store.db.exec("COMMIT");
      } catch (error) {
        this.runtime.store.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** The free-objective goal this run checks, or undefined for any other run. */
  goalRunTask(conversationId: string, requestId: string) {
    return this.runtime.store.get<{
      taskId: string;
      runId: string;
      state: string;
      prompt: string;
      goalState: string | null;
    }>(
      `SELECT r.taskId,r.id AS runId,r.state,t.prompt,t.goalState FROM task_runs r JOIN tasks t ON t.id=r.taskId
       WHERE r.requestId=? AND r.conversationId=? AND ${OBJECTIVE_GOAL("t")}`,
      requestId,
      conversationId,
    );
  }

  /** `goal_reached`: the one way a goal round ends its goal. It records the
   * evidence and stops the schedule. `deliver` runs inside the same
   * transaction, only on the call that records the goal, and releases the
   * round's held messages (or the standard one it is given); a repeated call
   * delivers nothing. Its note, if any, is appended to the result. */
  goalReached(
    conversationId: string,
    requestId: string,
    evidence: unknown,
    deliver?: (standard: string) => string | undefined,
  ): string {
    const round = this.goalRunTask(conversationId, requestId);
    if (!round || round.state !== "pending")
      throw new TaskError(GOAL_REACHED_OUTSIDE);
    if (typeof evidence !== "string" || isBlankMessage(evidence))
      throw new TaskError(GOAL_REACHED_NO_EVIDENCE);
    const store = this.runtime.store;
    const recorded = truncateTaskSummary(evidence.trim(), GOAL_EVIDENCE_MAX);
    store.db.exec("BEGIN IMMEDIATE");
    let state: string;
    let note: string | undefined;
    try {
      const changed = store.run(
        "UPDATE tasks SET goalState='met',goalEvidence=?,enabled=0,nextRun=NULL,lastError=NULL WHERE id=? AND COALESCE(goalState,'pending')='pending'",
        recorded,
        round.taskId,
      ).changes;
      if (changed)
        note = deliver?.(
          `Goal reached: ${goalLabel({ prompt: round.prompt, pr: null })} — ${recorded}`,
        );
      state = changed
        ? "recorded"
        : (store.get<{ goalState: string | null }>(
            "SELECT goalState FROM tasks WHERE id=?",
            round.taskId,
          )?.goalState ?? "pending");
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    if (state === "recorded")
      return `Recorded: the goal is reached and closed. No further checks will run.${note ? ` ${note}` : ""}`;
    // A repeated call in the same round changes nothing and sends nothing.
    if (state === "met")
      return "Already recorded: this goal is reached and closed. Nothing else to do.";
    throw new TaskError(
      `This goal already ended: ${state}. Nothing was recorded.`,
    );
  }

  /** After a goal round settles: the last allowed attempt without goal_reached
   * blocks the goal, with one legible message on that round's frozen route. */
  private settleGoalRound(runId: string) {
    const row = this.runtime.store.get<TaskRow & { runState: string }>(
      `SELECT t.*,r.state AS runState FROM task_runs r JOIN tasks t ON t.id=r.taskId
       WHERE r.id=? AND ${OBJECTIVE_GOAL("t")}`,
      runId,
    );
    if (
      !row ||
      row.runState === "pending" ||
      (row.goalState ?? "pending") !== "pending" ||
      row.goalAttempts < (row.goalMaxAttempts ?? GOAL_ATTEMPTS_MAX)
    )
      return;
    this.blockGoal(row);
  }

  private blockGoal(
    task: TaskRow,
    reason = `The condition was not observed after ${
      task.goalMaxAttempts ?? GOAL_ATTEMPTS_MAX
    } checks: the check limit was reached.`,
  ) {
    const store = this.runtime.store;
    store.savepoint("goal_block", () => {
      const changed = store.run(
        "UPDATE tasks SET goalState='blocked',enabled=0,nextRun=NULL,lastError=? WHERE id=? AND COALESCE(goalState,'pending')='pending'",
        reason,
        task.id,
      ).changes;
      const last = store.get<{ conversationId: string; requestId: string }>(
        "SELECT conversationId,requestId FROM task_runs WHERE taskId=? ORDER BY rowid DESC LIMIT 1",
        task.id,
      );
      if (changed && last)
        queueTaskTelegram(
          store,
          last.conversationId,
          last.requestId,
          `Goal blocked: ${goalLabel({ prompt: task.prompt, pr: null })} — ${reason} No further checks will run. Use /goal list.`,
          "goal-blocked",
        );
    });
  }

  /** An explicit end time, reached: the goal ends expired before any check.
   * Reuses blockGoal's terminal path and single-notification guarantee. */
  private expireGoals(now: number) {
    const store = this.runtime.store;
    for (const task of store.all<TaskRow>(
      `SELECT * FROM tasks t WHERE t.deleted=0 AND t.enabled=1
         AND ${OBJECTIVE_GOAL("t")} AND COALESCE(goalState,'pending')='pending'
         AND goalEndAt IS NOT NULL AND goalEndAt<=?`,
      now,
    ))
      this.blockGoal(
        task,
        `The goal expired on ${formatGoalEnd(
          task.goalEndAt!,
        )} after ${task.goalAttempts} checks.`,
      );
  }

  /** Bounded goal work in the ordinary tick; the rest stays due, uncounted. */
  private async goalPass() {
    const store = this.runtime.store;
    // A volume runs one gateway: Telegram-only goals never fetch while
    // WhatsApp is the active phone gateway.
    if (this.runtime.options?.phoneGateway === "whatsapp") return;
    this.recoverInterruptedGoalRuns();
    const now = this.clock();
    const due = store.all<GoalTask>(
      `SELECT t.id,t.conversationId,t.enabled,t.nextRun,t.destinationChat,t.destinationUser,t.destinationBotId,t.destinationMessageThreadId,t.destinationReason,
         g.owner,g.repo,g.prNumber,g.intervalMin,g.maxAttempts,g.attempts,g.state AS goalState
       FROM task_goals g JOIN tasks t ON t.id=g.taskId
       WHERE g.state='pending' AND t.deleted=0 AND t.nextRun<=?
         AND t.conversationId NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL)
       ORDER BY t.nextRun LIMIT ?`,
      now,
      GOAL_CHECKS_PER_TICK,
    );
    for (const task of due) await this.checkGoal(task);
  }

  /** Runs reserved before a crash are closed, never replayed with a second GET. */
  private recoverInterruptedGoalRuns() {
    const store = this.runtime.store;
    const now = this.clock();
    for (const run of store.all<{
      id: string;
      taskId: string;
      requestId: string;
      conversationId: string;
    }>(
      `SELECT r.id,r.taskId,r.requestId,r.conversationId FROM task_runs r
       JOIN tasks t ON t.id=r.taskId
       WHERE r.state IN ('pending','checking') AND t.kind='goal' AND ${PR_GOAL("t")} AND r.startedAt IS NOT NULL`,
    )) {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        const goal = store.get<GoalRow>(
          "SELECT * FROM task_goals WHERE taskId=?",
          run.taskId,
        );
        if (
          store.get(
            "SELECT 1 FROM task_runs WHERE id=? AND state IN ('pending','checking')",
            run.id,
          )
        ) {
          store.run(
            "UPDATE task_runs SET state='failed',status='erro',error='The check was interrupted before it finished.',finishedAt=? WHERE id=?",
            now,
            run.id,
          );
          store.run(
            "UPDATE task_goals SET lastResult='The check was interrupted before it finished.' WHERE taskId=? AND state='pending'",
            run.taskId,
          );
          // The crashed attempt consumed the budget: no more GET, even now.
          if (goal?.state === "pending" && goal.attempts >= goal.maxAttempts) {
            const reason = `No definite answer after ${goal.maxAttempts} checks; the last check was interrupted.`;
            store.run(
              "UPDATE task_goals SET state='blocked',reason=? WHERE taskId=? AND state='pending'",
              reason,
              run.taskId,
            );
            store.run(
              "UPDATE tasks SET enabled=0,nextRun=NULL,lastError=? WHERE id=?",
              reason,
              run.taskId,
            );
            queueTaskTelegram(
              store,
              run.conversationId,
              run.requestId,
              `Goal blocked: ${goal.owner}/${goal.repo}#${goal.prNumber} — ${reason} No further checks will run. Use /goal list.`,
            );
          }
        }
        store.db.exec("COMMIT");
      } catch (error) {
        store.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /** Revoked destination or archived conversation: no fetch, honest block. */
  private goalBlockReason(task: GoalTask): string | null {
    const store = this.runtime.store;
    if (store.conversationDeleted(task.conversationId))
      return "The conversation was deleted.";
    if (task.destinationReason) return "The Telegram destination was revoked.";
    const frozen: TelegramRoute | undefined =
      task.destinationChat && task.destinationUser && task.destinationBotId
        ? {
            chat: task.destinationChat,
            user: task.destinationUser,
            botId: task.destinationBotId,
            conversationId: task.conversationId,
            messageThreadId: task.destinationMessageThreadId,
          }
        : undefined;
    if (!frozen || !telegramRouteAuthorized(store, frozen))
      return "The Telegram destination was revoked.";
    return null;
  }

  /** Reserve/increment the attempt and the next check durably BEFORE the fetch:
   * a crash consumes the attempt instead of repeating the read. */
  private reserveGoalAttempt(taskId: string, now: number) {
    const store = this.runtime.store;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const task = store.get<GoalTask>(
        "SELECT * FROM tasks WHERE id=? AND deleted=0",
        taskId,
      );
      const goal = store.get<GoalRow>(
        "SELECT * FROM task_goals WHERE taskId=?",
        taskId,
      );
      if (
        !task ||
        !goal ||
        goal.state !== "pending" ||
        task.nextRun === null ||
        task.nextRun > now ||
        goal.attempts >= goal.maxAttempts ||
        store.get(
          "SELECT 1 FROM task_runs WHERE taskId=? AND state IN ('pending','checking')",
          taskId,
        )
      ) {
        store.db.exec("COMMIT");
        return undefined;
      }
      const run = {
        id: randomUUID(),
        requestId: `task:${randomUUID()}`,
        conversationId: task.conversationId,
      };
      // 'checking' is invisible to a pre-goal binary's dispatch/refresh: a
      // goal run is never eligible to the ordinary model pipeline at rest.
      store.run(
        "INSERT INTO task_runs(id,taskId,scheduledAt,state,requestId,scheduled,conversationId,delivery,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,originSource,originConversationId,originRequestId,startedAt) VALUES (?, ?,?,'checking',?,1,?,?,?,?,?,?,?,?,?,?,?)",
        run.id,
        taskId,
        now,
        run.requestId,
        task.conversationId,
        "web_telegram",
        task.destinationChat,
        task.destinationUser,
        task.destinationBotId,
        task.destinationMessageThreadId,
        task.destinationReason,
        task.originSource,
        task.conversationId,
        task.originRequestId,
        now,
      );
      store.run(
        "UPDATE task_goals SET attempts=? WHERE taskId=?",
        goal.attempts + 1,
        taskId,
      );
      // Cadence stays monotonic: every attempt schedules from its own now.
      store.run(
        "UPDATE tasks SET nextRun=? WHERE id=?",
        now + goal.intervalMin * 60_000,
        taskId,
      );
      store.db.exec("COMMIT");
      return { task, goal, count: goal.attempts + 1, run };
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async checkGoal(task: GoalTask) {
    const attempt = this.reserveGoalAttempt(task.id, this.clock());
    if (!attempt) return;
    const block = this.goalBlockReason(attempt.task);
    if (block)
      return this.settleGoalAttempt(attempt, {
        kind: "blocked",
        reason: block,
      });
    const observation = await observePrMerged(
      {
        owner: attempt.goal.owner,
        repo: attempt.goal.repo,
        prNumber: attempt.goal.prNumber,
      },
      this.goalFetcher,
    );
    this.settleGoalAttempt(attempt, observation);
  }

  /** One atomic settle of the exact goal, run and terminal queueing. */
  private settleGoalAttempt(
    attempt: {
      task: GoalTask;
      goal: GoalRow;
      count: number;
      run: { id: string; requestId: string; conversationId: string };
    },
    outcome: PrObservation | { kind: "blocked"; reason: string },
  ) {
    const store = this.runtime.store;
    const now = this.clock();
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const goal = store.get<GoalRow>(
        "SELECT * FROM task_goals WHERE taskId=?",
        attempt.task.id,
      );
      const run = store.get<{ state: string }>(
        "SELECT state FROM task_runs WHERE id=? AND taskId=? AND requestId=? AND conversationId=?",
        attempt.run.id,
        attempt.task.id,
        attempt.run.requestId,
        attempt.run.conversationId,
      );
      // Discard late, cancelled or already-settled results: exact run identity,
      // still in flight, and the same reserved attempt.
      if (
        !goal ||
        goal.state !== "pending" ||
        goal.attempts !== attempt.count ||
        (run?.state !== "pending" && run?.state !== "checking")
      ) {
        if (run && (run.state === "pending" || run.state === "checking"))
          store.run(
            "UPDATE task_runs SET state='failed',error='Discarded: the goal is no longer pending.',finishedAt=? WHERE id=?",
            now,
            attempt.run.id,
          );
        store.db.exec("COMMIT");
        return;
      }
      const label = `${goal.owner}/${goal.repo}#${goal.prNumber}`;
      const terminal = (state: "completed" | "blocked", reason: string) => {
        const message =
          state === "completed"
            ? `Goal reached: ${label} was merged.`
            : `Goal blocked: ${label} — ${reason} No further checks will run. Use /goal list.`;
        store.run(
          "UPDATE task_goals SET state=?,reason=? WHERE taskId=? AND state='pending'",
          state,
          reason,
          attempt.task.id,
        );
        store.run(
          "UPDATE tasks SET enabled=0,nextRun=NULL,lastError=? WHERE id=?",
          reason,
          attempt.task.id,
        );
        store.run(
          "UPDATE task_runs SET state='done',finishedAt=?,status=?,summary=?,error=? WHERE id=?",
          now,
          state === "completed" ? "ok" : "erro",
          truncateTaskSummary(message, 1000),
          state === "completed" ? null : reason,
          attempt.run.id,
        );
        // Frozen task_runs route, revalidated at send; a skip is recorded, never claimed as delivery.
        queueTaskTelegram(
          store,
          attempt.run.conversationId,
          attempt.run.requestId,
          message,
        );
      };
      if (outcome.kind === "merged") terminal("completed", GOAL_MERGED_REASON);
      else if (outcome.kind === "blocked") terminal("blocked", outcome.reason);
      else if (outcome.kind === "closed_unmerged")
        terminal(
          "blocked",
          "The pull request was closed without being merged.",
        );
      // A 404 is definite on the first read: no budget is spent waiting.
      else if (outcome.kind === "not_found")
        terminal("blocked", GOAL_NOT_FOUND_REASON);
      // Before the budget check: GitHub refused the read, so the attempt
      // reserved before the fetch is refunded and the goal waits one interval.
      // The chat hears it once, on entering the rate-limited state.
      else if (outcome.kind === "rate_limited") {
        const entering = goal.rateLimitedAt === null;
        store.run(
          "UPDATE task_goals SET attempts=?,lastResult=?,rateLimitedAt=COALESCE(rateLimitedAt,?) WHERE taskId=?",
          attempt.count - 1,
          GOAL_RATE_LIMITED,
          now,
          attempt.task.id,
        );
        store.run(
          "UPDATE tasks SET nextRun=? WHERE id=?",
          now + goal.intervalMin * 60_000,
          attempt.task.id,
        );
        store.run(
          "UPDATE task_runs SET state='done',finishedAt=?,status=?,summary=? WHERE id=?",
          now,
          entering ? "erro" : "silencioso",
          GOAL_RATE_LIMITED,
          attempt.run.id,
        );
        if (entering)
          queueTaskTelegram(
            store,
            attempt.run.conversationId,
            attempt.run.requestId,
            `GitHub is rate limiting checks of ${label}. These checks are not counted as attempts; the goal retries every ${goal.intervalMin} minutes. You will not be told again while it lasts.`,
          );
      }
      // The budget check comes before the open branch: a valid open read on
      // the last allowed attempt must settle terminally, not strand the goal
      // pending forever. Transient outcomes keep the same exhausted message.
      else if (attempt.count >= goal.maxAttempts)
        terminal(
          "blocked",
          outcome.kind === "open"
            ? `The pull request is still open after ${goal.maxAttempts} checks.`
            : `No definite answer after ${goal.maxAttempts} checks (last: ${outcome.reason}).`,
        );
      else if (outcome.kind === "open") {
        store.run(
          "UPDATE task_runs SET state='done',finishedAt=?,status='silencioso',summary='The pull request is still open.' WHERE id=?",
          now,
          attempt.run.id,
        );
        // Only a valid observation on a still-pending goal proves recovery.
        store.run(
          "UPDATE task_goals SET lastResult='The pull request is still open.',rateLimitedAt=NULL WHERE taskId=?",
          attempt.task.id,
        );
      } else {
        store.run(
          "UPDATE task_runs SET state='done',finishedAt=?,status='silencioso',summary=? WHERE id=?",
          now,
          outcome.reason,
          attempt.run.id,
        );
        store.run(
          "UPDATE task_goals SET lastResult=? WHERE taskId=?",
          outcome.reason,
          attempt.task.id,
        );
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }

  start() {
    if (this.closing) throw new TaskError("Scheduler is shutting down");
    if (this.timer) return;
    const tick = () => {
      void this.tick().catch((error: unknown) => {
        if (!this.closing) logFailure("Task scheduler failed", error);
      });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.memoryConsolidation?.shutdown.abort();
    await this.tail;
    await this.memoryConsolidationWork;
    this.refresh();
  }
}

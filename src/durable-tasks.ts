import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  ConversationIdle,
  type Conversation,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { DurableTaskConfig } from "./harness-config.js";
import { logFailure } from "./log.js";
import { elapsedText, formatDayClock } from "./pending-jobs.js";
import { settleFailureReason, type Runtime } from "./runtime.js";
import { hash, type Store } from "./store.js";

export const DURABLE_TASK_GOAL_MAX = 4000;
export const DURABLE_TASK_REJECTION_REASON_MAX = 200;

const STATES = [
  "queued",
  "running",
  "interrupted",
  "ready_for_review",
  "done",
  "cancelled",
] as const;
type DurableTaskState = (typeof STATES)[number];

const TRANSITIONS: Record<DurableTaskState, readonly DurableTaskState[]> = {
  queued: ["running", "interrupted"],
  running: ["done", "queued", "interrupted", "ready_for_review"],
  interrupted: [],
  ready_for_review: ["done", "queued", "cancelled"],
  done: [],
  cancelled: [],
};

const COLUMNS = {
  creationKey: "TEXT",
  runConversationId: "TEXT",
  attempts: "INTEGER NOT NULL DEFAULT 0",
  maxAttempts: "INTEGER NOT NULL DEFAULT 3",
  nextRun: "INTEGER",
  deadlineAt: "INTEGER",
  budgetTurns: "INTEGER NOT NULL DEFAULT 0",
  artifactPath: "TEXT",
  artifactSha256: "TEXT",
  artifactBytes: "INTEGER",
  artifactVersion: "INTEGER NOT NULL DEFAULT 0",
};
const MAX_TIMER_MS = 2_147_483_647;
const BUDGET_TIMEOUT = "budget_timeout";
const MAX_ARTIFACT_TEXT_BYTES = 512 * 1024;
/** Characters of artifact content show prints. */
const SHOW_ARTIFACT_CHARS = 4000;
/** UTF-8 is at most 4 bytes per character: this many bytes hold one character past the cap. */
const SHOW_ARTIFACT_READ_BYTES = (SHOW_ARTIFACT_CHARS + 1) * 4;
/**
 * Age of updatedAt after which a finished task is pruned: its row and its whole
 * artifacts/durable/<id> directory. Only done and cancelled tasks are finished.
 * queued, running and ready_for_review are live work, and interrupted is the
 * only evidence of a failure: none of them is ever pruned, and interrupted
 * stays until someone acts on it.
 */
export const DURABLE_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNABLE_STATES = ["done", "cancelled"] as const;
/** Request source of a steer: task input that is not the execution admission. */
export const DURABLE_TASK_STEER_SOURCE = "task-steer";

type Execution = {
  runtime: Pick<
    Runtime,
    | "create"
    | "conversation"
    | "submit"
    | "harness"
    | "withProviderAdmission"
    | "readAssistantAnswer"
    | "queueTopicNotice"
    | "flushTelegramPending"
  >;
  config: DurableTaskConfig;
  dir: string;
};
type Attempt = DurableTask & { deadlineAt: number };
type Outcome =
  | { kind: "done"; text: string }
  | { kind: "budget"; error: string }
  | { kind: "failure"; error: string };

/** One tick's retention pass: rows deleted, rows kept because their directory is
 * not their own under the artifacts root, and failures (rows kept). */
export type DurableTaskPruneResult = {
  pruned: number;
  skipped: number;
  failed: number;
};

/** A path strictly below root, the check the artifact read and prune share. */
function insideRoot(root: string, path: string) {
  const inside = relative(root, path);
  return !!inside && !inside.startsWith("..") && !isAbsolute(inside);
}

function requestIdFor(task: Pick<DurableTask, "id" | "attempts">) {
  return `durable-task:${task.id}:${task.attempts}`;
}

/** Same task, attempt and trimmed message: one request; anything else is new input. */
function steerRequestIdFor(
  task: Pick<DurableTask, "id" | "attempts">,
  text: string,
) {
  return `durable-task-steer:${hash(JSON.stringify([task.id, task.attempts, text]))}`;
}

function artifactContent(task: Attempt, finished: number, text: string) {
  const header = [
    `Task: ${task.id}`,
    "State: done",
    `Attempt: ${task.attempts}`,
    `Finished: ${new Date(finished).toISOString()}`,
    `Goal: ${task.goal}`,
    "",
    "---",
    "",
    "",
  ].join("\n");
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_ARTIFACT_TEXT_BYTES) {
    const newline = bytes < MAX_ARTIFACT_TEXT_BYTES ? "\n" : "";
    return Buffer.from(`${header}${text}${newline}`);
  }
  const marker = Buffer.from(
    `\n[Output truncated. Original length: ${bytes} bytes.]\n`,
  );
  const body = Buffer.alloc(MAX_ARTIFACT_TEXT_BYTES - marker.length);
  // Buffer.write stops before any UTF-8 character that would straddle the cap.
  const written = body.write(text, "utf8");
  return Buffer.concat([
    Buffer.from(header),
    body.subarray(0, written),
    marker,
  ]);
}

function writeArtifact(path: string, data: Buffer) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.write-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

const STATE_LABELS: Record<DurableTaskState, string> = {
  queued: "na fila",
  running: "em execução",
  ready_for_review: "pronta para revisão",
  done: "concluída",
  interrupted: "interrompida",
  cancelled: "cancelada",
};
/** Stored lastError codes the user reads as a reason; any other value is shown as is. */
const REASON_LABELS: Record<string, string> = {
  [BUDGET_TIMEOUT]: "tempo limite esgotado",
  budget_turns: "limite de turnos esgotado",
  restart: "reinício do serviço",
};
const LIST_GOAL_MAX = 60;
/** Shortest id prefix the durable_task tool resolves; the full id is 36 characters. */
export const DURABLE_TASK_ID_PREFIX_MIN = 4;

function shortId(id: string) {
  return id.slice(0, 8);
}

export function durableTaskJobPrefix(id: string) {
  return `Tarefa ${shortId(id)} · `;
}

/** Kilobytes with one decimal and a comma separator: 1126 -> "1,1 KB". */
function artifactSizeText(bytes: number) {
  return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
}

function reasonText(lastError: string) {
  return REASON_LABELS[lastError] ?? lastError;
}

/** Tool result of create: one line, no structured value for the model to echo. */
export function durableTaskCreatedText(task: DurableTask) {
  return `Tarefa ${shortId(task.id)} criada, ${STATE_LABELS[task.state]}. O agendador a executa em uma conversa própria. Pode me perguntar como está a qualquer momento.`;
}

export function durableTaskListText(tasks: DurableTask[], now: number) {
  if (!tasks.length) return "Nenhuma tarefa durável nesta conversa.";
  const lines = tasks.map((task) => {
    const goal = [...task.goal.replace(/\s+/g, " ").trim()];
    const excerpt =
      goal.length > LIST_GOAL_MAX
        ? `${goal.slice(0, LIST_GOAL_MAX).join("")}…`
        : goal.join("");
    return `${shortId(task.id)} ${STATE_LABELS[task.state]}, há ${elapsedText(now - task.createdAt)}, ${excerpt}`;
  });
  const count = tasks.length === 1 ? "1 tarefa" : `${tasks.length} tarefas`;
  return [`${count} nesta conversa:`, ...lines].join("\n");
}

/** Prefix of an artifact file; null when it could not be read. */
export type DurableTaskArtifactRead = {
  text: string;
  bytes: number;
  truncated: boolean;
} | null;

export function durableTaskShowText(
  task: DurableTask,
  artifactPath: string | null,
  env: Record<string, string | undefined>,
  artifact: DurableTaskArtifactRead = null,
) {
  const lines = [
    `Tarefa ${shortId(task.id)}, ${STATE_LABELS[task.state]}`,
    `Objetivo: ${task.goal}`,
    `Criada em ${formatDayClock(task.createdAt, env)}, atualizada em ${formatDayClock(task.updatedAt, env)}`,
  ];
  if (task.lastError) lines.push(`Último erro: ${reasonText(task.lastError)}`);
  if (artifactPath)
    lines.push(
      `Artefato versão ${task.artifactVersion}, ${artifactSizeText(task.artifactBytes ?? 0)}, ${artifactPath}`,
    );
  if (task.state === "ready_for_review")
    lines.push('Para fechar, responda "aceito".');
  if (shortId(task.id) !== task.id) lines.push(`ID completo: ${task.id}`);
  if (artifactPath) {
    lines.push("");
    if (!artifact) lines.push("Não foi possível ler o conteúdo do artefato.");
    else {
      lines.push(artifact.text);
      if (artifact.truncated)
        lines.push(
          `[mostrando os primeiros ${SHOW_ARTIFACT_CHARS} caracteres de ${artifactSizeText(artifact.bytes)}]`,
        );
    }
  }
  return lines.join("\n");
}

export function durableTaskAcceptedText(task: DurableTask) {
  return `Tarefa ${shortId(task.id)} ${STATE_LABELS[task.state]}.`;
}

export function durableTaskRejectedText(task: DurableTask) {
  return `Tarefa ${shortId(task.id)} de volta à fila; ela roda de novo em cerca de um minuto e o motivo fica registrado.`;
}

export function durableTaskSteeredText(task: DurableTask) {
  return `Mensagem entregue à tarefa ${shortId(task.id)}.`;
}

/**
 * Chat notice of a settled task: a heading line and an action or reason line.
 * No goal, full id or path; show gives those.
 */
export function durableTaskTerminalNoticeText(task: DurableTask) {
  const heading = `Tarefa ${shortId(task.id)} ${STATE_LABELS[task.state]}`;
  if (task.state === "ready_for_review" && task.artifactBytes !== null)
    return [
      `${heading} (v${task.artifactVersion}, ${artifactSizeText(task.artifactBytes)})`,
      'Responda "aceito" para fechar, ou "refaça: <motivo>" para eu rodar de novo.',
    ].join("\n");
  if (task.state === "interrupted")
    return [
      heading,
      `Motivo: ${task.lastError ? reasonText(task.lastError) : "não informado"}`,
    ].join("\n");
  return heading;
}

/** Chat notice after boot interrupted the running or queued tasks of one conversation. */
export function durableTaskRestartNoticeText(ids: string[]) {
  return [
    ids.length === 1
      ? `Tarefa ${shortId(ids[0]!)} interrompida`
      : `${ids.length} tarefas interrompidas`,
    `Motivo: ${REASON_LABELS.restart}`,
  ].join("\n");
}

export class DurableTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableTaskError";
  }
}

export interface DurableTask {
  id: string;
  conversationId: string;
  goal: string;
  state: DurableTaskState;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  creationKey: string | null;
  runConversationId: string | null;
  attempts: number;
  maxAttempts: number;
  nextRun: number | null;
  deadlineAt: number | null;
  budgetTurns: number;
  artifactPath: string | null;
  artifactSha256: string | null;
  artifactBytes: number | null;
  artifactVersion: number;
}

export class DurableTasks {
  private shutdown = new AbortController();
  private settlement?: Promise<void>;

  constructor(
    private store: Store,
    private clock = () => Date.now(),
    private execution?: Execution,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS durable_tasks (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        goal TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('${STATES.join("','")}')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        lastError TEXT,
        creationKey TEXT
      );
    `);
    const columns = new Set(
      store
        .all<{ name: string }>("PRAGMA table_info(durable_tasks)")
        .map(({ name }) => name),
    );
    for (const [name, definition] of Object.entries(COLUMNS))
      if (!columns.has(name))
        store.db.exec(
          `ALTER TABLE durable_tasks ADD COLUMN ${name} ${definition}`,
        );
    store.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS durable_tasks_creation ON durable_tasks(conversationId, creationKey);
      CREATE INDEX IF NOT EXISTS durable_tasks_conversation ON durable_tasks(conversationId, createdAt);
    `);
  }

  /** Artifact path relative to the runtime directory: artifacts/durable/<id>/<n>.md. */
  artifactDisplayPath(path: string | null) {
    if (!path || !this.execution || !isAbsolute(path)) return path;
    const shown = relative(this.execution.dir, path);
    return shown.startsWith("..") || isAbsolute(shown)
      ? path
      : shown.split(sep).join("/");
  }

  /**
   * At most SHOW_ARTIFACT_CHARS characters of an artifact under the runtime's
   * artifacts/durable root. Symlinks are resolved before the root check, and
   * only a bounded prefix is read. Never throws and never touches the row.
   */
  readArtifact(path: string | null): DurableTaskArtifactRead {
    if (!path || !this.execution) return null;
    let fd: number | undefined;
    try {
      const root = realpathSync(
        join(this.execution.dir, "artifacts", "durable"),
      );
      const file = realpathSync(resolve(this.execution.dir, path));
      if (!insideRoot(root, file)) return null;
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = fstatSync(fd);
      if (!stats.isFile()) return null;
      const buffer = Buffer.alloc(SHOW_ARTIFACT_READ_BYTES);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (!read) break;
        length += read;
      }
      // A partial character at a full buffer's end decodes past the cap.
      const chars = [...buffer.toString("utf8", 0, length)];
      const truncated =
        length === buffer.length || chars.length > SHOW_ARTIFACT_CHARS;
      return {
        text: chars.slice(0, SHOW_ARTIFACT_CHARS).join(""),
        bytes: stats.size,
        truncated,
      };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  create(conversationId: string, goal: string, creationKey?: string) {
    if (
      typeof goal !== "string" ||
      !goal.trim() ||
      goal.length > DURABLE_TASK_GOAL_MAX
    )
      throw new DurableTaskError(
        `Goal must be non-empty and at most ${DURABLE_TASK_GOAL_MAX} characters`,
      );
    const now = this.clock();
    const created = this.store.get<DurableTask>(
      `INSERT INTO durable_tasks(id,conversationId,goal,state,createdAt,updatedAt,creationKey)
       VALUES (?,?,?,'queued',?,?,?)
       ON CONFLICT(conversationId,creationKey) DO NOTHING RETURNING *`,
      randomUUID(),
      conversationId,
      goal,
      now,
      now,
      creationKey ?? null,
    );
    if (created) return created;
    const prior = this.store.get<DurableTask>(
      "SELECT * FROM durable_tasks WHERE conversationId=? AND creationKey=?",
      conversationId,
      creationKey ?? null,
    );
    if (!prior || prior.goal !== goal)
      throw new DurableTaskError(
        "Creation key already used with different content",
      );
    return prior;
  }

  list(conversationId: string, limit = -1) {
    return this.store.all<DurableTask>(
      "SELECT * FROM durable_tasks WHERE conversationId=? ORDER BY createdAt DESC, rowid DESC LIMIT ?",
      conversationId,
      limit,
    );
  }

  get(conversationId: string, id: string) {
    return this.store.get<DurableTask>(
      "SELECT * FROM durable_tasks WHERE conversationId=? AND id=?",
      conversationId,
      id,
    );
  }

  /**
   * Full id of the task in this conversation that `ref` names: the exact id, or
   * a prefix of at least DURABLE_TASK_ID_PREFIX_MIN characters that only one of
   * its tasks starts with. Comparison is exact (case-sensitive), like get().
   * When nothing matches, `ref` is returned unchanged so the caller's own lookup
   * answers "Durable task not found" in its usual order.
   */
  resolveId(conversationId: string, ref: string) {
    if (
      ref.length < DURABLE_TASK_ID_PREFIX_MIN ||
      this.get(conversationId, ref)
    )
      return ref;
    const matches = this.store.all<{ id: string }>(
      "SELECT id FROM durable_tasks WHERE conversationId=? AND substr(id,1,length(?))=?",
      conversationId,
      ref,
      ref,
    );
    if (matches.length > 1)
      throw new DurableTaskError(
        `Task id ${ref} matches ${matches.length} tasks in this conversation. Use more characters of the id.`,
      );
    return matches[0]?.id ?? ref;
  }

  transition(
    conversationId: string,
    id: string,
    state: DurableTaskState,
    lastError: string | null = null,
  ) {
    const prior = this.get(conversationId, id);
    if (!prior) throw new DurableTaskError("Durable task not found");
    if (!TRANSITIONS[prior.state]?.includes(state))
      throw new DurableTaskError(
        `Invalid durable task transition ${prior.state} -> ${state}`,
      );
    const updated = this.store.get<DurableTask>(
      "UPDATE durable_tasks SET state=?,updatedAt=?,lastError=? WHERE conversationId=? AND id=? AND state=? AND artifactVersion=? RETURNING *",
      state,
      this.clock(),
      lastError,
      conversationId,
      id,
      prior.state,
      prior.artifactVersion,
    );
    if (!updated)
      throw new DurableTaskError("Durable task changed before transition");
    return updated;
  }

  accept(
    conversationId: string,
    id: string,
    artifactVersion: number | undefined,
  ) {
    if (artifactVersion === undefined || !Number.isInteger(artifactVersion))
      throw new DurableTaskError("An integer artifactVersion is required");
    return this.review(conversationId, id, { artifactVersion });
  }

  reject(conversationId: string, id: string, reason: string) {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > DURABLE_TASK_REJECTION_REASON_MAX
    )
      throw new DurableTaskError(
        `Rejection reason must be non-empty and at most ${DURABLE_TASK_REJECTION_REASON_MAX} characters`,
      );
    return this.review(conversationId, id, { reason });
  }

  /**
   * Delivers a message into the running task's own conversation as a steer of
   * its current run. The row and the origin conversation are left untouched.
   */
  async steer(conversationId: string, id: string, message: string) {
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > DURABLE_TASK_GOAL_MAX
    )
      throw new DurableTaskError(
        `Steer message must be non-empty and at most ${DURABLE_TASK_GOAL_MAX} characters`,
      );
    const task = this.get(conversationId, id);
    if (!task) throw new DurableTaskError("Durable task not found");
    if (task.state !== "running")
      throw new DurableTaskError(
        `Durable task is ${task.state}. Steering requires running.`,
      );
    const runId = task.runConversationId;
    if (!this.execution || !runId || runId === task.conversationId)
      throw new DurableTaskError(
        "Durable task has no execution conversation yet",
      );
    const text = message.trim();
    const requestId = steerRequestIdFor(task, text);
    try {
      await this.execution.runtime.submit(
        runId,
        requestId,
        text,
        DURABLE_TASK_STEER_SOURCE,
        null,
        undefined,
        undefined,
        true,
      );
    } catch (error) {
      if (!(error instanceof ConversationIdle)) throw error;
      // The run answered before the row left running. The harness wrote nothing;
      // settle the request row too, so boot never replays it into a new run.
      this.store.run(
        `UPDATE requests SET status='unanswered'
         WHERE conversationId=? AND requestId=? AND source=? AND status='pending'`,
        runId,
        requestId,
        DURABLE_TASK_STEER_SOURCE,
      );
      throw new DurableTaskError(
        "Durable task run has already finished. Steering requires running. The message was not delivered.",
      );
    }
    return task;
  }

  private taskForReview(
    conversationId: string,
    id: string,
    artifactVersion?: number,
  ) {
    const task = this.get(conversationId, id);
    if (!task) throw new DurableTaskError("Durable task not found");
    if (task.state !== "ready_for_review")
      throw new DurableTaskError(
        `Durable task is ${task.state}. Review requires ready_for_review.`,
      );
    if (
      artifactVersion !== undefined &&
      task.artifactVersion !== artifactVersion
    )
      throw new DurableTaskError(
        `Artifact version does not match. Current version is ${task.artifactVersion}.`,
      );
    return task;
  }

  private review(
    conversationId: string,
    id: string,
    decision: { artifactVersion: number } | { reason: string },
  ) {
    const rejecting = "reason" in decision;
    const task = this.taskForReview(
      conversationId,
      id,
      rejecting ? undefined : decision.artifactVersion,
    );
    const now = this.clock();
    const updated = this.store.get<DurableTask>(
      `UPDATE durable_tasks
       SET state=?, updatedAt=?, lastError=?, nextRun=COALESCE(?,nextRun)
       WHERE conversationId=? AND id=? AND state='ready_for_review' AND artifactVersion=?
       RETURNING *`,
      rejecting ? "queued" : "done",
      now,
      rejecting ? `rejected: ${decision.reason}` : null,
      rejecting ? now + 60_000 : null,
      conversationId,
      id,
      task.artifactVersion,
    );
    if (updated) return updated;
    this.taskForReview(conversationId, id, task.artifactVersion);
    throw new DurableTaskError("Durable task changed during review");
  }

  /**
   * Prunes first, then claims. The prune is synchronous and never throws, so it
   * cannot delay or fail the claim; running it ahead of the settlement guard
   * keeps one long run from postponing retention, and it never holds provider
   * admission. Returns the prune counts, or undefined when nothing ran.
   */
  async tick(): Promise<DurableTaskPruneResult | undefined> {
    if (!this.execution || this.shutdown.signal.aborted) return;
    const pruned = this.prune();
    if (this.settlement || this.store.credentialMutation) return pruned;
    const { runtime, config } = this.execution;
    await runtime.withProviderAdmission(async () => {
      const now = this.clock();
      const task = this.store.get<Attempt>(
        `UPDATE durable_tasks
         SET state='running', attempts=attempts+1, updatedAt=?, deadlineAt=?
         WHERE state='queued' AND rowid=(
           SELECT rowid FROM durable_tasks
           WHERE state='queued' AND (nextRun IS NULL OR nextRun<=?)
           ORDER BY COALESCE(nextRun, createdAt), rowid LIMIT 1
         ) AND NOT EXISTS (SELECT 1 FROM durable_tasks WHERE state='running')
         RETURNING *`,
        now,
        Math.min(now + config.wallClockMs, Number.MAX_SAFE_INTEGER),
        now,
      );
      if (!task) return;
      try {
        if (this.clock() >= task.deadlineAt) {
          this.settle(task, { kind: "budget", error: BUDGET_TIMEOUT });
          return;
        }
        const runId =
          task.runConversationId ?? (await runtime.create("Durable task"));
        if (runId === task.conversationId)
          throw new DurableTaskError(
            "Execution conversation matches the origin",
          );
        if (
          !task.runConversationId &&
          !this.store.run(
            `UPDATE durable_tasks SET runConversationId=?
           WHERE id=? AND state='running' AND attempts=?`,
            runId,
            task.id,
            task.attempts,
          ).changes
        )
          return;
        const conversation = await runtime.conversation(runId);
        await conversation.configure(
          { maxTurns: task.budgetTurns || config.maxTurns },
          context,
        );
        if (this.clock() >= task.deadlineAt) {
          this.settle(task, { kind: "budget", error: BUDGET_TIMEOUT });
          return;
        }
        const { submissionId } = await runtime.submit(
          runId,
          requestIdFor(task),
          task.goal,
          "task",
          null,
        );
        this.settlement = this.watch(task, conversation, submissionId, runtime)
          .catch((error: unknown) =>
            logFailure("Durable task settlement failed", error),
          )
          .finally(() => {
            this.settlement = undefined;
          });
      } catch (error) {
        this.settle(task, this.failure(task, error));
      }
    });
    return pruned;
  }

  /**
   * Deletes finished tasks (PRUNABLE_STATES) last updated more than
   * DURABLE_TASK_RETENTION_MS ago: the task's artifact directory first, the row
   * last, so a crash between them leaves an orphan file and never a row naming
   * a missing file. Each failure is counted and the row kept for the next tick.
   */
  private prune(): DurableTaskPruneResult {
    const result = { pruned: 0, skipped: 0, failed: 0 };
    try {
      const states = PRUNABLE_STATES.map((state) => `'${state}'`).join(",");
      const cutoff = this.clock() - DURABLE_TASK_RETENTION_MS;
      for (const task of this.store.all<DurableTask>(
        `SELECT * FROM durable_tasks WHERE state IN (${states}) AND updatedAt<?`,
        cutoff,
      ))
        try {
          if (!this.removeArtifactDir(task)) {
            result.skipped += 1;
            continue;
          }
          this.store.run(
            `DELETE FROM durable_tasks WHERE id=? AND state IN (${states}) AND updatedAt<?`,
            task.id,
            cutoff,
          );
          result.pruned += 1;
        } catch {
          result.failed += 1;
        }
    } catch {
      result.failed += 1;
    }
    return result;
  }

  /**
   * Removes artifacts/durable/<id>, resolved like readArtifact: symlinks first,
   * then the root check. False, with nothing removed, when the stored path is
   * not in that directory or the directory resolves anywhere else. A missing
   * directory is already removed.
   */
  private removeArtifactDir(task: DurableTask) {
    const { dir } = this.execution!;
    const root = join(dir, "artifacts", "durable");
    const own = join(root, task.id);
    if (task.artifactPath && dirname(resolve(dir, task.artifactPath)) !== own)
      return false;
    let real: string;
    try {
      real = realpathSync(own);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const realRoot = realpathSync(root);
    if (!insideRoot(realRoot, real) || relative(realRoot, real) !== task.id)
      return false;
    rmSync(real, { recursive: true, force: true });
    return true;
  }

  private async watch(
    task: Attempt,
    conversation: Conversation,
    submissionId: SubmissionId,
    runtime: Execution["runtime"],
  ) {
    const timeout = new AbortController();
    const { signal } = this.shutdown;
    const waitContext = withAbortSignal(
      AbortSignal.any([signal, timeout.signal]),
      context,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const remaining = task.deadlineAt - this.clock();
      if (remaining <= 0) timeout.abort();
      else
        timer = setTimeout(
          remaining > MAX_TIMER_MS ? arm : () => timeout.abort(),
          Math.min(remaining, MAX_TIMER_MS),
        ).unref();
    };
    arm();
    let outcome: Outcome;
    try {
      const submission = await runtime.harness.submission(
        submissionId,
        waitContext,
      );
      if (!submission)
        throw new DurableTaskError("Missing execution submission");
      const result = await submission.wait(waitContext);
      if (result.status === "done") {
        if (result.answer === undefined)
          throw new DurableTaskError("Missing execution answer");
        outcome = {
          kind: "done",
          text: await runtime.readAssistantAnswer(
            conversation,
            result.answer,
            waitContext,
          ),
        };
      } else if (result.reason === "turn_limit")
        outcome = { kind: "budget", error: "budget_turns" };
      else outcome = { kind: "failure", error: settleFailureReason(result) };
    } catch (error) {
      outcome = this.failure(task, error);
    } finally {
      clearTimeout(timer);
    }
    if (signal.aborted) return;
    if (timeout.signal.aborted || this.clock() >= task.deadlineAt) {
      this.settle(task, { kind: "budget", error: BUDGET_TIMEOUT });
      await conversation
        .abort(withAbortSignal(signal, context), { background: true })
        .catch((error: unknown) => {
          if (!signal.aborted) logFailure("Durable task abort failed", error);
        });
      return;
    }
    this.settle(task, outcome);
  }

  private failure(task: Attempt, error: unknown): Outcome {
    if (this.clock() >= task.deadlineAt)
      return { kind: "budget", error: BUDGET_TIMEOUT };
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return { kind: "failure", error: message || "Execution failed" };
  }

  private settle(task: Attempt, outcome: Outcome) {
    if (!this.execution) return;
    const { dir, runtime } = this.execution;
    const now = this.clock();
    const retry =
      outcome.kind === "failure" && task.attempts < task.maxAttempts;
    const state =
      outcome.kind === "done"
        ? "ready_for_review"
        : retry
          ? "queued"
          : "interrupted";
    const path =
      outcome.kind === "done"
        ? join(dir, "artifacts", "durable", task.id, `${task.attempts}.md`)
        : null;
    const data =
      outcome.kind === "done" ? artifactContent(task, now, outcome.text) : null;
    let wroteArtifact = false;
    let queuedNotice: boolean;
    try {
      queuedNotice = this.store.savepoint("durable_task_settlement", () => {
        // Validate the attempt before writing a file, and commit the row and notice only after rename.
        const row = this.store.get<DurableTask>(
          `UPDATE durable_tasks SET state=?, updatedAt=?, lastError=?, nextRun=?,
           deadlineAt=CASE WHEN ? THEN NULL ELSE deadlineAt END,
           artifactPath=COALESCE(?,artifactPath),
           artifactSha256=COALESCE(?,artifactSha256),
           artifactBytes=COALESCE(?,artifactBytes),
           artifactVersion=artifactVersion+?
           WHERE id=? AND state='running' AND attempts=? RETURNING *`,
          state,
          now,
          outcome.kind === "done" ? null : outcome.error,
          retry ? now + Math.min(60_000 * task.attempts, 3_600_000) : null,
          outcome.kind === "done" ? 1 : 0,
          path,
          data ? createHash("sha256").update(data).digest("hex") : null,
          data?.byteLength ?? null,
          data ? 1 : 0,
          task.id,
          task.attempts,
        );
        if (!row || retry) return false;
        const queued = this.queueTerminalNotice(row, runtime);
        if (path && data) {
          writeArtifact(path, data);
          wroteArtifact = true;
        }
        return queued;
      });
    } catch (error) {
      if (wroteArtifact && path) rmSync(path, { force: true });
      if (outcome.kind !== "done") throw error;
      this.settle(task, this.failure(task, error));
      return;
    }
    if (queuedNotice) runtime.flushTelegramPending?.();
  }

  private queueTerminalNotice(
    task: DurableTask,
    runtime: Execution["runtime"],
  ) {
    if (this.store.conversationDeleted(task.conversationId)) return false;
    const reviewing = task.state === "ready_for_review";
    const versionOrState = reviewing ? task.artifactVersion : task.state;
    const requestId = `durable-task-terminal:${hash(JSON.stringify([task.id, versionOrState]))}`;
    const text = durableTaskTerminalNoticeText(task);
    const notice = this.store.run(
      "INSERT OR IGNORE INTO requests(conversationId,requestId,text,source,status) VALUES (?,?,?,'system','done')",
      task.conversationId,
      requestId,
      text,
    );
    return (
      !!notice.changes &&
      runtime.queueTopicNotice(task.conversationId, requestId, text)
    );
  }

  async close() {
    this.shutdown.abort();
    await this.settlement;
  }

  resumeOnBoot() {
    const states = STATES.filter((state) =>
      TRANSITIONS[state].includes("interrupted"),
    );
    return this.store.all<DurableTask>(
      `UPDATE durable_tasks SET state='interrupted',updatedAt=?,lastError='restart'
       WHERE state IN (${states.map(() => "?").join(",")}) RETURNING *`,
      this.clock(),
      ...states,
    );
  }

  async stopRestartedRuns() {
    if (!this.execution) return;
    const tasks = this.store.all<{
      id: string;
      attempts: number;
      runConversationId: string;
    }>(
      `SELECT id, attempts, runConversationId FROM durable_tasks
       WHERE state='interrupted' AND lastError IN ('restart', 'budget_timeout')
         AND runConversationId<>conversationId`,
    );
    // A steer only joins the run it was sent to, and no run survives a restart:
    // the boot scan has interrupted every running task. Withdraw each pending
    // steer here, so the boot loop over pending requests never places it.
    const steers = this.store.all<{
      conversationId: string;
      requestId: string;
    }>(
      "SELECT conversationId, requestId FROM requests WHERE source=? AND status='pending'",
      DURABLE_TASK_STEER_SOURCE,
    );
    if (!tasks.length && !steers.length) return;
    const { harness } = this.execution.runtime;
    const { tasks: live, submissions } = await harness.inspect(context);
    const runs = new Map(
      tasks.map((task) => [task.runConversationId, requestIdFor(task)]),
    );
    const steered = new Set(
      steers.map((row) => JSON.stringify([row.conversationId, row.requestId])),
    );
    // Mark and withdraw before anything can enable the harness scheduler.
    for (const submission of submissions)
      if (
        submission.requestId &&
        (runs.get(String(submission.conversationId)) === submission.requestId ||
          steered.has(
            JSON.stringify([
              String(submission.conversationId),
              submission.requestId,
            ]),
          ))
      )
        await harness.abortSubmission(
          submission.id,
          context,
          submission.conversationId,
        );
    for (const { record } of live)
      if (runs.has(String(record.conversationId)))
        await harness.abortTask(record.id, context);
    for (const [runId, requestId] of runs)
      this.store.run(
        `UPDATE requests SET status='unanswered'
         WHERE conversationId=? AND requestId=? AND source='task' AND status='pending'`,
        runId,
        requestId,
      );
    for (const { conversationId, requestId } of steers)
      this.store.run(
        `UPDATE requests SET status='unanswered'
         WHERE conversationId=? AND requestId=? AND source=? AND status='pending'`,
        conversationId,
        requestId,
        DURABLE_TASK_STEER_SOURCE,
      );
  }
}

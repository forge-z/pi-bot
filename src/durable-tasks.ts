import { randomUUID } from "node:crypto";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Conversation, SubmissionId } from "@earendil-works/pi-durable";
import type { DurableTaskConfig } from "./harness-config.js";
import { logFailure } from "./log.js";
import { settleFailureReason, type Runtime } from "./runtime.js";
import type { Store } from "./store.js";

export const DURABLE_TASK_GOAL_MAX = 4000;

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
  running: ["done", "queued", "interrupted"],
  interrupted: [],
  ready_for_review: [],
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
};
const MAX_TIMER_MS = 2_147_483_647;
const BUDGET_TIMEOUT = "budget_timeout";

type Execution = {
  runtime: Pick<
    Runtime,
    "create" | "conversation" | "submit" | "harness" | "withProviderAdmission"
  >;
  config: DurableTaskConfig;
};
type Attempt = DurableTask & { deadlineAt: number };
type Outcome =
  | { kind: "done" }
  | { kind: "budget"; error: string }
  | { kind: "failure"; error: string };

function requestIdFor(task: Pick<DurableTask, "id" | "attempts">) {
  return `durable-task:${task.id}:${task.attempts}`;
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
      "UPDATE durable_tasks SET state=?,updatedAt=?,lastError=? WHERE conversationId=? AND id=? AND state=? RETURNING *",
      state,
      this.clock(),
      lastError,
      conversationId,
      id,
      prior.state,
    );
    if (!updated)
      throw new DurableTaskError("Durable task changed before transition");
    return updated;
  }

  async tick() {
    if (
      !this.execution ||
      this.shutdown.signal.aborted ||
      this.settlement ||
      this.store.credentialMutation
    )
      return;
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
      if (result.status === "done") outcome = { kind: "done" };
      else if (result.reason === "turn_limit")
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
    const now = this.clock();
    const retry =
      outcome.kind === "failure" && task.attempts < task.maxAttempts;
    const state =
      outcome.kind === "done" ? "done" : retry ? "queued" : "interrupted";
    this.store.run(
      `UPDATE durable_tasks SET state=?, updatedAt=?, lastError=?, nextRun=?
       WHERE id=? AND state='running' AND attempts=?`,
      state,
      now,
      outcome.kind === "done" ? null : outcome.error,
      retry ? now + Math.min(60_000 * task.attempts, 3_600_000) : null,
      task.id,
      task.attempts,
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
    if (!tasks.length) return;
    const { harness } = this.execution.runtime;
    const { tasks: live, submissions } = await harness.inspect(context);
    const runs = new Map(
      tasks.map((task) => [task.runConversationId, requestIdFor(task)]),
    );
    // Mark and withdraw before anything can enable the harness scheduler.
    for (const submission of submissions)
      if (
        submission.requestId &&
        runs.get(String(submission.conversationId)) === submission.requestId
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
  }
}

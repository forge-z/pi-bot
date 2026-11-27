import { randomUUID } from "node:crypto";
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

// Slice 5a permits only recovery transitions.
const TRANSITIONS: Record<DurableTaskState, readonly DurableTaskState[]> = {
  queued: ["interrupted"],
  running: ["interrupted"],
  interrupted: [],
  ready_for_review: [],
  done: [],
  cancelled: [],
};

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
}

export class DurableTasks {
  constructor(
    private store: Store,
    private clock = () => Date.now(),
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
    if (
      !store
        .all<{ name: string }>("PRAGMA table_info(durable_tasks)")
        .some((column) => column.name === "creationKey")
    )
      store.db.exec("ALTER TABLE durable_tasks ADD COLUMN creationKey TEXT");
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
}

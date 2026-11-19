/** One note every 30 seconds, and three notes per user turn. */
export const PROGRESS_INTERVAL_MS = 30_000;
export const PROGRESS_MAX_NOTES = 3;

/**
 * When a user turn may speak before it ends. The same text is a system section
 * on every turn, including a scheduled run, so the prefix stays stable. The
 * last sentence keeps that run on `notify`.
 */
export const PROGRESS_RULE =
  "On a long task (more than one step, or work that will take a while), call progress once immediately, before any other tool, with one short sentence that names the first step. After that, call progress only for a real milestone: a result, a blocker, or a changed plan. Do not narrate each step. A quick reply, a greeting, or a one-step answer does not call progress. The final answer is delivered on its own when the turn ends; do not put it in progress. Scheduled and system turns do not call progress; they stay silent unless they call notify.";

export interface ProgressBudget {
  sent: number;
  lastAt: number;
}

/**
 * Whether this note may go out. A first note is always allowed. The next one
 * waits out the interval, and the cap refuses the rest of the task.
 */
export function admitProgress(
  budget: ProgressBudget | undefined,
  now: number,
  limits: { intervalMs: number; maxNotes: number } = {
    intervalMs: PROGRESS_INTERVAL_MS,
    maxNotes: PROGRESS_MAX_NOTES,
  },
):
  | { ok: true; budget: ProgressBudget }
  | { ok: false; reason: "interval" | "cap" } {
  const sent = budget?.sent ?? 0;
  if (sent >= limits.maxNotes) return { ok: false, reason: "cap" };
  if (budget && now - budget.lastAt < limits.intervalMs)
    return { ok: false, reason: "interval" };
  return { ok: true, budget: { sent: sent + 1, lastAt: now } };
}

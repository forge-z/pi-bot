/** Stateless persistent-goal helpers: command parsing and the one fixed
 * read-only GitHub observer. All durable goal state lives in Tasks
 * (src/tasks.ts); nothing here owns a timer, store or runner. */

export const GOAL_INTERVAL_MIN = 10;
export const GOAL_INTERVAL_MAX = 1440;
export const GOAL_ATTEMPTS_MAX = 200;
/** The observer is read-only; one PR payload is far below this cap. */
export const GOAL_MAX_BYTES = 262144;
const GOAL_TIMEOUT_MS = 10_000;

export class GoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalError";
  }
}

export interface GoalTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

export type GoalFetcher = (url: string, init: RequestInit) => Promise<Response>;

export type PrObservation =
  | { kind: "merged" }
  | { kind: "closed_unmerged" }
  | { kind: "open" }
  /** Transient: never completion or terminal proof on its own. */
  | { kind: "retry"; reason: string };

/** Parse and normalize the `/goal` target argument: `owner/repo#123`. */
export function parseGoalTarget(value: string): GoalTarget {
  const match =
    /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)#([1-9][0-9]{0,8})$/.exec(
      value,
    );
  if (!match || /([._-])\1|\.\.|-\.|\.--/.test(value))
    throw new GoalError(
      "Invalid target: use owner/repo#number with a positive PR number.",
    );
  return {
    owner: match[1]!.toLowerCase(),
    repo: match[2]!.toLowerCase(),
    prNumber: Number(match[3]),
  };
}

function bounded(value: string, min: number, max: number, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new GoalError(
      `Invalid ${label}: use a whole number from ${min} to ${max}.`,
    );
  return parsed;
}

export type GoalCommand =
  | { action: "help" }
  | { action: "list" }
  | { action: "cancel"; index: number }
  | {
      action: "create";
      target: GoalTarget;
      intervalMin: number;
      maxAttempts: number;
    };

export const GOAL_HELP = [
  "Persistent goals check one public GitHub PR on a fixed schedule.",
  "/goal pr owner/repo#123 <minutes 10-1440> <max checks 1-200> — notify this chat when the PR is merged.",
  "/goal list — goals in this chat with status, next check and attempts.",
  "/goal cancel <number> — stop a goal. No further checks or messages.",
  "Only a merged PR completes a goal; a closed-unmerged PR or exhausted checks block it.",
].join("\n");

/** Parse the literal `/goal` arguments; malformed input throws GoalError. */
export function parseGoalCommand(args: string): GoalCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { action: "help" };
  if (parts[0] === "list" && parts.length === 1) return { action: "list" };
  if (parts[0] === "cancel" && parts.length === 2) {
    const index = Number(parts[1]);
    if (!Number.isInteger(index) || index < 1)
      throw new GoalError("Invalid goal number. Use /goal list.");
    return { action: "cancel", index };
  }
  if (parts[0] !== "pr" || parts.length !== 4)
    throw new GoalError(`Invalid goal request.\n${GOAL_HELP}`);
  const target = parseGoalTarget(parts[1]!);
  const intervalMin = bounded(
    parts[2]!,
    GOAL_INTERVAL_MIN,
    GOAL_INTERVAL_MAX,
    "minutes",
  );
  const maxAttempts = bounded(parts[3]!, 1, GOAL_ATTEMPTS_MAX, "max checks");
  return { action: "create", target, intervalMin, maxAttempts };
}

const PR_FIELDS = "GitHub answer was not a pull request";

/**
 * The one deterministic observer: a single explicit GET of the canonical
 * public PR endpoint. Redirects are refused, the answer must be HTTP 200,
 * and the body is read incrementally through Response.body.getReader()
 * with a strict pre-JSON byte cap — never Content-Length, never response.json().
 * Only validated `merged === true` on the exact PR identity completes the
 * goal; every other answer stays transient. Reasons are fixed strings:
 * raw body or network error text never reaches the chat.
 */
export async function observePrMerged(
  target: GoalTarget,
  fetcher: GoalFetcher,
  timeoutMs = GOAL_TIMEOUT_MS,
): Promise<PrObservation> {
  const url = `https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`;
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "pi-bot-persistent-goal",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { kind: "retry", reason: `GitHub answered ${response.status}` };
    }
    if (!response.body)
      return { kind: "retry", reason: "GitHub answer had no bounded body" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.byteLength;
      if (total > GOAL_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: "retry", reason: "GitHub answer was too large" };
      }
      chunks.push(value!);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return { kind: "retry", reason: PR_FIELDS };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return { kind: "retry", reason: PR_FIELDS };
    const pr = payload as Record<string, unknown>;
    if (pr.number !== target.prNumber)
      return { kind: "retry", reason: "GitHub answer named a different PR" };
    const base = pr.base as Record<string, unknown> | undefined;
    const repo = (base?.repo as Record<string, unknown> | undefined)?.full_name;
    if (
      typeof repo !== "string" ||
      repo.toLowerCase() !== `${target.owner}/${target.repo}`
    )
      return {
        kind: "retry",
        reason: "GitHub answer named a different repository",
      };
    if (pr.merged === true) return { kind: "merged" };
    if (pr.merged === false && pr.state === "closed")
      return { kind: "closed_unmerged" };
    if (pr.merged === false && pr.state === "open") return { kind: "open" };
    return { kind: "retry", reason: "GitHub answer had no definite PR state" };
  } catch {
    // Timeouts, aborts and network faults: transient, with no error text kept.
    return { kind: "retry", reason: "GitHub could not be reached" };
  }
}

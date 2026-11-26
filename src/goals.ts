/** Stateless persistent-goal helpers: command parsing and the one fixed
 * read-only GitHub observer. All durable goal state lives in Tasks
 * (src/tasks.ts); nothing here owns a timer, store or runner. */

// GitHub allows 60 unauthenticated requests/hour per IP, shared by every goal
// on the volume. A 60-minute check is 1 request/hour, so up to 60 simultaneous
// goals stay under that limit. Only new creations are bounded: a goal stored
// with a shorter interval keeps its cadence.
export const GOAL_INTERVAL_MIN = 60; // 60 min = 1 request/hour per goal.
export const GOAL_INTERVAL_MAX = 1440;
export const GOAL_ATTEMPTS_MAX = 200;
/** A free objective is the prompt of its goal round; keep it a sentence, not a document. */
export const GOAL_OBJECTIVE_MAX = 2000;
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
  /** HTTP 403/429: GitHub refused the read; it never counts as an attempt. */
  | { kind: "rate_limited" }
  /** HTTP 404: the PR does not exist, was renamed, or became private. */
  | { kind: "not_found" }
  /** Transient: never completion or terminal proof on its own. */
  | { kind: "retry"; reason: string };

const REPO_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
/** No `..`, `--`, `._` runs; shared by the structured and natural forms. */
const BAD_REPO_CHARS = /([._-])\1|\.\.|-\.|\.--/;
const GOAL_TARGET = new RegExp(
  `^(${REPO_SEGMENT})/(${REPO_SEGMENT})#([1-9][0-9]{0,8})$`,
);

/** Parse and normalize the `/goal` target argument: `owner/repo#123`. */
export function parseGoalTarget(value: string): GoalTarget {
  const match = GOAL_TARGET.exec(value);
  if (!match || BAD_REPO_CHARS.test(value))
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
  | { action: "check"; index: number }
  | {
      action: "create";
      target: GoalTarget;
      intervalMin: number;
      maxAttempts: number;
    }
  /** A free condition: a scheduled model round checks it until it happens. */
  | {
      action: "objective";
      objective: string;
      intervalMin: number;
      maxAttempts: number;
    };

export const GOAL_HELP = [
  "Persistent goals stay silent until something happens, tell you once, and end.",
  "/goal avise quando o relatório aparecer no Drive a cada 2 horas — any condition, checked by the assistant on that schedule.",
  "/goal acompanhe https://github.com/forge-z/pi-bot/pulls a cada 1 hora ate a PR #66 ser publicada. — a public GitHub PR is checked directly, with no model round.",
  `/goal pr owner/repo#123 <minutes ${GOAL_INTERVAL_MIN}-${GOAL_INTERVAL_MAX}> <max checks 1-${GOAL_ATTEMPTS_MAX}> — the structured PR form, still fully supported.`,
  "/goal list — goals in this chat with status, next check and attempts.",
  "/goal check <number> — check that goal once now; it does not count as an attempt.",
  "/goal cancel <number> — stop a goal. No further checks or messages.",
  "Only a merged PR completes a PR goal; a closed-unmerged PR or exhausted checks block it. Any goal is blocked when its checks run out.",
].join("\n");

/** Parse the literal `/goal` arguments; malformed input throws GoalError. */
export function parseGoalCommand(args: string): GoalCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { action: "help" };
  if (parts[0] === "list") {
    if (parts.length === 1) return { action: "list" };
    throw new GoalError(`Invalid goal request.\n${GOAL_HELP}`);
  }
  // `check` is a control word like `cancel`: it never reaches the
  // natural-language parser, so it can never be read as a new goal.
  if (parts[0] === "cancel" || parts[0] === "check") {
    if (parts.length === 2) {
      const index = Number(parts[1]);
      if (!Number.isInteger(index) || index < 1)
        throw new GoalError("Invalid goal number. Use /goal list.");
      return { action: parts[0], index };
    }
    throw new GoalError(`Invalid goal request.\n${GOAL_HELP}`);
  }
  if (parts[0] === "pr") {
    if (parts.length !== 4)
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
  return parseNaturalGoal(args);
}

function collectNaturalTarget(text: string): {
  repos: Set<string>;
  prs: Set<number>;
  bareHash: number | null;
  text: string;
} {
  const repos = new Set<string>();
  const prs = new Set<number>();
  let bareHash: number | null = null;
  // Consume every http(s) URL first so their digits are never re-read.
  const stripped = text.replace(/\bhttps?:\/\/\S+/gi, (raw) => {
    const clean = raw.replace(/[.,;:!?\)\]\}'"]+$/u, "");
    let url: URL;
    try {
      url = new URL(clean);
    } catch {
      return " ";
    }
    // Prose links to other sites stay harmless and unread.
    if (!/\/pull/.test(url.pathname) && !/github/i.test(url.hostname))
      return " ";
    if (url.protocol !== "https:")
      throw new GoalError(
        "Invalid goal request: use an https://github.com link, not http.",
      );
    if (url.username || url.password)
      throw new GoalError(
        "Invalid goal request: links with credentials are not accepted.",
      );
    if (url.hostname !== "github.com")
      throw new GoalError(
        `Invalid goal request: only https://github.com links are accepted, not "${url.hostname}".`,
      );
    const repo = new RegExp(
      `^/(${REPO_SEGMENT})/(${REPO_SEGMENT})(?:/|$)`,
    ).exec(url.pathname);
    if (repo && !BAD_REPO_CHARS.test(`${repo[1]}/${repo[2]}`))
      repos.add(`${repo[1]}/${repo[2]}`.toLowerCase());
    const pull = /^\/[^/]+\/[^/]+\/pull\/([1-9][0-9]{0,8})(?:\/|$)/.exec(
      url.pathname,
    );
    if (pull) prs.add(Number(pull[1]));
    return " ";
  });
  const withoutRefs = stripped.replace(
    new RegExp(
      `\\b(${REPO_SEGMENT})/(${REPO_SEGMENT})#([1-9][0-9]{0,8})\\b`,
      "g",
    ),
    (_match, owner: string, repo: string, pr: string) => {
      try {
        const target = parseGoalTarget(`${owner}/${repo}#${pr}`);
        repos.add(`${target.owner}/${target.repo}`);
        prs.add(target.prNumber);
      } catch {
        throw new GoalError(
          "Invalid goal request: use owner/repo#number with a valid repository name and a positive PR number.",
        );
      }
      return " ";
    },
  );
  const withoutPr = withoutRefs.replace(
    /\bpr\s*#?\s*([1-9][0-9]{0,8})\b/gi,
    (_match, pr: string) => {
      prs.add(Number(pr));
      return " ";
    },
  );
  const rest = withoutPr.replace(
    /#([1-9][0-9]{0,8})\b/g,
    (_match, pr: string) => {
      if (repos.size) prs.add(Number(pr));
      else if (bareHash === null) bareHash = Number(pr);
      return " ";
    },
  );
  return { repos, prs, bareHash, text: rest };
}

const INTERVAL_RE =
  /\b(?:a\s+cada|cada|every)\s+([0-9]{1,4})\s+(minutos?|minutes?|min|horas?|hours?)\b|\b([0-9]{1,4})\s+em\s+([0-9]{1,4})\s+(minutos?|min|horas?)\b/gi;
// Whole numbers only: an out-of-range cap reaches bounded() and is refused,
// never truncated to its first digits or dropped to the default.
const MAX_RE =
  /\bat[eé]\s+([0-9][0-9.]*)\s+(?:verifica[çc][õo]es|checagens|checks)\b|\bno\s+m[áa]ximo\s+([0-9][0-9.]*)(?:\s*(?:x|vezes))?\b|\bmax(?:imum)?\s+([0-9][0-9.]*)(?:\s*(?:x|vezes))?\b/gi;

/** Deterministic fallback: parse a natural-language /goal request, no LLM.
 * Any GitHub PR signal (a repository link, owner/repo#N, "PR 12", a bare #N)
 * keeps the PR goal and its refusals; only text with none of them becomes a
 * free objective, so a half-written PR request is refused, never reread. */
function parseNaturalGoal(args: string): GoalCommand {
  const { repos, prs, bareHash, text } = collectNaturalTarget(args);
  if (!repos.size && !prs.size && bareHash === null)
    return parseObjectiveGoal(args);
  if (repos.size > 1) {
    const [a, b] = [...repos];
    throw new GoalError(
      `Invalid goal request: conflicting repositories (${a} and ${b}). Name exactly one repository.`,
    );
  }
  if (prs.size > 1) {
    const [a, b] = [...prs].sort((x, y) => x - y);
    throw new GoalError(
      `Invalid goal request: conflicting PR numbers (#${a} and #${b}). Name exactly one PR.`,
    );
  }
  if (prs.size === 0) {
    if (bareHash !== null)
      throw new GoalError(
        `Invalid goal request: "#${bareHash}" needs a repository. Write OWNER/REPO#${bareHash} or include the PR link.`,
      );
    throw new GoalError(
      "Invalid goal request: no GitHub PR found. Include a link like https://github.com/OWNER/REPO/pull/123 or OWNER/REPO#123.",
    );
  }
  if (repos.size === 0) {
    const [pr] = [...prs];
    throw new GoalError(
      `Invalid goal request: no repository found for PR #${pr}. Write OWNER/REPO#${pr} or include the PR link.`,
    );
  }
  const { intervalMin, maxAttempts } = parseCadence(text);
  const [[owner, repo]] = [...repos].map((pair) => pair.split("/"));
  const [prNumber] = [...prs];
  return {
    action: "create",
    target: { owner: owner!, repo: repo!, prNumber: prNumber! },
    intervalMin,
    maxAttempts,
  };
}

/** A free objective: the sentence minus its cadence and cap is the prompt. */
function parseObjectiveGoal(args: string): GoalCommand {
  const objective = args
    .replace(INTERVAL_RE, " ")
    .replace(MAX_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,;:.—–-]+|[\s,;:.—–-]+$/g, "");
  if (!/[\p{L}\p{N}]/u.test(objective))
    throw new GoalError(
      `Invalid goal request: no objective found. Say what to watch for, e.g. "/goal avise quando o relatório aparecer no Drive a cada 2 horas".`,
    );
  if (objective.length > GOAL_OBJECTIVE_MAX)
    throw new GoalError(
      `Invalid goal request: the objective is too long (maximum ${GOAL_OBJECTIVE_MAX} characters).`,
    );
  const { intervalMin, maxAttempts } = parseCadence(args);
  return { action: "objective", objective, intervalMin, maxAttempts };
}

/** One interval (required, within the creation bounds) and an optional cap. */
function parseCadence(text: string) {
  const intervals = new Set<number>();
  for (const match of text.matchAll(INTERVAL_RE)) {
    if (match[1] !== undefined)
      intervals.add(Number(match[1]) * (/^h/i.test(match[2]!) ? 60 : 1));
    else if (match[3] === match[4])
      intervals.add(Number(match[3]) * (/^h/i.test(match[5]!) ? 60 : 1));
  }
  if (intervals.size === 0)
    throw new GoalError(
      `Invalid goal request: no check interval found. Say how often to check, e.g. "a cada 1 hora" or "every 2 hours" (${GOAL_INTERVAL_MIN} to ${GOAL_INTERVAL_MAX} minutes).`,
    );
  if (intervals.size > 1) {
    const [a, b] = [...intervals].sort((x, y) => x - y);
    throw new GoalError(
      `Invalid goal request: conflicting check intervals (${a} and ${b} minutes). Name one interval.`,
    );
  }
  const [intervalRaw] = [...intervals];
  const intervalMin = bounded(
    String(intervalRaw),
    GOAL_INTERVAL_MIN,
    GOAL_INTERVAL_MAX,
    "minutes",
  );
  const maxes = new Set<number>();
  for (const match of text.matchAll(MAX_RE))
    // Dots are thousands separators here: 1.000 becomes 1000 and is refused,
    // never silently read as 1.
    maxes.add(Number((match[1] ?? match[2] ?? match[3]).replaceAll(".", "")));
  if (maxes.size > 1) {
    const [a, b] = [...maxes].sort((x, y) => x - y);
    throw new GoalError(
      `Invalid goal request: conflicting maximum check counts (${a} and ${b}). Name one limit.`,
    );
  }
  const maxAttempts = maxes.size
    ? bounded(String([...maxes][0]), 1, GOAL_ATTEMPTS_MAX, "max checks")
    : GOAL_ATTEMPTS_MAX;
  return { intervalMin, maxAttempts };
}

const PR_FIELDS = "GitHub answer was not a pull request";

/**
 * The one deterministic observer: a single explicit GET of the canonical
 * public PR endpoint. Redirects are refused, the answer must be HTTP 200,
 * and the body is read incrementally through Response.body.getReader()
 * with a strict pre-JSON byte cap — never Content-Length, never response.json().
 * Only validated `merged === true` on the exact PR identity completes the
 * goal. HTTP 403/429 is `rate_limited` and HTTP 404 is `not_found`; every
 * other answer stays transient. Reasons are fixed strings:
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
      if (response.status === 403 || response.status === 429)
        return { kind: "rate_limited" };
      if (response.status === 404) return { kind: "not_found" };
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

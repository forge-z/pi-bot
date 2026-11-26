/** Stateless persistent-goal helpers: command parsing and the one fixed
 * read-only GitHub observer. All durable goal state lives in Tasks
 * (src/tasks.ts); nothing here owns a timer, store or runner. */

export const GOAL_INTERVAL_MIN = 5;
// 5 min = 12 requests/hour, below GitHub's 60/hour unauthenticated limit.
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
  "/goal acompanhe https://github.com/forge-z/pi-bot/pulls a cada 5 minutos ate a PR #66 ser publicada. — natural language works too.",
  "/goal pr owner/repo#123 <minutes 5-1440> <max checks 1-200> — the structured form, still fully supported.",
  "/goal list — goals in this chat with status, next check and attempts.",
  "/goal cancel <number> — stop a goal. No further checks or messages.",
  "Only a merged PR completes a goal; a closed-unmerged PR or exhausted checks block it.",
].join("\n");

/** Parse the literal `/goal` arguments; malformed input throws GoalError. */
export function parseGoalCommand(args: string): GoalCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { action: "help" };
  if (parts[0] === "list") {
    if (parts.length === 1) return { action: "list" };
    throw new GoalError(`Invalid goal request.\n${GOAL_HELP}`);
  }
  if (parts[0] === "cancel") {
    if (parts.length === 2) {
      const index = Number(parts[1]);
      if (!Number.isInteger(index) || index < 1)
        throw new GoalError("Invalid goal number. Use /goal list.");
      return { action: "cancel", index };
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

const REPO_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
/** Same character rule as parseGoalTarget: no `..`, `--`, `._` runs. */
const BAD_REPO_CHARS = /([._-])\1|\.\.|-\.|\.--/;

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
const MAX_RE =
  /\bate\s+([0-9]{1,3})\s+(?:verifica[çc][õo]es|checagens|checks)\b|\bno\s+m[áa]ximo\s+([0-9]{1,3})|\bmax(?:imum)?\s+([0-9]{1,3})\b/gi;

/** Deterministic fallback: parse a natural-language /goal request, no LLM. */
function parseNaturalGoal(args: string): GoalCommand {
  const { repos, prs, bareHash, text } = collectNaturalTarget(args);
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
  const intervals = new Set<number>();
  for (const match of text.matchAll(INTERVAL_RE)) {
    if (match[1] !== undefined)
      intervals.add(Number(match[1]) * (/^h/i.test(match[2]!) ? 60 : 1));
    else if (match[3] === match[4])
      intervals.add(Number(match[3]) * (/^h/i.test(match[5]!) ? 60 : 1));
  }
  if (intervals.size === 0)
    throw new GoalError(
      'Invalid goal request: no check interval found. Say how often to check, e.g. "a cada 5 minutos" or "every 5 minutes" (5 to 1440 minutes).',
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
    maxes.add(Number(match[1] ?? match[2] ?? match[3]));
  if (maxes.size > 1) {
    const [a, b] = [...maxes].sort((x, y) => x - y);
    throw new GoalError(
      `Invalid goal request: conflicting maximum check counts (${a} and ${b}). Name one limit.`,
    );
  }
  const maxAttempts = maxes.size
    ? bounded(String([...maxes][0]), 1, GOAL_ATTEMPTS_MAX, "max checks")
    : GOAL_ATTEMPTS_MAX;
  const [[owner, repo]] = [...repos].map((pair) => pair.split("/"));
  const [prNumber] = [...prs];
  return {
    action: "create",
    target: { owner: owner!, repo: repo!, prNumber: prNumber! },
    intervalMin,
    maxAttempts,
  };
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

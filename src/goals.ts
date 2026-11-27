/** Stateless persistent-goal helpers: command parsing and the one fixed
 * read-only GitHub observer. All durable goal state lives in Tasks
 * (src/tasks.ts); nothing here owns a timer, store or runner. */

import { assistantTimeZone } from "./runtime.js";

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
      /** Explicit end time in epoch ms; present only when the user stated one. */
      endAt?: number;
    };

export const GOAL_HELP = [
  "Persistent goals stay silent until something happens, tell you once, and end.",
  "/goal avise quando o relatório aparecer no Drive a cada 2 horas — any condition, checked by the assistant on that schedule.",
  "/goal avise quando chover a cada 2 horas no maximo 20 checagens ate 30/11 — an explicit check limit and end time are understood and enforced; without them a goal runs up to " +
    GOAL_ATTEMPTS_MAX +
    " checks.",
  "/goal acompanhe https://github.com/forge-z/pi-bot/pulls a cada 1 hora ate a PR #66 ser publicada. — a public GitHub PR is checked directly, with no model round.",
  `/goal pr owner/repo#123 <minutes ${GOAL_INTERVAL_MIN}-${GOAL_INTERVAL_MAX}> <max checks 1-${GOAL_ATTEMPTS_MAX}> — the structured PR form, still fully supported.`,
  "/goal list — goals in this chat with status, next check and attempts.",
  "/goal check <number> — check that goal once now; it does not count as an attempt.",
  "/goal cancel <number> — stop a goal. No further checks or messages.",
  "Only a merged PR completes a PR goal; a closed-unmerged PR or exhausted checks block it. Any goal is blocked when its checks run out or its end time is reached.",
].join("\n");

/** Parse the literal `/goal` arguments; malformed input throws GoalError. */
export function parseGoalCommand(args: string, now = Date.now()): GoalCommand {
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
  return parseNaturalGoal(args, now);
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
// never truncated to its first digits or dropped to the default. Every
// alternative captures its number: `ate N`, `N no maximo`, `no maximo N`,
// `at most N`, `max N`, each with an optional unit. No number, no limit.
const MAX_RE = new RegExp(
  [
    String.raw`\bat[eé]\s+([0-9][0-9.]*)\s+(?:verifica[çc][õo]es|checagens?|checks?)\b`,
    String.raw`\b([0-9][0-9.]*)\s+(?:verifica[çc][õo]es|checagens?|checks?)\s+no\s+m[áa]ximo\b`,
    String.raw`\bno\s+m[áa]ximo\s+([0-9][0-9.]*)(?:\s*(?:x|vezes|checagens?|checks?|verifica[çc][õo]es))?\b`,
    String.raw`\bat\s+most\s+([0-9][0-9.]*)(?:\s*(?:x|vezes|checagens?|checks?|verifica[çc][õo]es))?\b`,
    String.raw`\bmax(?:imum)?\s+([0-9][0-9.]*)(?:\s*(?:x|vezes|checagens?|checks?|verifica[çc][õo]es))?\b`,
  ].join("|"),
  "gi",
);
/** An explicit end time: an ISO date (2026-12-05), a day/month date (30/11)
 * or a `por N dias|horas` duration, each with an optional ate/until. */
const END_DATE_RE =
  /(?:\bate[eé]?\s+|\buntil\s+)\b([0-9]{4})-([0-9]{2})-([0-9]{2})\b|(?:\bate[eé]?\s+|\buntil\s+)\b([0-9]{1,2})\/([0-9]{1,2})\b/g;
const END_DURATION_RE = /\bpor\s+([0-9]{1,4})\s+(dias?|horas?)\b/gi;

/** Zone offset of `at` (ms), from the zone's wall clock read back as UTC. */
function zoneOffsetMs(timeZone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)!.value);
  return (
    Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    ) -
    Math.floor(at / 1000) * 1000
  );
}

/** Last instant of a calendar day in a zone, in epoch ms; null when that day
 * does not exist (e.g. 31/02). */
export function goalEndOfDay(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): number | null {
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  const nextMidnight = Date.UTC(year, month - 1, day + 1);
  let end = nextMidnight;
  // Two passes settle any offset change between the guess and midnight.
  for (let pass = 0; pass < 2; pass += 1)
    end = nextMidnight - zoneOffsetMs(timeZone, end);
  return end - 1;
}

/** The calendar date an end timestamp names, YYYY-MM-DD in the bot timezone. */
export function formatGoalEnd(endAt: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: assistantTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(endAt);
}

/** One explicit end time, as epoch ms, and the phrases that resolved to it.
 * Weekday names, phrases without a number and impossible dates are not end
 * times: nothing is invented and their words stay in the objective. */
function parseGoalEnd(text: string, now: number) {
  const timeZone = assistantTimeZone();
  const ends = new Set<number>();
  const phrases: string[] = [];
  for (const match of text.matchAll(END_DATE_RE)) {
    const [whole, iso, isoMonth, isoDay, day, month] = match;
    let end: number | null;
    if (iso !== undefined)
      end = goalEndOfDay(timeZone, Number(iso), Number(isoMonth), Number(isoDay));
    else {
      // Brazilian day/month order, resolved to the next occurrence.
      const year = Number(
        new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(
          now,
        ),
      );
      end =
        goalEndOfDay(timeZone, year, Number(month), Number(day)) ??
        goalEndOfDay(timeZone, year + 1, Number(month), Number(day));
      if (end !== null && end < now)
        end = goalEndOfDay(timeZone, year + 1, Number(month), Number(day));
    }
    if (end === null) continue;
    ends.add(end);
    phrases.push(whole);
  }
  for (const match of text.matchAll(END_DURATION_RE)) {
    ends.add(
      now +
        (/^h/i.test(match[2]!)
          ? Number(match[1]) * 3_600_000
          : Number(match[1]) * 86_400_000),
    );
    phrases.push(match[0]);
  }
  if (ends.size > 1)
    throw new GoalError(
      "Invalid goal request: conflicting end times. Name exactly one end time.",
    );
  const endAt = ends.size ? [...ends][0]! : null;
  if (endAt !== null && endAt < now)
    throw new GoalError(
      "Invalid goal request: the end time is already in the past.",
    );
  return { endAt, phrases: endAt === null ? [] : phrases };
}

/** Deterministic fallback: parse a natural-language /goal request, no LLM.
 * Any GitHub PR signal (a repository link, owner/repo#N, "PR 12", a bare #N)
 * keeps the PR goal and its refusals; only text with none of them becomes a
 * free objective, so a half-written PR request is refused, never reread. */
function parseNaturalGoal(args: string, now: number): GoalCommand {
  const { repos, prs, bareHash, text } = collectNaturalTarget(args);
  if (!repos.size && !prs.size && bareHash === null)
    return parseObjectiveGoal(args, now);
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

/** A free objective: the sentence minus its cadence and its recognized limit
 * phrases is the prompt. Extraction never rewords: unmatched words stay. */
function parseObjectiveGoal(args: string, now: number): GoalCommand {
  const { endAt, phrases } = parseGoalEnd(args, now);
  let objective = args.replace(INTERVAL_RE, " ").replace(MAX_RE, " ");
  // Only phrases that resolved to the end time leave the objective.
  for (const phrase of phrases) objective = objective.replace(phrase, " ");
  objective = objective
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
  return endAt === null
    ? { action: "objective", objective, intervalMin, maxAttempts }
    : { action: "objective", objective, intervalMin, maxAttempts, endAt };
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
    maxes.add(
      Number(
        match.slice(1).find((group) => group !== undefined)!.replaceAll(".", ""),
      ),
    );
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

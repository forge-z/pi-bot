import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GOAL_ATTEMPTS_MAX,
  GOAL_INTERVAL_MAX,
  GOAL_INTERVAL_MIN,
  parseGoalCommand,
} from "../src/goals.js";

/** Expected `create` result for the forge-z/pi-bot fixtures. */
const created = (
  prNumber: number,
  intervalMin: number,
  maxAttempts = 200,
  owner = "forge-z",
  repo = "pi-bot",
) => ({
  action: "create" as const,
  target: { owner, repo, prNumber },
  intervalMin,
  maxAttempts,
});

test("the user's literal sentence parses into a full create command", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe o https://github.com/forge-z/pi-bot/pulls a cada 5 minutos ate a PR #66 ser publicada.",
    ),
    created(66, 5),
  );
});

test("a direct pull URL with 'a cada 10 minutos' yields PR 66 every 10 minutes", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 10 minutos",
    ),
    created(66, 10),
  );
});

test("two different PR numbers are refused, never picked", () => {
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://github.com/forge-z/pi-bot/pull/67 e o #66 a cada 5 minutos",
      ),
    /conflict/i,
  );
});

test("two different repositories are refused, never picked", () => {
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://github.com/forge-z/pi-bot/pull/66 e https://github.com/octocat/hello-world/pull/66 a cada 5 minutos",
      ),
    /conflict/i,
  );
});

test("a non-github host in a PR-like link is refused", () => {
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://evil.com/forge-z/pi-bot/pull/66 a cada 5 minutos",
      ),
    /github\.com|host/i,
  );
});

test("plain http github links are refused; https is required", () => {
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe http://github.com/forge-z/pi-bot/pull/66 a cada 5 minutos",
      ),
    /https|http/i,
  );
});

test("a missing interval is an actionable error", () => {
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://github.com/forge-z/pi-bot/pull/66 ate a PR ser publicada",
      ),
    /interval/i,
  );
});

test("intervals below 5 or above 1440 minutes are refused", () => {
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 4 minutos",
      ),
    /5 to 1440|minute/i,
  );
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 2000 minutos",
      ),
    /5 to 1440|minute/i,
  );
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 5 minutos",
    ),
    created(66, 5),
  );
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 1440 minutos",
    ),
    created(66, 1440),
  );
});

test("'de 10 em 10 minutos' means every 10 minutes", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 de 10 em 10 minutos",
    ),
    created(66, 10),
  );
});

test("'every 15 minutes' is accepted", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 every 15 minutes",
    ),
    created(66, 15),
  );
});

test("hours are converted to minutes", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 1 hora",
    ),
    created(66, 60),
  );
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 2 horas",
    ),
    created(66, 120),
  );
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 every 3 hours",
    ),
    created(66, 180),
  );
});

test("explicit check limits override the default of 200", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 5 minutos no maximo 50 verificacoes",
    ),
    created(66, 5, 50),
  );
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 5 minutos ate 10 checagens",
    ),
    created(66, 5, 10),
  );
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 5 minutos, max 7",
    ),
    created(66, 5, 7),
  );
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 5 minutos no maximo 0",
      ),
    /1 to 200|checks/i,
  );
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://github.com/forge-z/pi-bot/pull/66 a cada 5 minutos max 201",
      ),
    /1 to 200|checks/i,
  );
});

test("text with no PR reference at all is refused", () => {
  assert.throws(
    () => parseGoalCommand("acompanhe o deploy a cada 5 minutos"),
    /PR/i,
  );
});

test("a bare #66 without any repository is refused", () => {
  assert.throws(
    () => parseGoalCommand("acompanhe #66 a cada 5 minutos"),
    /repository/i,
  );
});

test("a bare #66 counts when a repository was already identified", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pulls e o #66 a cada 5 minutos",
    ),
    created(66, 5),
  );
});

test("the OWNER/REPO#N form works anywhere in the sentence", () => {
  assert.deepEqual(
    parseGoalCommand("acompanhe forge-z/pi-bot#66 a cada 5 minutos"),
    created(66, 5),
  );
});

test("'PR 66' without a hash works when the repo comes from a /pulls URL", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pulls PR 66 a cada 5 minutos",
    ),
    created(66, 5),
  );
});

test("links with embedded credentials are refused", () => {
  assert.throws(
    () =>
      parseGoalCommand(
        "acompanhe https://user:pass@github.com/forge-z/pi-bot/pull/66 a cada 5 minutos",
      ),
    /credential/i,
  );
});

test("the structured command surface is unchanged", () => {
  assert.deepEqual(parseGoalCommand("pr octocat/hello-world#7 60 24"), {
    action: "create",
    target: { owner: "octocat", repo: "hello-world", prNumber: 7 },
    intervalMin: 60,
    maxAttempts: 24,
  });
  assert.deepEqual(parseGoalCommand("pr a/b#7 5 24"), {
    action: "create",
    target: { owner: "a", repo: "b", prNumber: 7 },
    intervalMin: 5,
    maxAttempts: 24,
  });
  assert.throws(() => parseGoalCommand("pr a/b#7 4 24"), /minutes/i);
  assert.deepEqual(parseGoalCommand("list"), { action: "list" });
  assert.deepEqual(parseGoalCommand("cancel 2"), {
    action: "cancel",
    index: 2,
  });
  assert.deepEqual(parseGoalCommand(""), { action: "help" });
});

test("a PT sentence with 'PR 12', no hash, repo from /pulls, every 30 minutes", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pulls e avise quando a PR 12 for publicada, a cada 30 minutos",
    ),
    created(12, 30),
  );
});

test("mentioning the same PR number twice is not a conflict", () => {
  assert.deepEqual(
    parseGoalCommand(
      "acompanhe https://github.com/forge-z/pi-bot/pulls a PR #66 e tambem #66 a cada 5 minutos",
    ),
    created(66, 5),
  );
});

test("the goal bounds are 5 and 1440 minutes with at most 200 checks", () => {
  assert.equal(GOAL_INTERVAL_MIN, 5);
  assert.equal(GOAL_INTERVAL_MAX, 1440);
  assert.equal(GOAL_ATTEMPTS_MAX, 200);
});

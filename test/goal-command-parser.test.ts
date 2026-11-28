import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GOAL_ATTEMPTS_MAX,
  GOAL_HELP,
  GOAL_INTERVAL_MAX,
  GOAL_INTERVAL_MIN,
  GOAL_OBJECTIVE_MAX,
  GoalError,
  parseGoalCommand,
  parseGoalTarget,
} from "../src/goals.js";

/** The `/goal` command parser surface: help, the scoped controls (list,
 * check, cancel), the structured `pr` form and the objective fallback for
 * whitespace, quotes and multiline input. The natural-language PR and
 * cadence vocabulary is covered by goal-natural-language.test.ts and
 * goal-limits.test.ts; here only its boundaries appear. */

const refused = (args: string, message: RegExp) =>
  assert.throws(
    () => parseGoalCommand(args),
    (error: unknown) => {
      assert.ok(error instanceof GoalError, "a GoalError is thrown");
      assert.match(error.message, message);
      return true;
    },
  );

test("empty and whitespace-only arguments ask for help", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "help" });
  assert.deepEqual(parseGoalCommand("   "), { action: "help" });
  assert.deepEqual(parseGoalCommand("\n\n\t  \n"), { action: "help" });
});

test("list takes no extra arguments", () => {
  assert.deepEqual(parseGoalCommand("list"), { action: "list" });
  assert.deepEqual(parseGoalCommand("  list  "), { action: "list" });
  refused("list extra", new RegExp(GOAL_HELP.slice(0, 30)));
});

test("check and cancel take exactly one positive whole number", () => {
  assert.deepEqual(parseGoalCommand("check 1"), { action: "check", index: 1 });
  assert.deepEqual(parseGoalCommand("cancel 3"), {
    action: "cancel",
    index: 3,
  });
  refused("check 1 2", /Invalid goal request/);
  refused("cancel", /Invalid goal request/);
  refused("cancel 0", /Invalid goal number/);
  refused("cancel -1", /Invalid goal number/);
  refused("cancel abc", /Invalid goal number/);
  refused("cancel 2.5", /Invalid goal number/);
});

test("control words are case-sensitive lowercase", () => {
  // "List" is not the list control: it falls through to the natural
  // parser and is refused there for its missing check interval.
  refused("List", /no check interval found/);
  refused("Check 1", /no check interval found/);
});

test("the structured pr form needs exactly target, minutes and max checks", () => {
  assert.deepEqual(parseGoalCommand("pr Octocat/Hello-World#7 60 200"), {
    action: "create",
    target: { owner: "octocat", repo: "hello-world", prNumber: 7 },
    intervalMin: 60,
    maxAttempts: 200,
  });
  // Any whitespace runs separate the arguments.
  assert.deepEqual(parseGoalCommand("pr octocat/hello#7   60\t200"), {
    action: "create",
    target: { owner: "octocat", repo: "hello", prNumber: 7 },
    intervalMin: 60,
    maxAttempts: 200,
  });
  refused("pr octocat/hello#7 60", /Invalid goal request/);
  refused("pr octocat/hello#7 60 200 extra", /Invalid goal request/);
  refused("pr", /Invalid goal request/);
});

test("pr minutes and max checks are whole numbers inside the bounds", () => {
  refused(
    `pr octocat/hello#7 ${GOAL_INTERVAL_MIN - 1} 5`,
    new RegExp(`Invalid minutes.*${GOAL_INTERVAL_MIN} to ${GOAL_INTERVAL_MAX}`),
  );
  refused(
    `pr octocat/hello#7 ${GOAL_INTERVAL_MAX + 1} 5`,
    new RegExp(`Invalid minutes.*${GOAL_INTERVAL_MIN} to ${GOAL_INTERVAL_MAX}`),
  );
  refused("pr octocat/hello#7 60.5 5", /Invalid minutes/);
  refused("pr octocat/hello#7 abc 5", /Invalid minutes/);
  refused("pr octocat/hello#7 60 0", /Invalid max checks/);
  refused(
    `pr octocat/hello#7 60 ${GOAL_ATTEMPTS_MAX + 1}`,
    /Invalid max checks/,
  );
});

test("a pr target must be owner/repo#number with a positive PR number", () => {
  assert.deepEqual(parseGoalTarget("octocat/hello#1"), {
    owner: "octocat",
    repo: "hello",
    prNumber: 1,
  });
  assert.deepEqual(parseGoalTarget("OctoCat/Hello_World#123456789"), {
    owner: "octocat",
    repo: "hello_world",
    prNumber: 123456789,
  });
  for (const bad of [
    "octocat/hello", // no PR number
    "octocat/hello#0", // zero is not a PR
    "octocat/hello#00", // leading zeros
    "octocat/hello#1234567890", // more than 9 digits
    "-octocat/hello#1", // owner may not start with '-'
    "octocat/..hello#1", // bad repository characters
    "octocat/hello#1 extra",
    "",
  ])
    assert.throws(() => parseGoalTarget(bad), GoalError, JSON.stringify(bad));
});

test("an uppercase PR keyword is not the structured form", () => {
  // "PR ..." falls through to the natural parser, where the leftover
  // numbers are read as PR references, not cadence arguments.
  refused("PR octocat/hello#7 60 5", /Invalid goal request/);
});

test("multiline input is one goal; newlines and tabs collapse to spaces", () => {
  assert.deepEqual(
    parseGoalCommand(
      "avise quando o relatório\naparecer no Drive\ta cada 2 horas",
    ),
    {
      action: "objective",
      objective: "avise quando o relatório aparecer no Drive",
      intervalMin: 120,
      maxAttempts: GOAL_ATTEMPTS_MAX,
    },
  );
});

test("quotes are kept as part of the objective, never stripped or split", () => {
  assert.deepEqual(parseGoalCommand('"avise quando chover" a cada 2 horas'), {
    action: "objective",
    objective: '"avise quando chover"',
    intervalMin: 120,
    maxAttempts: GOAL_ATTEMPTS_MAX,
  });
});

test("an objective needs words beyond its cadence and limits", () => {
  refused("a cada 2 horas", /no objective found/);
  refused("no maximo 5 vezes a cada 2 horas", /no objective found/);
});

test("an objective above the length cap is refused, never truncated", () => {
  refused(
    `${"x".repeat(GOAL_OBJECTIVE_MAX + 1)} a cada 2 horas`,
    new RegExp(`objective is too long \\(maximum ${GOAL_OBJECTIVE_MAX}`),
  );
});

test("the parser takes the arguments only; the caller strips the /goal prefix", () => {
  // telegram.ts passes text.slice("/goal".length).trim(); a prefix left in
  // is not a control word, so the request stays ordinary objective text.
  refused("/goal list", /no check interval found/);
});

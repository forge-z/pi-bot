import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarnessConfig } from "../src/harness-config.js";
import {
  DEFAULT_REACTION_DELAY_MS,
  ReactionAck,
  deliveryAnswersUpdate,
  reactionDelayMs,
} from "../src/reaction-ack.js";

const CHAT = "-100123";
const MESSAGE = 10;
const UPDATE = 7;
const REPLY = `9:telegram:${UPDATE}:0`;

function reactions() {
  const calls: Array<{ chat: string; messageId: number }> = [];
  const react = (chat: string, messageId: number) => {
    calls.push({ chat, messageId });
    return Promise.resolve(true);
  };
  return { calls, react };
}

test("a fast reply does not react", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen = reactions();
  const ack = new ReactionAck(seen.react, DEFAULT_REACTION_DELAY_MS);
  try {
    ack.arm(CHAT, MESSAGE, UPDATE);
    ack.delivered(REPLY);
    t.mock.timers.tick(DEFAULT_REACTION_DELAY_MS);
    await Promise.resolve();
    assert.deepEqual(seen.calls, []);
    ack.close();
  } finally {
    t.mock.timers.reset();
  }
});

test("a slow reply reacts once the delay elapses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen = reactions();
  const ack = new ReactionAck(seen.react, DEFAULT_REACTION_DELAY_MS);
  try {
    ack.arm(CHAT, MESSAGE, UPDATE);
    t.mock.timers.tick(DEFAULT_REACTION_DELAY_MS - 1);
    await Promise.resolve();
    assert.deepEqual(seen.calls, []);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(seen.calls, [{ chat: CHAT, messageId: MESSAGE }]);
    ack.delivered(REPLY);
    t.mock.timers.tick(DEFAULT_REACTION_DELAY_MS);
    await Promise.resolve();
    assert.equal(seen.calls.length, 1);
    ack.close();
  } finally {
    t.mock.timers.reset();
  }
});

test("a delay of 0 reacts immediately and is not cancelled", async () => {
  const seen = reactions();
  const ack = new ReactionAck(seen.react, 0);
  ack.arm(CHAT, MESSAGE, UPDATE);
  ack.delivered(REPLY);
  assert.deepEqual(seen.calls, []);
  await Promise.resolve();
  assert.deepEqual(seen.calls, [{ chat: CHAT, messageId: MESSAGE }]);
  ack.close();
});

test("a reply that lands as the timer fires does not react", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen = reactions();
  const ack = new ReactionAck(seen.react, DEFAULT_REACTION_DELAY_MS);
  try {
    ack.arm(CHAT, MESSAGE, UPDATE);
    t.mock.timers.tick(DEFAULT_REACTION_DELAY_MS);
    ack.delivered(REPLY);
    await Promise.resolve();
    assert.deepEqual(seen.calls, []);
    ack.close();
  } finally {
    t.mock.timers.reset();
  }
});

test("closing drops a pending reaction and a queued claim", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen = reactions();
  const ack = new ReactionAck(seen.react, 2500);
  try {
    ack.arm(CHAT, MESSAGE, UPDATE);
    ack.close();
    t.mock.timers.tick(2500);
    await Promise.resolve();
    assert.deepEqual(seen.calls, []);

    ack.arm(CHAT, MESSAGE, UPDATE);
    t.mock.timers.tick(2500);
    ack.close();
    await Promise.resolve();
    assert.deepEqual(seen.calls, []);
  } finally {
    t.mock.timers.reset();
  }
});

test("another update's delivery does not cancel this reaction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen = reactions();
  const ack = new ReactionAck(seen.react, 1000);
  try {
    ack.arm(CHAT, MESSAGE, UPDATE);
    ack.delivered(`9:telegram:${UPDATE}0:0`);
    ack.delivered(`9:telegram:${UPDATE + 10}:0`);
    ack.delivered("telegram:busy:70:0");
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.deepEqual(seen.calls, [{ chat: CHAT, messageId: MESSAGE }]);
    ack.close();
  } finally {
    t.mock.timers.reset();
  }
});

test("the busy line and the clean reply count as the turn's first delivery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen = reactions();
  const ack = new ReactionAck(seen.react, 1000);
  try {
    ack.arm(CHAT, MESSAGE, UPDATE);
    ack.delivered(`telegram:busy:${UPDATE}:0`);
    t.mock.timers.tick(1000);
    await Promise.resolve();
    ack.arm(CHAT, 11, UPDATE + 1);
    ack.delivered(`telegram:clean:${UPDATE + 1}:0`);
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.deepEqual(seen.calls, []);
    ack.close();
  } finally {
    t.mock.timers.reset();
  }
});

test("a failed reaction is reported and does not escape", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors: unknown[] = [];
  const ack = new ReactionAck(
    () => Promise.reject(new Error("unavailable")),
    1000,
    (error) => errors.push(error),
  );
  try {
    ack.arm(CHAT, MESSAGE, UPDATE);
    t.mock.timers.tick(1000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /unavailable/);
    ack.close();
  } finally {
    t.mock.timers.reset();
  }
});

test("reaction delay parsing keeps 0 and rejects junk", () => {
  assert.equal(reactionDelayMs(undefined), DEFAULT_REACTION_DELAY_MS);
  assert.equal(reactionDelayMs(0), 0);
  assert.equal(reactionDelayMs("0"), 0);
  assert.equal(reactionDelayMs(1500.9), 1500);
  assert.equal(reactionDelayMs(-1), DEFAULT_REACTION_DELAY_MS);
  assert.equal(reactionDelayMs("soon"), DEFAULT_REACTION_DELAY_MS);
  assert.equal(deliveryAnswersUpdate(`4:telegram:5:0`, 5), true);
  assert.equal(deliveryAnswersUpdate(`4:telegram:50:0`, 5), false);
  assert.equal(deliveryAnswersUpdate(`4:telegram:15:0`, 5), false);
  assert.equal(deliveryAnswersUpdate("telegram:busy:5:0", 5), true);
  assert.equal(deliveryAnswersUpdate("telegram:clean:5:1", 5), true);
});

test("config.yaml can set the reaction delay, including 0", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reaction-delay-"));
  const immediate = join(root, "zero.yaml");
  const broken = join(root, "broken.yaml");
  await writeFile(immediate, "reaction_delay_ms: 0\n");
  await writeFile(
    broken,
    [
      "reaction_delay_ms: -5",
      "mcp_servers:",
      "  executor:",
      "    trust: untrusted",
      "",
    ].join("\n"),
  );
  try {
    const defaults = loadHarnessConfig({
      CONFIG_FILE: join(root, "missing.yaml"),
    });
    assert.equal(defaults.reactionDelayMs, DEFAULT_REACTION_DELAY_MS);
    assert.equal(
      loadHarnessConfig({ CONFIG_FILE: immediate }).reactionDelayMs,
      0,
    );
    const fallback = loadHarnessConfig({ CONFIG_FILE: broken });
    assert.equal(fallback.reactionDelayMs, DEFAULT_REACTION_DELAY_MS);
    assert.equal(fallback.mcpServers.executor?.trust, "untrusted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

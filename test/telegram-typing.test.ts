import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramTyping } from "../src/telegram-typing.js";

test("typing pulses once per group and stops when the lease ends", async () => {
  const chats: string[] = [];
  const typing = new TelegramTyping(async (chat) => {
    chats.push(chat);
  });
  const stop = typing.start(1, "-100", () => true, { messageThreadId: 7 });
  const stopOther = typing.start(2, "-100", () => true, {
    messageThreadId: 7,
  });
  await Promise.resolve();
  assert.deepEqual(chats, ["-100"]);
  stop();
  stopOther();
  const again = typing.start(3, "-100", () => true, { messageThreadId: 7 });
  await Promise.resolve();
  assert.deepEqual(chats, ["-100", "-100"]);
  again();
  typing.close();
});

test("a lease that is no longer active is dropped without throwing", () => {
  let live = true;
  let sends = 0;
  const typing = new TelegramTyping(async () => {
    sends += 1;
  });
  typing.start(1, "c", () => live);
  live = false;
  typing.check();
  typing.start(2, "c", () => true);
  assert.equal(sends, 2);
  typing.close();
});

test("a rejected typing send does not escape the lease", () => {
  const typing = new TelegramTyping(async () => {
    throw new Error("telegram down");
  });
  const stop = typing.start(1, "c", () => true);
  assert.equal(typeof stop, "function");
  stop();
  typing.close();
});

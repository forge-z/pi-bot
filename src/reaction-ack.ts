/**
 * Eyes on a message that starts a turn, only when the reply is still unsent.
 * The reaction is armed for `delayMs`. The turn's first delivery cancels it.
 * `0` reacts on the next microtask and is not cancelled, matching the old
 * immediate reaction. A timer that pops in the same turn as the delivery does
 * not call the transport: the claim happens in the microtask, after a
 * synchronous cancel.
 */

export const DEFAULT_REACTION_DELAY_MS = 4_000;

/** Missing or unusable values keep the default. `0` is immediate. */
export function reactionDelayMs(value: unknown) {
  if (value === undefined || value === null || value === "")
    return DEFAULT_REACTION_DELAY_MS;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REACTION_DELAY_MS;
  const ms = Math.floor(parsed);
  return Number.isSafeInteger(ms) ? ms : DEFAULT_REACTION_DELAY_MS;
}

/**
 * True when this delivery id is the first reply for that Telegram update:
 * the turn answer (`<conversation>:telegram:<update>:`), the busy line, or
 * the clean control reply. Update 5 does not match 15 or 50.
 */
export function deliveryAnswersUpdate(deliveryId: string, updateId: number) {
  if (!Number.isSafeInteger(updateId) || updateId < 0) return false;
  const token = String(updateId);
  const markers = [
    `:telegram:${token}:`,
    `:telegram:busy:${token}:`,
    `:telegram:clean:${token}:`,
  ];
  return (
    deliveryId.startsWith(`telegram:${token}:`) ||
    deliveryId.startsWith(`telegram:busy:${token}:`) ||
    deliveryId.startsWith(`telegram:clean:${token}:`) ||
    markers.some((marker) => deliveryId.includes(marker))
  );
}

interface Slot {
  chat: string;
  messageId: number;
  updateId: number;
  /** The reply won, or this slot already claimed the reaction. */
  done: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class ReactionAck {
  private slots: Slot[] = [];
  constructor(
    private react: (
      chat: string,
      messageId: number,
    ) => Promise<unknown> | unknown,
    private delayMs: number,
    private onError: (error: unknown) => void = () => {},
  ) {}

  /** Schedule eyes for one accepted turn. A duplicate update replaces the previous arm. */
  arm(chat: string, messageId: number, updateId: number) {
    if (!Number.isSafeInteger(messageId) || !Number.isSafeInteger(updateId))
      return;
    for (const slot of [...this.slots]) {
      if (slot.updateId === updateId) this.cancel(slot);
    }
    if (this.delayMs <= 0) {
      this.invoke(chat, messageId);
      return;
    }
    const slot: Slot = { chat, messageId, updateId, done: false };
    const timer = setTimeout(() => {
      slot.timer = undefined;
      void Promise.resolve().then(() => {
        // The reply can land after the timer callback and before this turn.
        if (slot.done) return;
        slot.done = true;
        this.forget(slot);
        this.launch(slot.chat, slot.messageId);
      });
    }, this.delayMs);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    slot.timer = timer;
    this.slots.push(slot);
  }

  /**
   * The first delivery of a turn has left. Pending reactions for that update
   * are dropped. A reaction already claimed is left in place.
   */
  delivered(deliveryId: string) {
    for (const slot of [...this.slots]) {
      if (!slot.done && deliveryAnswersUpdate(deliveryId, slot.updateId))
        this.cancel(slot);
    }
  }

  /** Drop every pending timer. An in-flight claim sees `done` and does not react. */
  close() {
    for (const slot of [...this.slots]) this.cancel(slot);
    this.slots = [];
  }

  private cancel(slot: Slot) {
    slot.done = true;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    this.forget(slot);
  }

  private forget(slot: Slot) {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
  }

  /** Delay 0: same fire-and-forget microtask as the old immediate reaction. */
  private invoke(chat: string, messageId: number) {
    void Promise.resolve().then(() => this.launch(chat, messageId));
  }

  /**
   * Attaches the failure handler to the transport promise itself, so a
   * rejection is not reported once and then again as unhandled.
   */
  private launch(chat: string, messageId: number) {
    try {
      void Promise.resolve(this.react(chat, messageId)).catch(
        (error: unknown) => this.onError(error),
      );
    } catch (error) {
      this.onError(error);
    }
  }
}

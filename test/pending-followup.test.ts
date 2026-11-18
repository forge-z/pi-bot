import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Registry } from "@earendil-works/pi-durable";
import {
  followupNote,
  MCP_USAGE,
  Runtime,
  SCHEDULING,
} from "../src/runtime.js";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

test("an untracked pending id is not a promise to return", () => {
  const running = textResult({ run_id: "run-example", status: "RUNNING" });
  const scheduled = followupNote(running, {
    registered: false,
    canSchedule: true,
  });
  assert.match(scheduled ?? "", /50 seconds/);
  assert.match(scheduled ?? "", /execute stops at 60/);
  assert.match(scheduled ?? "", /tasks_create/);
  assert.match(scheduled ?? "", /notify/);
  assert.match(scheduled ?? "", /Do not promise to come back/);
  const quiet = followupNote(running, {
    registered: false,
    canSchedule: false,
  });
  assert.match(quiet ?? "", /50 seconds/);
  assert.match(quiet ?? "", /cannot create a schedule/);
  assert.doesNotMatch(quiet ?? "", /tasks_create/);
});

test("a registered job tells the model to wait for delivery", () => {
  const note = followupNote(
    textResult({ run_id: "run-example", status: "RUNNING" }),
    { registered: true, canSchedule: true },
  );
  assert.match(note ?? "", /Registered async job/);
  assert.match(note ?? "", /Do not poll in a loop/);
  assert.doesNotMatch(note ?? "", /tasks_create/);
});

test("a finished task and a bare id do not grow a follow-up", () => {
  assert.equal(
    followupNote(
      textResult({
        runId: "run-example",
        status: "completed",
        result: { summary: "done" },
      }),
      { registered: true, canSchedule: true },
    ),
    undefined,
  );
  assert.equal(
    followupNote(textResult({ id: "msg-example" }), {
      registered: false,
      canSchedule: true,
    }),
    undefined,
  );
  assert.equal(
    followupNote(textResult({ id: "job-example", status: "FAILED" }), {
      registered: false,
      canSchedule: true,
    }),
    undefined,
  );
  const pendingId = followupNote(
    { structuredContent: { id: "job-example", status: "pending" } },
    { registered: false, canSchedule: true },
  );
  assert.match(pendingId ?? "", /tasks_create/);
  const onlyTaskId = followupNote(textResult({ taskId: "task-example" }), {
    registered: false,
    canSchedule: true,
  });
  assert.match(onlyTaskId ?? "", /only a task id/);
});

test("an Executor envelope uses the inner job, not the wrapper status", () => {
  const note = followupNote(
    textResult({
      status: "completed",
      execution: {
        ok: true,
        value: { run_id: "run-example", status: "RUNNING" },
      },
    }),
    { registered: false, canSchedule: true },
  );
  assert.match(note ?? "", /only a task id/);
  assert.equal(
    followupNote(
      textResult({
        status: "completed",
        execution: {
          ok: true,
          value: {
            run_id: "run-example",
            status: "COMPLETED",
            result: { ok: true },
          },
        },
      }),
      { registered: false, canSchedule: true },
    ),
    undefined,
  );
});

test("the fixed prompt and tasks_create describe the same three ways", async () => {
  assert.match(SCHEDULING, /50 seconds/);
  assert.match(SCHEDULING, /execute stops at 60/);
  assert.match(SCHEDULING, /tasks_create/);
  assert.match(SCHEDULING, /notify/);
  assert.match(SCHEDULING, /Never say you will come back/);
  assert.match(SCHEDULING, /must not create more schedules/);
  assert.match(MCP_USAGE, /50 seconds/);
  assert.match(MCP_USAGE, /Never promise to come back/);
  const dir = await mkdtemp(join(tmpdir(), "pi-pending-followup-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { catalog: async () => [] },
  });
  try {
    const tool = (app as unknown as { registry: Registry }).registry
      .snapshot()
      .extension("personal-assistant")
      ?.tools?.find((item) => item.name === "tasks_create");
    assert.match(String(tool?.description), /pending task id/);
    assert.match(String(tool?.description), /notify/);
    assert.match(String(tool?.description), /50 seconds/);
    const scheduling = (app as unknown as { registry: Registry }).registry
      .snapshot()
      .extension("personal-assistant")
      ?.sections?.find((section) => section.key === "scheduling");
    assert.equal(
      await scheduling?.render(undefined as never, undefined as never),
      SCHEDULING,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

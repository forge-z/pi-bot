import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { commandApprovals, commandRevoke } from "../src/commands.js";
import { McpGateway } from "../src/mcp.js";
import {
  approvalResource,
  rememberableToolName,
} from "../src/remembered-approvals.js";
import { Runtime } from "../src/runtime.js";
import {
  mcpApprovalPrompt,
  rememberAndAccept,
} from "../src/telegram-approvals.js";

const READ = {
  code: 'return await tools.calendar.listEvents({ calendarId: "work" })',
};
const WRITE = { code: "return await tools.notes.create({ text: 'oi' })" };

function pause(
  requestId: string,
  tool: string,
  input: Record<string, unknown>,
) {
  return {
    status: "approval-required",
    requestId,
    invocation: { app: "app_calendar", tool, kind: "query", input },
    elicitation: {
      mode: "form",
      message: `Approve ${tool}?`,
      requestedSchema: { type: "object", properties: {} },
    },
    expiresAt: Date.now() + 60_000,
  };
}

async function open() {
  const dir = await mkdtemp(join(tmpdir(), "pi-remembered-"));
  const gateway = new McpGateway([
    { name: "executor", url: "http://127.0.0.1:1/mcp", mode: "direct" },
  ]);
  gateway.connectionBinding = async () => "binding";
  gateway.credentialBinding = () => "binding";
  gateway.catalog = async () => [];
  const calls: string[] = [];
  let next: Record<string, unknown>[] = [];
  gateway.callDirect = (async (_server: string, tool: string) => {
    calls.push(tool);
    const body = next.shift() ?? {
      status: "completed",
      execution: { ok: true, value: { events: [] } },
    };
    return { content: [], structuredContent: body };
  }) as unknown as typeof gateway.callDirect;
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const app = await Runtime.open({ dir, gateway, models });
  const conversationId = await app.create();
  const access = {
    source: "telegram" as const,
    user: "1",
    chat: "1",
  };
  app.commands.authorize = () => {};
  return {
    app,
    calls,
    conversationId,
    access,
    queue: (...bodies: Record<string, unknown>[]) => {
      next = bodies;
    },
    pending: () =>
      app.mcpCalls
        .interactions(conversationId)
        .filter((item) => item.state === "pending"),
    close: async () => {
      await app.close();
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("a remembered read does not ask again, in a chat or a scheduled run", async () => {
  const f = await open();
  try {
    f.queue(pause("apr_1", "calendar.events.list", { calendarId: "work" }));
    await f.app.mcpCalls.execute(
      f.conversationId,
      1,
      "executor",
      "execute",
      READ,
    );
    const [first] = f.pending();
    assert.ok(first);
    const prompt = mcpApprovalPrompt(f.app, first)!;
    assert.deepEqual(
      prompt.choices.map((choice) => choice.label),
      ["Aprovar uma vez", "Sempre permitir isto", "Decline"],
    );
    const { rule } = await rememberAndAccept(f.app, first, "telegram");
    assert.equal(rule.server, "executor");
    assert.equal(rule.tool, "app_calendar.calendar.events.list");
    assert.equal(rule.resource, '{"calendarid":"work"}');
    assert.equal(rule.origin, "telegram");
    assert.deepEqual(f.calls, ["execute", "resume"]);

    f.queue(pause("apr_2", "calendar.events.list", { calendarId: "work" }));
    const result = await f.app.mcpCalls.execute(
      f.conversationId,
      2,
      "executor",
      "execute",
      READ,
    );
    assert.equal(result.isError, undefined);
    assert.equal(f.pending().length, 0);
    assert.deepEqual(f.calls, ["execute", "resume", "execute", "resume"]);
    const remembered = f.app.mcpCalls
      .interactions(f.conversationId)
      .filter(
        (item) => JSON.parse(item.response ?? "{}").remembered === rule.id,
      );
    assert.equal(remembered.length, 1);

    f.queue(pause("apr_3", "calendar.events.list", { calendarId: "work" }));
    await f.app.mcpCalls.execute(
      f.conversationId,
      3,
      "executor",
      "execute",
      READ,
      undefined,
      true,
    );
    assert.equal(f.pending().length, 0);
    assert.equal(f.calls.at(-1), "resume");

    // Another calendar is another resource and still asks.
    f.queue(pause("apr_4", "calendar.events.list", { calendarId: "home" }));
    await f.app.mcpCalls.execute(
      f.conversationId,
      4,
      "executor",
      "execute",
      READ,
    );
    assert.equal(f.pending().length, 1);
  } finally {
    await f.close();
  }
});

test("a write never offers the button and cannot be remembered", async () => {
  const f = await open();
  try {
    f.queue(pause("apr_w", "notes.create", { text: "oi" }));
    await f.app.mcpCalls.execute(
      f.conversationId,
      1,
      "executor",
      "execute",
      WRITE,
    );
    const [item] = f.pending();
    assert.ok(item);
    const labels = mcpApprovalPrompt(f.app, item)!.choices.map(
      (choice) => choice.label,
    );
    assert.deepEqual(labels, ["Approve", "Decline"]);
    await assert.rejects(
      rememberAndAccept(f.app, item, "whatsapp"),
      /Only a reviewable read/,
    );
    assert.equal(f.app.mcpCalls.rememberedApprovals.list().length, 0);

    // A read-looking program whose held step sends, deletes or pays still asks.
    for (const tool of [
      "gmail.messages.send",
      "files.delete",
      "stripe.payments.list.create",
    ])
      assert.equal(rememberableToolName(tool), false, tool);
    assert.equal(rememberableToolName("calendar.events.list"), true);
  } finally {
    await f.close();
  }
});

test("a revoked rule asks again and /approvals lists what is left", async () => {
  const f = await open();
  try {
    f.queue(pause("apr_1", "calendar.events.list", { calendarId: "work" }));
    await f.app.mcpCalls.execute(
      f.conversationId,
      1,
      "executor",
      "execute",
      READ,
    );
    const { rule } = await rememberAndAccept(
      f.app,
      f.pending()[0]!,
      "whatsapp",
    );
    assert.match(
      commandApprovals(f.app, f.conversationId, f.access),
      new RegExp(
        `^${rule.id}\\. executor/app_calendar\\.calendar\\.events\\.list · calendarid=work · .* · whatsapp$`,
        "m",
      ),
    );
    assert.match(
      commandRevoke(f.app, f.conversationId, f.access, "abc"),
      /Use \/revoke <n>/,
    );
    assert.match(
      commandRevoke(f.app, f.conversationId, f.access, String(rule.id)),
      /revoked/,
    );
    assert.match(
      commandRevoke(f.app, f.conversationId, f.access, String(rule.id)),
      /No remembered approval/,
    );
    assert.match(
      commandApprovals(f.app, f.conversationId, f.access),
      /No remembered approvals/,
    );

    f.queue(pause("apr_2", "calendar.events.list", { calendarId: "work" }));
    await f.app.mcpCalls.execute(
      f.conversationId,
      2,
      "executor",
      "execute",
      READ,
    );
    assert.equal(f.pending().length, 1);
  } finally {
    await f.close();
  }
});

test("the resource is the named target only, in a stable order", () => {
  assert.equal(
    approvalResource({ query: "x", calendar_id: "a", accountId: "b" }),
    '{"accountid":"b","calendarid":"a"}',
  );
  assert.equal(approvalResource({ query: "x" }), null);
  assert.equal(approvalResource("x"), null);
});

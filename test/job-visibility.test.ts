import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { PendingJobs } from "../src/pending-jobs.js";
import { Commands } from "../src/commands.js";
import { bindChannelChat, type InboundMessage } from "../src/channel.js";
import { takeWhatsAppCommand } from "../src/whatsapp-commands.js";
import type { Runtime } from "../src/runtime.js";

/** A poll manifest: the read asks one id, exactly like the Instabox status file. */
const MANIFEST = {
  tool: "tools.tinyfish.agent.automation.runAsync",
  dispatch: { mode: "immediate" },
  observe: {
    mode: "poll",
    tool: "tools.tinyfish.agent.runs.getRunById",
    args: { accountId: "acc-test", input: { path: { id: "${id}" } } },
    statePath: "status",
    resultPath: "result",
    errorPath: "error",
  },
  poll: { backoff: [1], maxAttempts: 3 },
  graceMinutes: 5,
};

const PR = "https://github.com/example/repo/pull/7";

/** Real Executor `execute` success: the program return sits in `execution.value`. */
function executorOk(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: true, value },
        }),
      },
    ],
  };
}

/** A Runtime stand-in: the store, a gateway that answers the status read, and submit. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-job-visibility-"));
  const store = new Store(dir);
  const submissions: {
    conversationId: string;
    requestId: string;
    text: string;
    source: string;
  }[] = [];
  let observed: unknown;
  const gateway = {
    callDirect: async (_server: string, tool: string) => {
      if (tool === "search" || tool === "describe")
        return {
          namespaces: [
            {
              path: "tools.tinyfish",
              app: "TinyFish",
              accounts: "tinyfish: acc-test (Default)",
            },
          ],
        };
      if (observed instanceof Error) throw observed;
      return executorOk(observed);
    },
  };
  const app: {
    store: Store;
    options: { gateway: unknown };
    submit: (
      conversationId: string,
      requestId: string,
      text: string,
      source: string,
    ) => Promise<unknown>;
    assertConversationAvailable: () => void;
    pendingJobs?: PendingJobs;
    commands?: Commands;
  } = {
    store,
    options: { gateway },
    submit: async (
      conversationId: string,
      requestId: string,
      text: string,
      source: string,
    ) => {
      submissions.push({ conversationId, requestId, text, source });
      return {};
    },
    assertConversationAvailable: () => {},
  };
  const jobs = new PendingJobs(app as unknown as Runtime, {
    ASYNC_JOB_MANIFESTS: JSON.stringify([MANIFEST]),
  });
  app.pendingJobs = jobs;
  app.commands = new Commands(app as unknown as Runtime);
  return {
    store,
    jobs,
    submissions,
    app,
    setObserved: (value: unknown) => {
      observed = value;
    },
    close: async () => {
      jobs.close();
      store.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Registers the job and attaches the run id, as a dispatch that returned one. */
function dispatch(f: Awaited<ReturnType<typeof fixture>>, runId = "run-1") {
  f.jobs.registerDelegated("7", {
    code: "await tools.tinyfish.agent.automation.runAsync({})",
  });
  f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", runId);
}

/** The announce submissions: request id `job:<row>:state:<state>`. */
function announces(f: Awaited<ReturnType<typeof fixture>>) {
  return f.submissions.filter((item) => item.requestId.includes(":state:"));
}

let sequence = 0;

function jobMessage(text: string): InboundMessage {
  sequence += 1;
  return {
    channel: "whatsapp",
    chatId: "5511999999@s.whatsapp.net",
    senderId: "5511999999@s.whatsapp.net",
    messageId: `m-${sequence}`,
    text,
  };
}

/** Sends /job on WhatsApp and returns the queued reply text. */
async function askJob(f: Awaited<ReturnType<typeof fixture>>) {
  const message = jobMessage("/job");
  const handled = await takeWhatsAppCommand(
    f.app as unknown as Runtime,
    message,
    "7",
  );
  assert.equal(handled, true, "/job is handled as a command");
  return f.store
    .all<{ text: string }>("SELECT text FROM deliveries")
    .filter((row) => row.text && !/^(\/|Unknown)/.test(row.text))
    .map((row) => row.text)
    .at(-1)!;
}

function requestCount(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    f.store.get<{ total: number }>("SELECT count(*) AS total FROM requests")
      ?.total ?? 0
  );
}

test("a transition to RUNNING announces once, and a same-state poll stays silent", async () => {
  const f = await fixture();
  try {
    dispatch(f);
    f.setObserved({ data: { run_id: "run-1", status: "RUNNING" } });
    await f.jobs.tick();
    const lines = announces(f);
    assert.equal(lines.length, 1, "exactly one announce");
    assert.match(lines[0]!.requestId, /job:1:state:running/);
    assert.equal(lines[0]!.conversationId, "7");
    assert.match(lines[0]!.text, /RUNNING/);
    assert.match(lines[0]!.text, /run-1/);
    assert.match(lines[0]!.text, /since dispatch/);
    // A second poll sees the same state: nothing new is announced.
    f.store.run("UPDATE pending_jobs SET next_poll_at=0");
    await f.jobs.tick();
    assert.equal(announces(f).length, 1, "the same state announces nothing");
  } finally {
    await f.close();
  }
});

test("DONE announces with the PR URL when the result carries one", async () => {
  const f = await fixture();
  try {
    dispatch(f);
    f.setObserved({
      data: {
        run_id: "run-1",
        status: "COMPLETED",
        result: { answer: "pr aberto", pr: PR },
      },
    });
    await f.jobs.tick();
    // The terminal announce line rides in the single delivery turn, not a second one.
    assert.equal(f.submissions.length, 1, "one message, not two");
    const delivery = f.submissions[0]!;
    assert.equal(delivery.requestId, "job:1:run-1");
    assert.match(delivery.text, /Job 1 \(run-1\) is DONE/);
    assert.match(delivery.text, /since dispatch/);
    assert.ok(delivery.text.includes(PR), "the announce carries the PR URL");
  } finally {
    await f.close();
  }
});

test("FAILED announces the error", async () => {
  const f = await fixture();
  try {
    dispatch(f);
    f.setObserved({
      data: {
        run_id: "run-1",
        status: "FAILED",
        error: "browser crashed at step 3",
      },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "one message, not two");
    const delivery = f.submissions[0]!;
    assert.match(delivery.text, /Job 1 \(run-1\) is FAILED/);
    assert.match(delivery.text, /browser crashed at step 3/);
    assert.match(delivery.text, /since dispatch/);
  } finally {
    await f.close();
  }
});

test("the timeout notice still fires and is not repeated", async () => {
  const f = await fixture();
  try {
    dispatch(f);
    f.setObserved({ data: { run_id: "run-1", status: "RUNNING" } });
    f.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 40 * 60_000,
    );
    await f.jobs.tick();
    const notices = f.submissions.filter((item) =>
      /Status: RUNNING after/.test(item.text),
    );
    assert.equal(notices.length, 1, "the timeout notice fires once");
    assert.equal(announces(f).length, 0, "no announce duplicates the notice");
    f.store.run("UPDATE pending_jobs SET next_poll_at=0");
    await f.jobs.tick();
    assert.equal(
      f.submissions.filter((item) => /Status: RUNNING after/.test(item.text))
        .length,
      1,
      "the notice is not repeated",
    );
    assert.equal(announces(f).length, 0);
  } finally {
    await f.close();
  }
});

test("/job answers on WhatsApp for a running job and creates no request row", async () => {
  const f = await fixture();
  try {
    bindChannelChat(f.store, "whatsapp", "5511999999@s.whatsapp.net", "7");
    f.store.run("INSERT INTO conversations VALUES ('7','teste')");
    dispatch(f);
    f.setObserved({ data: { run_id: "run-1", status: "RUNNING" } });
    await f.jobs.tick();
    const requestsBefore = requestCount(f);
    const submissionsBefore = f.submissions.length;
    const reply = await askJob(f);
    assert.match(reply, /Job 1/);
    assert.match(reply, /run-1/);
    assert.match(reply, /RUNNING/);
    assert.match(reply, /since dispatch/);
    assert.match(reply, /Last observed/);
    assert.equal(requestCount(f), requestsBefore, "no request row");
    assert.equal(
      f.submissions.length,
      submissionsBefore,
      "no model turn for /job",
    );
  } finally {
    await f.close();
  }
});

test("/job answers for a done job with the PR URL", async () => {
  const f = await fixture();
  try {
    bindChannelChat(f.store, "whatsapp", "5511999999@s.whatsapp.net", "7");
    f.store.run("INSERT INTO conversations VALUES ('7','teste')");
    dispatch(f);
    f.setObserved({
      data: {
        run_id: "run-1",
        status: "COMPLETED",
        result: { answer: "pr aberto", pr: PR },
      },
    });
    await f.jobs.tick();
    const reply = await askJob(f);
    assert.match(reply, /DONE/);
    assert.ok(reply.includes(PR));
    assert.match(reply, /Last observed/);
  } finally {
    await f.close();
  }
});

test("/job answers for a failed job with the error", async () => {
  const f = await fixture();
  try {
    bindChannelChat(f.store, "whatsapp", "5511999999@s.whatsapp.net", "7");
    f.store.run("INSERT INTO conversations VALUES ('7','teste')");
    dispatch(f);
    f.setObserved({
      data: {
        run_id: "run-1",
        status: "FAILED",
        error: "browser crashed at step 3",
      },
    });
    await f.jobs.tick();
    const reply = await askJob(f);
    assert.match(reply, /FAILED/);
    assert.match(reply, /browser crashed at step 3/);
  } finally {
    await f.close();
  }
});

test("/job with no job says so plainly", async () => {
  const f = await fixture();
  try {
    bindChannelChat(f.store, "whatsapp", "5511999999@s.whatsapp.net", "7");
    f.store.run("INSERT INTO conversations VALUES ('7','teste')");
    const reply = await askJob(f);
    assert.match(reply, /No asynchronous job/);
  } finally {
    await f.close();
  }
});

test("/job with a stale observation says a fresh check has not arrived", async () => {
  const f = await fixture();
  try {
    bindChannelChat(f.store, "whatsapp", "5511999999@s.whatsapp.net", "7");
    f.store.run("INSERT INTO conversations VALUES ('7','teste')");
    dispatch(f);
    f.setObserved({ data: { run_id: "run-1", status: "RUNNING" } });
    await f.jobs.tick();
    // The stored observation is now far older than the poll interval.
    f.store.run(
      "UPDATE pending_jobs SET last_seen_at=?",
      Date.now() - 10 * 60_000,
    );
    const reply = await askJob(f);
    assert.match(reply, /RUNNING/);
    assert.match(reply, /No fresh check has arrived yet/);
  } finally {
    await f.close();
  }
});

test("/job on a job never observed says no observation has arrived", async () => {
  const f = await fixture();
  try {
    bindChannelChat(f.store, "whatsapp", "5511999999@s.whatsapp.net", "7");
    f.store.run("INSERT INTO conversations VALUES ('7','teste')");
    dispatch(f);
    const reply = await askJob(f);
    assert.match(reply, /Job 1/);
    assert.match(reply, /not observed yet/);
    assert.match(reply, /No observation has arrived yet/);
  } finally {
    await f.close();
  }
});

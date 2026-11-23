# Async jobs

A tool that starts a job outliving the turn — a browser automation, a batch, a render — is
registered when it is dispatched, watched by a worker, and delivered once in the topic that
asked for it. The core knows state, queue, dedupe and delivery; **every provider detail lives
in a manifest**, so adding an integration does not touch code.

## Adding an integration

Declare the tool that starts the job, the tool that reads it, and where the fields live:

```json
[
  {
    "tool": "tools.tinyfish.agent.automation.runAsync",
    "dispatch": { "mode": "immediate", "idPath": "value.run_id" },
    "observe": {
      "mode": "poll",
      "tool": "tools.tinyfish.agent.runs.getRunById",
      "args": {
        "accountId": "${accountId}",
        "input": { "path": { "id": "${job_id}" } }
      },
      "statePath": "status",
      "resultPath": "result",
      "errorPath": "error"
    },
    "poll": {
      "intervalSeconds": 25,
      "backoff": [25, 60, 150],
      "maxAttempts": 3
    },
    "graceMinutes": 5
  }
]
```

Put it in `ASYNC_JOB_MANIFESTS` (a JSON array, passed via `.env` / `env_file`).

Every v2 read is `{ accountId, input }`. The account is the one the dispatch
passed (`accountId` on `runAsync` / `call`). If that call has none, the poller
asks Executor `search` for the namespace and uses the account only when there
is exactly one. Zero accounts is `missing_account`; two or more is
`ambiguous_account`. Neither guesses, and both tell the topic.

| Field                                            | Meaning                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `tool`                                           | path that starts the job, as the Executor sees it                                       |
| `dispatch.mode`                                  | `immediate` (id in the response), `deferred` (id arrives later), `opaque` (no id)       |
| `dispatch.idPath`                                | dotted path to the id, e.g. `value.run_id`                                              |
| `observe.mode`                                   | `poll` (one id) or `reconcile` (a search, needs `match`). There is no webhook ingress.  |
| `observe.tool` / `observe.args`                  | how the job is read; `${id}`, `${goal}`, `${row}`, `${since}`, `${now}` are substituted |
| `observe.statePath` / `resultPath` / `errorPath` | dotted paths inside the observed payload                                                |
| `observe.states`                                 | extra vocabulary, e.g. `{ "failed": ["TIMED_OUT"] }`                                    |
| `poll`                                           | seconds between reads and the backoff ladder                                            |
| `graceMinutes`                                   | how long a job may be missing before the operator hears about it                        |

Without `states`, the vocabulary below is assumed (case and separators ignored):

```
pending    PENDING QUEUED WAITING CREATED
running    RUNNING IN_PROGRESS STARTED ACTIVE
done       COMPLETED COMPLETE SUCCESS SUCCEEDED DONE FINISHED
failed     FAILED ERROR TIMED_OUT TIMEOUT REJECTED
cancelled  CANCELLED CANCELED ABORTED STOPPED REVOKED
```

Anything else is `unknown`, which is **silence**, never a failure.

## Built-in: Executor v2

The TinyFish manifest above is registered with no configuration at all: v2 binds the account in
the tool's own signature, so nothing has to be filled in. Every v2 job call is scoped to one account,
which is why the id is required.

## Guarantees

1. the row is created **before** the dispatch, so a lost response is still covered;
2. delivery is at-least-once with a stable request id (`job:<row>:<run>`) — settlement and
   the worker converge on one message. The turn that summarizes a finished job does not
   deliver its final text; it calls `notify` to post in the topic. A runner failure
   (the turn itself faulting, or the poller giving up) is still posted by the system
   with the cause, and does not depend on that call;
3. `unknown` is not `failed`: a job that is not visible yet is silence until `graceMinutes`;
4. the Executor's own envelope status is never read as the job's status — the status comes
   from the object that carries the job id;
5. a failing read keeps the row open, backs off, and warns once at the ceiling instead of
   going quiet for ever;
6. a finished job whose payload carries no result becomes `expired`, once, with a notice;
7. the worker never dispatches: it only reads and delivers;
8. provider read failures (`poll_attempts`) and delivery failures (`delivery_attempts`) are counted separately. Three failed reads do not expire a finished result. Three rejected deliveries do. A successful read clears only `poll_attempts`. Delivery uses the stable request id `job:<row>:<run>`, which the runtime dedupes.

The Telegram text is HTML. A 400 whose `description` says the entities cannot be parsed is sent once more as plain text, to the same chat, topic and reply. The row is marked sent only when that second call succeeds; the refused call did not deliver a copy. Any other refusal, including a non-parse 400 such as chat not found or blocked, stays failed and is not resent. That `description` is stored on the failed row and written to the log after the secret redactor. No new environment variable is read. Who is notified, and whether a run stays silent, is unchanged.

## Counters, retention, and old databases

`poll_attempts` and `delivery_attempts` are the live counters. The old `attempts` column is left in place and is not written. On a database from before the split, `poll_attempts` is copied from `attempts` and `delivery_attempts` starts at 0. On a database that already held rows (`legacy_attempts_unknown` and the other holds), every hold is cleared and the row returns to normal polling. For `legacy_attempts_unknown`, `poll_attempts` is taken from `attempts` again and `delivery_attempts` is set to 0. The migration is idempotent: a later boot does not reset counters on a row that is no longer held. Holds no longer block deleting a conversation.

Finished rows (`delivered_at` set) older than 30 days are deleted. Open rows are kept. There is no environment variable for the window.

A poller tick that throws is recorded on `health().last_tick_error` and logged at most once a minute for the same message. A later successful tick does not clear that error, and nothing is sent to the chat.

## Which Executor

The supported one is **v2, the cloud build** (`https://mcp.executor.sh/mcp`):
integrations are Executor apps, and their approval policy is part of the app — a tool that must
return a value to the caller (like `agent.automation.runAsync`) is declared without approval,
because an approval pause drops that value on resume. The bot relays that pause and does not
add a second approval of its own. An interactive pause is the existing card. A scheduled run
cannot wait, so an approval-required pause fails that call and resume is not sent.

## Migrating from v1

`ASYNC_JOB_TOOLS` and `EXECUTOR_ACCOUNT_ID` are not read. A job is a manifest in
`ASYNC_JOB_MANIFESTS`, or the built-in TinyFish / Instabox manifests. The account
is taken from the call that started the job.

What changed in the v2 path:

|          | v1                                               | v2                                                 |
| -------- | ------------------------------------------------ | -------------------------------------------------- |
| dispatch | `tinyfish_mcp.user.example.run_web_automation`   | `tools.tinyfish.agent.automation.runAsync`         |
| read     | `list_runs` with a time window and a goal suffix | `getRunById` with `input.path.id`                  |
| id       | `runId` at the top level                         | `value.run_id`                                     |
| envelope | `{ status, result: "<json string>" }`            | `{ status, execution: { ok, value, error } }`      |
| status   | `COMPLETED`                                      | `COMPLETED` (same words, manifest maps them)       |
| program  | any                                              | pure JS: a TypeScript annotation is a `ParseError` |

`session_id` (and its `tf-` prefix) no longer exists. `send_attachment` and the approval card
are unchanged.

### Instabox (sandbox lifecycle)

Creating or resuming a sandbox returns an operation, not a finished machine. Declare it so the
topic that asked is told when the machine is ready:

```json
{
  "tool": "tools.instabox.machines.create",
  "dispatch": { "mode": "immediate", "idPath": "id" },
  "observe": {
    "mode": "poll",
    "tool": "tools.instabox.operations.get",
    "args": {
      "accountId": "acc_...",
      "input": { "id": "${id}", "wait": "25s" }
    },
    "statePath": "state",
    "resultPath": "machine",
    "errorPath": "error"
  },
  "poll": { "intervalSeconds": 5, "backoff": [5, 15, 30], "maxAttempts": 3 },
  "graceMinutes": 5
}
```

`machines.exec` is synchronous (up to 600 s) and needs no manifest; wrap long builds in
`nohup` and register the work with the job tools instead.

### Sandbox code tasks (`sandbox_code_task`)

`sandbox_code_task` supports only Instabox. The block in `config.default.yaml`, the `INSTABOX_*` variables, and the scripts in `scripts/instabox/` are specific to that provider. Pointing the YAML at another sandbox does not make the bot use it.

```yaml
sandbox_code_task:
  tool: sandbox_code_task
  job: "internal.instabox.codeTask" # manifest in async_jobs
  server: executor # executor uses `execute` + tools.*; other servers are called directly
  goal: prompt
  idPrefix: "cj-"
  exec:
    tool: "tools.instabox.machines.exec"
    args:
      accountId: "${INSTABOX_ACCOUNT_ID}"
      input:
        id: "${INSTABOX_MACHINE_ID}"
        cmd: "bash ~/bin/start-job.sh ${job_id}"
        timeoutSeconds: 15
        stdin: "${payload}" # model parameters as JSON
  parameters: # JSON Schema for the model's call
    type: object
    required: [repo, agent, prompt]
    properties:
      repo: { type: string }
      agent: { type: string, enum: [agy, pi, claude] }
      prompt: { type: string }
      branch: { type: string }
      writes: { type: boolean } # only true is accepted; approval is required before execution
  allow:
    field: repo
    # patterns is empty in config.default.yaml. Set it here or via
    # INSTABOX_REPO_ALLOWLIST. Example only, not a shipped default:
    patterns: "example/*"
```

- The shared Instabox rejects `writes: false` or an omitted value before contacting the sandbox. It runs under the account that holds write credentials; moving files or clearing environment variables does not isolate the agent. Use a separate environment without write credentials for read-only tasks.
- With `writes: true`, the tool returns `{ status: "approval_pending" }`. Only after approval does it generate a `jobId` (`<idPrefix><timestamp-base36>-<random>`), write a row to `pending_jobs`, and call the sandbox. Only the ID goes into the command; parameters are passed as JSON on stdin.
- The poller uses the manifest's `job` entry to read status. By default it reads `/data/home/jobs/${id}/status.json` through `tools.instabox.machines.readFiles` every 20 seconds with backoff. Executor's `status:"completed"` describes the call envelope, not the job. A missing status file (404) during the grace period is not reported.
- When the job finishes, the poller delivers the result in a new turn in the original topic. It can include the pull request link (`result.pr`) and branch name. The model treats the result as data, not instructions, and cites only full `https://github.com/...` links.
- The approval card shows the repository, agent, branch, and a short prompt excerpt. Declining does not start a job.
- Existing `instabox_code_task` rows still resolve through the default `tool: internal.instabox.codeTask` manifest.

**Install on the Instabox machine:**

1. Copy the versioned scripts to `~/bin/` and make them executable:
   ```bash
   mkdir -p ~/bin
   cp scripts/instabox/*.sh ~/bin/
   chmod +x ~/bin/*.sh
   ```
2. Configure `~/.agents-env.sh` with the required credentials (GitHub CLI authentication and API keys for the CLI agents):
   ```bash
   # ~/.agents-env.sh
   export GITHUB_TOKEN="..."
   export ANTHROPIC_API_KEY="..."
   export OPENAI_API_KEY="..."
   ```
3. Install `git`, `gh`, `node`, and the CLI agents (`agy`, `pi`, and `claude`) in the sandbox.
4. Before re-enabling an older installation, stop old jobs, update the bot, and install both new scripts. Remove the legacy `sandbox_code_task.readonly` setting and any `JOB_READONLY=1` prefix from custom commands. If jobs ran without approval, treat the machine's write credentials as potentially exposed and rotate them.
5. Restrict direct terminal and execution API access to authorized operators. The scripts reject jobs without `writes: true`, but the bot, not the machine, verifies approval.

**Environment variables:**

- `INSTABOX_MACHINE_ID`: Optional. Without it, discovery selects a machine only when exactly one is running. Zero or multiple running machines produce an error with the list. There is no default name.
- `INSTABOX_ACCOUNT_ID`: Optional. Without it, discovery uses the only matching account. Multiple accounts produce an error.
- `INSTABOX_REPO_ALLOWLIST`: Overrides `sandbox_code_task.allow.patterns`. The default is empty: nothing is allowed until the operator sets the list in `$DATA_DIR/config.yaml` or this variable. Use comma-separated values. For example, `owner/*` matches that owner's repositories. The environment variable takes precedence over the file.
- `MCP_CALL_TIMEOUT_MS`: MCP tool call timeout (default `60000` ms).
- `ASYNC_JOB_TIMEOUT_MIN`: Overrides `async_job.timeout_min` (default `25`).
- `ASYNC_JOB_POLL_SECONDS`: Overrides `async_job.poll_seconds` (default `25`).
- `ASYNC_JOB_READ_TIMEOUT_MS`: Poller read timeout (default `20000` ms).

## After an approval

Approving or declining an MCP card in the chat records the outcome as a system turn. The assistant's final text in that turn is delivered in the same chat, on the same path as a job the user started. A blank reply sends nothing. Any other system turn stays silent. The **Succeeded** / **Did not run** check sends only “Verification recorded. Nothing was resent.” That system turn does not deliver the assistant's text.

## A task id with no manifest

A tool can return only a task id, with no row in `pending_jobs`, when the tool is not in an async job manifest. Nothing is watching that id. The assistant must not say it will come back. It does one of these:

1. Keep reading the id in the same turn, for at most about 50 seconds. `execute` stops at 60.
2. If the tool is in a manifest, the poller delivers the result in this chat. No second check.
3. Otherwise, from a user turn, one `tasks_create` with `kind: once` in this chat. The schedule's prompt checks that same id and calls `notify`. `notify` posts in the chat that created the schedule. A scheduled run still speaks only through `notify`; this does not change that silence.

A scheduled or system turn cannot create that check. It polls inside the turn, or it says the result is not in yet. It still does not promise to return.

The tool result carries a short note in these two cases, so the instruction sits next to the id.

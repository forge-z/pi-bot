# Uncertain MCP outcomes

When a write is dispatched but no outcome is known (timeout, dropped connection, or lost session after dispatch), its row in `mcp_calls` becomes `uncertain`. An explicit tool error (`isError`) or a response that fails schema validation is `failed`: the model sees the error without a chat notice. SQLite preserves the state across restarts. The write is not resent. Uncertainty blocks further actions **on that server**, not on other servers in the conversation. Reads stay available and neither become uncertain nor clear the uncertainty.

Executor decides whether it needs approval; the bot forwards the pause. The read/write classification still governs uncertain outcomes, timeouts, and retries.

`/resume` marks all uncertain calls in the conversation `skipped`, logs the change, and warns that the original call may already have run. It also resumes a task parked after an interruption; when both conditions apply, it handles them in one reply. The verification card is sent only once, and `/status` only lists the state. The card shows the server and tool; **Details** shows the target and parameters. If the content had to be withheld, the card does not offer confirmation and points to `/resume`.

## What counts as a read

The globs are in `config.default.yaml` (`mcp_servers.*.tools.read` and `tools.write`). Write globs win: `**.*create*`, `**.*send*`, `**.*delete*`, and `**.*update*` are writes even if the name also matches `**.get*` (e.g. `get_or_create`). A server with its own list must declare `search`, `describe`, and `skills` itself. Direct `call`, a `calls` batch, and an `execution` envelope share the path collector. A batch is read-only only if every path is a read.

An `execute` or `call` program counts as a read where name-based classification applies and every resolved call is a read. Direct calls such as `tools.a.b(...)` and `pick("...")`, simple `const`, `let`, and `var` aliases such as `X = tools.a.b` followed by `X.method(` or `X.c.method(`, and destructuring such as `const { getContent } = tools.github.repos` can be resolved. Bracket access such as `tools["a"]`, any unresolvable use, or a single write makes the program a write. Scheduled runs and subagents require reads declared by the server; these name-based rules alone do not authorize them. `resume` is never a read, and only a human decision through `decide` dispatches it.

If the globs do not match, a read verb that is its own camelCase word can make the leaf a read: `get`, `list`, `fetch`, `search`, `read`, `describe`, `extract`, `query`, `find`, `status`, `usage`, or `metrics`. A write verb takes precedence: `create`, `update`, `delete`, `send`, `post`, `publish`, `remove`, `exec`, `run`, `start`, `stop`, `upload`, `write`, `set`, `put`, `patch`, `merge`, `purge`, or `revoke`. A trailing HTTP `Post` next to a read verb (as in `v1ExtractPost` or `SearchPost`) is not a write. An explicit read glob still wins over name-based classification.

## What is not uncertain

`McpNotSentError` and `PolicyError` occur before dispatch and are recorded as `failed`. So are Executor `InputInvalid` or `UnknownTool` rejections (including HTTP 422) with no successful `toolCalls`; their notices say nothing was dispatched. A returned tool error or a response that fails schema validation is `failed`. A transport failure can retry a read, never a write.

On startup, old `mcp-stage:*` rows are removed. A `running` read becomes `failed`; a `running` write becomes `uncertain`.

## After approval

Approving or declining a chat card starts a system turn whose final text is delivered in that chat. An empty reply is not sent. The **Succeeded** / **Did not run** check does not resend the call. It sends only “Verification recorded. Nothing was resent.” and the system turn stays silent. The row keeps the original result and stores verification beside it. No generic read can verify the write on its own.

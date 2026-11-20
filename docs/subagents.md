# Subagents

A subagent is a child conversation the assistant starts from a tool call. It does one self-contained task and returns only its final text. The large reads it made (search results, long documents) stay in the child and never enter the main conversation, so later turns carry less context.

The feature is off by default. With it off, the system prompt and the tool list are exactly what they were before.

## When the model delegates

While the feature is on, the system prompt has one fixed rule. The model uses `subagent` for read-only work that needs many tool calls or large reads: broad research across several sources, reading long documents or many results, comparing options. It does not delegate a quick reply, a single lookup, or anything that changes data, sends messages, schedules, or needs approval. When the user asks for a subagent, it uses one.

Example request: "compare three public RSS readers and tell me which one has the best OPML import". The model may send one task per reader to `subagent` and write the comparison itself from the three answers.

The tool takes either `task` (one text) or `tasks` (a list of `{ "task": "..." }`, up to `max_parallel`). The tasks of one call run at the same time. Answers come back in order, as `## Tarefa 1`, `## Tarefa 2`, and so on. A task that fails does not drop the others: it shows as `[tarefa 2 sem resposta: turn_limit]`, for example. Each answer is cut at about 6000 characters.

## Configuration

In `$DATA_DIR/config.yaml`. Read at startup, so a change needs a restart.

```yaml
subagents:
  enabled: false # true registers the tool
  max_parallel: 3 # tasks per call, 1 to 3
  max_turns: 8 # tool rounds per child, 1 to 20
  thinking: low # off, minimal, low, medium or high
```

An invalid value is logged and keeps its default. No environment variable is involved.

## What a subagent can do

- It uses the same model as the conversation that called it, with the `thinking` level above.
- It sees the MCP tools, plus `tool_search` when some MCP tool is deferred. It does not see `subagent`, `progress`, `notify`, `tasks_*`, `ask_user`, `send_attachment`, `sandbox_code_task`, `conversation_usage` or `read_skill`.
- It does not see the conversation. The task text must carry everything it needs.
- It only reads. Every MCP call that is not a read is refused before it is sent, on every server, Executor included. The read and write lists are the same ones a scheduled run uses (`mcp_servers.*.tools` in `config.yaml`).
- It runs like a scheduled run: an approval pause or a URL step is skipped and no card is shown, no async job is registered, and a file an MCP tool returns is replaced by one line of text. Nothing is sent to the chat.
- After `max_turns` tool rounds it stops without an answer, and the caller sees `turn_limit`.

There is no clock limit of its own. `max_turns`, the MCP call deadlines and `/stop` bound it.

## Stopping

`/stop` in the chat stops the topic's running subagents and cancels their MCP calls. The tool then returns `[tarefa 1 interrompida]` and the assistant ends its turn. Cancelling the parent's tool call also aborts its children.

## Restart and deletion

A child is recorded in the durable history with its parent's tool call as owner. If the bot restarts during a subagent, the tool runs again, finds the same children, and reuses the submissions it already made, so the parent gets each answer once. Children are not listed as conversations. A permanent purge of a conversation also removes its subagents.

## Usage

The child's tokens are recorded in the child's own ledger. The tool result never carries usage, so nothing is counted twice.

- `/status` shows `Usage: 12,345 tokens · $0.0123 · subagentes: 4,000 tokens · $0.0040` when the topic has run subagents. Without them, the line is unchanged.
- `conversation_usage` keeps its own figures for the conversation and adds `subagents` (`conversations`, `tokens`, `cacheHitRate`, `usd`) and `withSubagents` (the sum) only when there are children.

## Measuring whether it helps

Each child pays its own prompt prefix, which includes the MCP server metadata. Three in parallel pay it three times. Measure before relying on it:

1. Pick about five fictitious research tasks and one follow-up question for each.
2. Run them in new conversations with `enabled: false`, then again with `enabled: true`.
3. After each conversation, read `/status` and ask for `conversation_usage`. Compare:
   - the parent's prompt tokens on the follow-up turn, which is the context the parent carries forward;
   - `cacheHitRate` of the parent and of `subagents`; from the second delegation on, the child prefix should hit the cache;
   - total tokens and USD (`withSubagents`);
   - wall-clock time, and how often the model delegated a request that was short.

## Limits

- One level only: a subagent cannot start another.
- Foreground only: the parent's turn waits for the answers.
- Parallel subagents may call the same MCP server at the same time.

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.3] - 2026-11-23

### Added

- **Text model** setup offers an optional fallback model from the same or another official provider. The bot tries it when a text model request errors, times out, or is rate-limited, without changing the primary selection.
- **MCP platform → Executor → OAuth** signs in to a scoped Executor Cloud connection. Setup verifies the grant before enabling tools, and credentials refresh automatically. Token sign-in remains available.
- `web_extract` returns `publishedDate` from provider metadata, or `null` when no date is available.

### Changed

- Package version is 0.5.3. The MCP client announces that same version.
- Native web tools warn on their first call when they skip providers without API keys and name the missing environment variables. If none of the configured providers has the required key, the tool returns an explicit error so the assistant can use an available MCP tool.

## [0.5.2] - 2026-11-23

### Changed

- Package version is 0.5.2. The MCP client announces that same version.
- Setup, diagnostics, built-in tool output, and chat messages use English. Setup no longer accepts Portuguese menu choices or yes/no answers. User and model content is unchanged.
- Native web search and extraction now try the configured fallback when the primary succeeds but returns no results or no readable text.
- Today’s and yesterday’s daily memory notes are included in chat and scheduled prompts, up to 2 KB per day, so recent notes no longer require a `memory_search` call.

### Added

- Telegram and WhatsApp approval cards for a reviewable read offer "Always allow this". The rule is one MCP server, one held tool, the resource the arguments name (calendar, folder, repository, ...) and the credential binding, stored in SQLite with date and origin. A matching read is resumed without a card, also in scheduled runs, and counts as remembered in `/receipt`. `/approvals` lists rules and `/revoke <n>` removes one. Writes, sends, deletions and payments never get the button.
- Telegram and WhatsApp can show per-turn tool, approval, search, token, and model-cost metadata with `/receipt [n]`. The SQLite receipt does not copy conversation text, arguments, page content, or keys. The reply footer is off by default.
- Native `web_search` and `web_extract` read tools, including in scheduled runs. The **Web search** setup section saves credentials and provider order; Exa is the default and Firecrawl handles failures. With no available provider, the assistant keeps using its MCP tools.
- The **Web search** setup now offers numbered primary and fallback menus for eight search providers and seven hosted extractors. Keyless **Local** extraction uses Piko's Readability-to-Markdown approach on public HTML pages.
- Long-term memory in editable Markdown on the data volume. The idle curator uses the conversation's model by default and does not run from schedules. Daily notes are searchable with `memory_search`; Telegram and WhatsApp support `/memory` and `/forget <text>`.

### Security

- Subagents, the scheduled write gate, and the resend after a transport failure use a declared read: a `read` glob of the server's own list (or the Executor lists it inherits) and no `write` glob, or `readOnlyHint` on a `trusted` server. Name words, `execute` programs, and `call` targets written as code no longer count. A server with its own list must list `search`, `describe`, and `skills` itself.
- The scheduled write gate passes the server name, so a server with its own `tools` list is checked against that list instead of the Executor list.
- The uncertain-call notice trusts the `uncertain` state recorded at send instead of classifying the call again with the current config.
- WhatsApp sends a URL-only MCP attachment only from a host in `whatsapp.attachment_urls.hosts` (empty by default): HTTPS, no credentials in the URL, every redirect checked against the list, up to 3 redirects, `timeout_seconds` (20) and `max_mb` (16) enforced while downloading.

### Fixed

- Setup and doctor report the config path and ownership when web settings cannot be written. A config file the gateway cannot read now stops startup instead of silently using defaults.
- Docker Compose repairs ownership and owner access for the volume's config and SQLite files before starting the unprivileged gateway.
- WhatsApp numbered approval replies only decide the specific pending request after its full prompt was sent to the replying chat. Replies from another JID, or before successful delivery, leave the action pending.
- Telegram messages waiting for a transient retry keep later messages in the same chat/topic behind them. Other chats, topics, and callback queries continue independently.

## 0.5.1 - 2026-11-20

### Fixed

- An `execute` program is a read when every resolved call is a read. A simple alias counts: `const`, `let`, or `var` with `X = tools.a.b`, then `X.method(` or `X.c.method(`, and `const { getContent } = tools.github.repos`. Brackets and any use that does not resolve stay writes. One write call makes the program a write.
- A leaf the read globs miss is a read when a read verb is its own camelCase word: `get`, `list`, `fetch`, `search`, `read`, `describe`, `extract`, `query`, `find`, `status`, `usage`, `metrics` (`inboxesMessagesList`, `v1ExtractPost`). A write verb in that leaf stays a write (`create`, `update`, `delete`, `send`, `post`, `publish`, `remove`, `exec`, `run`, `start`, `stop`, `upload`, `write`, `set`, `put`, `patch`, `merge`, `purge`, `revoke`). A trailing HTTP `Post` next to a read verb (`ExtractPost`, `SearchPost`) is not a write. `createOrUpdateFileContents`, `machines.exec`, `automation.run`, and `messages.send` stay writes. An explicit read glob still wins, so `getRunById` stays a read.
- Confirming an uncertain call ("Succeeded" / "Did not run") keeps the original result on the row and stores the verification note beside it.

### Changed

- Package version is 0.5.1. The MCP client announces that same version.

## 0.5.0 - 2026-11-20

### Added

- Optional `subagent` tool, off by default (`subagents.enabled` in `config.yaml`, restart to apply). It runs one task, or up to three in parallel, in child conversations that use the same model, see only MCP tools, and refuse every MCP call that is not a read before it is sent. The parent receives only each child's final text. `/stop` also stops running subagents, and `/status` and `conversation_usage` show their usage in a separate `subagents` block. With it off, the prompt and tool list are unchanged. See [docs/subagents.md](docs/subagents.md).
- A long user task can post a short `progress` note in the originating Telegram or WhatsApp chat before the turn ends. The first note names the first step. Later notes are only a result, a blocker, or a changed plan, at most one every 30 seconds and three per task. A quick reply sends none. Scheduled runs stay silent unless they call `notify`.

### Fixed

- An MCP approval the user decides in the chat delivers the assistant's follow-up in that chat. A blank follow-up sends nothing. Other system turns stay silent, including the "Succeeded" / "Did not run" check.

### Changed

- A tool result that is only a pending task id, with no async job manifest, is not a promise to return. The assistant polls within the turn for about 50 seconds (`execute` stops at 60), uses the registered job when one exists, or, from a user turn, creates one one-shot schedule that calls `notify` in the same chat. Scheduled runs still speak only through `notify`.
- The eyes reaction waits 4 seconds (`reaction_delay_ms` in `config.yaml`) and is cancelled when that turn's first reply is sent. `0` reacts immediately, as before. No new environment variable.
- Package version is 0.5.0. The MCP client announces that same version.
- `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/chord` are 1.6.0, with `pi-codemode`, `pi-schema`, and `pi-telemetry` at the same version. SQLite schema stays 2. A conversation this release writes stores `pi.tool` at version 4 and `pi.generation` at version 3; an older image blocks those tasks. The OpenAI, Azure, and Codex catalogs include GPT-6.2 Astra and GPT-6.2 Sol, which do not accept thinking level `off`. A saved model stays selected. No new environment variable.

## [0.4.0] - 2026-11-18

Beta. The README calls the project beta: usable day to day, with configuration and commands that may still change between releases.

### Added

- WhatsApp gateway (Baileys): one phone gateway per install, Telegram or WhatsApp. The session stays on the volume, pairing is a QR or a code, text commands match Telegram, and a schedule created on WhatsApp delivers to the bound chat. No new environment variable is required to boot. ([#18](https://github.com/forge-z/pi-bot/pull/18), [#20](https://github.com/forge-z/pi-bot/pull/20))
- Upsy as an MCP provider over OAuth 2.1 with PKCE and no API key. Tokens stay in the volume credential `mcp-upsy` and refresh on their own. A self-hosted MCP URL takes an optional token and header (`SELF_HOSTED_MCP_URL`, `SELF_HOSTED_TOKEN`, `SELF_HOSTED_HEADER`). ([#16](https://github.com/forge-z/pi-bot/pull/16))
- Operator skills on the volume. The prompt lists each name and description; `read_skill` loads a body on demand. ([#11](https://github.com/forge-z/pi-bot/pull/11), [#16](https://github.com/forge-z/pi-bot/pull/16))
- `/status` reports usage for the current topic, and `/compact` compacts that topic on demand. ([#16](https://github.com/forge-z/pi-bot/pull/16))
- `ask_user` question cards, Ollama thinking levels, and a single eyes reaction when a turn starts. ([#15](https://github.com/forge-z/pi-bot/pull/15))
- Read-only sandbox jobs, selected with `JOB_READONLY=1`, `writes: false`, or a readonly marker on the job directory. ([#17](https://github.com/forge-z/pi-bot/pull/17))
- GitHub Pages landing in English and Portuguese, then a redesign around the existing wordmark. ([#21](https://github.com/forge-z/pi-bot/pull/21), [#22](https://github.com/forge-z/pi-bot/pull/22))

### Changed

- Package version is 0.4.0. The MCP client announces that same version.
- Status in both READMEs moves from alpha to beta.
- The "There's an API or MCP for that" section is restored, including Exa and Parallel. The product name is Pi Bot, the wordmark is on the README, and links point at this repository. ([#8](https://github.com/forge-z/pi-bot/pull/8), [#9](https://github.com/forge-z/pi-bot/pull/9))
- Each provider request stays an exact prefix of the next. The clock, the delivery note, and MCP schema key order no longer split a cached prompt. ([#10](https://github.com/forge-z/pi-bot/pull/10))
- Executor decides which of its calls need approval, and the bot relays that pause. A scheduled run that needs approval fails with the tool path and posts no card. ([#12](https://github.com/forge-z/pi-bot/pull/12))
- The Compose service is `pi-bot` and the named volume is `pi_bot_data`. A renamed volume starts empty; copy the previous volume across to keep data. ([#13](https://github.com/forge-z/pi-bot/pull/13))
- `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/chord` are 1.5.2. ([#14](https://github.com/forge-z/pi-bot/pull/14))
- WhatsApp docs cover the extra 9 on Brazilian mobile numbers. Setup stores the digits as typed. Inbound matching treats the two forms of the same number as one, and a LID is left as-is. ([#20](https://github.com/forge-z/pi-bot/pull/20))

### Fixed

- A returned MCP error stays with the model. Reads are not marked uncertain. A read dropped on the transport is retried twice; a write is never resent. One card is posted only for a write whose outcome is unknown. ([#15](https://github.com/forge-z/pi-bot/pull/15))
- When Telegram rejects a delivery because it cannot parse HTML, that same delivery is sent once as plain text to the same chat, topic, and reply. `Bearer` and `sk-` tokens are masked before they are logged. A stored MCP list that still has `cuaViewer` fails validation. ([#17](https://github.com/forge-z/pi-bot/pull/17))
- The Upsy access token stays off the server entry and is attached only for Upsy's own URL. Discovery rejects a resource or issuer that differs from the one that was requested. ([#16](https://github.com/forge-z/pi-bot/pull/16), [#17](https://github.com/forge-z/pi-bot/pull/17))
- Symbols used only inside their own file are no longer exported, the unused `setup-model` script alias is removed, and the secret scan ignores the historical synthetic bearer in the redaction test. ([#19](https://github.com/forge-z/pi-bot/pull/19))

## [0.3.0] - 2026-11-10

Alpha. At this commit the README still calls the project alpha. `package.json` is `0.3.0`.

### Added

- `npm run setup` stores the menu on the volume: gateway (Telegram), text, image, and audio models, then the MCP platform (Executor, Composio, both, or none). The bot token and allowlist live on the volume. A set environment variable wins. `TZ` stays an environment variable. ([#7](https://github.com/forge-z/pi-bot/pull/7))
- Composio sits beside Executor as an MCP aggregator. Aggregator credentials stay on the volume, and setup does not print secrets. ([#7](https://github.com/forge-z/pi-bot/pull/7))
- The sandbox code task and the job manifests come from `config.default.yaml`. A sandbox write waits for approval. ([#7](https://github.com/forge-z/pi-bot/pull/7))
- Heartbeat and progress notes for long MCP calls. ([#7](https://github.com/forge-z/pi-bot/pull/7))

### Changed

- Package version is 0.3.0. ([#7](https://github.com/forge-z/pi-bot/pull/7))
- `/resume` is the command for a crash-parked task and for an uncertain MCP result. ([#7](https://github.com/forge-z/pi-bot/pull/7))
- Bot text is English. The command menu is `/model`, `/thinking`, `/crons`, `/new`, `/resume`, `/stop`, `/status`, `/help`. ([#7](https://github.com/forge-z/pi-bot/pull/7))
- Job poll attempts and delivery attempts are separate counters. Finished rows older than 30 days are pruned. Completions of jobs the user started are delivered. ([#7](https://github.com/forge-z/pi-bot/pull/7))

### Fixed

- An uncertain MCP action stays behind a readable card. A known batch of reads stays read-only. An Executor envelope rejection leaves the conversation unlocked. ([#7](https://github.com/forge-z/pi-bot/pull/7))
- A proved refusal reports that nothing was dispatched. The job row closes when dispatch attaches no `run_id`. Each poller error is logged, including a missing status. ([#7](https://github.com/forge-z/pi-bot/pull/7))
- The shell scripts keep the executable bit. ([#7](https://github.com/forge-z/pi-bot/pull/7))

## [0.2.0] - 2026-11-09

Alpha. At this commit the README still calls the project alpha.

### Added

- Telegram assistant in one container: `npm run setup`, vision and audio routing, and `/status`. Photos from Telegram reach the model as image parts, and a tool that produces a file (audio, voice, photo, or document) delivers it back to the chat.
- Schedules, including a run-now action from `/crons`, and async jobs with Executor v2 approval cards.
- A message sent during a live turn is steered into that turn. `instabox_code_task` starts a sandbox job and the poller delivers the result, including a pull request link. Job reads take the account from the call. ([#1](https://github.com/forge-z/pi-bot/pull/1), [#2](https://github.com/forge-z/pi-bot/pull/2))
- Pi 1.4.0. Scheduled runs speak only through `notify`. A Telegram reply or quote is part of the turn. ([#3](https://github.com/forge-z/pi-bot/pull/3))
- ChatGPT/Codex OAuth via `npm run login`, and Pi 1.5.0. ([#4](https://github.com/forge-z/pi-bot/pull/4))
- `/reload` and `/status`, official pi-ai providers as the primary model path, optional deferred MCP, and usage for the current conversation. ([#5](https://github.com/forge-z/pi-bot/pull/5))
- Alpha notice in both READMEs. ([#6](https://github.com/forge-z/pi-bot/pull/6))

### Changed

- Compose asks only for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS`.
- Job reads use the account on the dispatch. `ASYNC_JOB_TOOLS` and `EXECUTOR_ACCOUNT_ID` are unused. ([#1](https://github.com/forge-z/pi-bot/pull/1))
- Official providers are set with `npm run setup` or `npm run login`. A leftover `LLM_BASE_URL` / `LLM_API_KEY` pair leaves a complete official setup in place. ([#5](https://github.com/forge-z/pi-bot/pull/5))

### Fixed

- A scheduled run with nothing to say sends no message, including a short acknowledgement. The run is logged as `silencioso`.
- An uncertain MCP result can be cleared. Reads stay available, and a successful read clears the flag.
- An image a provider would refuse is dropped before it enters history, so one bad image does not fail later turns.
- An in-flight MCP call unlocks when its deadline passes, and recording the same job run id twice keeps the tool result. ([#1](https://github.com/forge-z/pi-bot/pull/1))

[Unreleased]: https://github.com/forge-z/pi-bot/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/forge-z/pi-bot/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/forge-z/pi-bot/compare/v0.4.0...v0.5.2
[0.4.0]: https://github.com/forge-z/pi-bot/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/forge-z/pi-bot/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/forge-z/pi-bot/releases/tag/v0.2.0

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-18

Beta. The README calls the project beta: usable day to day, with configuration and commands that may still change between releases.

pt-BR: 0.4.0 (beta) traz o gateway de WhatsApp, o OAuth do Upsy e a landing page.

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

pt-BR: 0.3.0 (alfa) grava a configuração no volume e aperta a recuperação de MCP, os jobs e o sandbox.

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

pt-BR: primeira versão pública (alfa) — assistente no Telegram, do setup e da agenda até jobs, sandbox e login do ChatGPT.

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

[Unreleased]: https://github.com/forge-z/pi-bot/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/forge-z/pi-bot/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/forge-z/pi-bot/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/forge-z/pi-bot/releases/tag/v0.2.0

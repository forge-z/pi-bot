<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/c-wordmark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo/c-wordmark-on-light.svg">
    <img alt="Pi Bot" src="assets/logo/c-wordmark-on-light.svg" width="360">
  </picture>
</p>

# Pi Bot

A personal AI assistant that lives in Telegram or WhatsApp: one container, one volume, no web panel. It runs on the [pi.dev](https://pi.dev) harness. Tools come from [Executor](https://executor.sh), [Composio](https://composio.dev), [Upsy](https://upsy.ai/docs), or a self-hosted MCP gateway.

**Status: Beta.** Usable day to day; configuration and commands may still change between releases.

[Landing page](https://forge-z.github.io/pi-bot/)

## Install

```sh
git clone https://github.com/forge-z/pi-bot.git
cd pi-bot
cp .env.example .env
docker compose up -d --build
```

No environment variable is required to boot. The image is read-only except for the volume at `/app/data` (`app.sqlite` and `durable.sqlite`).

## Configure

Run setup in the container before the bot is usable. A fresh container stays up and healthy while it waits.

```sh
docker exec -it <container> npm run setup
```

The menu edits one section at a time. **Save and back** writes that section. **Save and restart gateway** reloads the running bot from the volume.

1. **Setup gateway** — Telegram or WhatsApp, one per install. Saving one turns the other off. An install with no choice stays on Telegram. Yes/no questions prompt `(y/n)` and also accept `yes` and `no`. Telegram asks for the bot token (hidden; Enter keeps the saved value) and allowed numeric user ids. WhatsApp asks for the owner's number with country code and then a QR or a pairing code. The full path is in [WhatsApp](#whatsapp).
2. **Text model** — an official pi-ai provider, or `[0]` ChatGPT (Plus/Pro OAuth, no API key). `npm run login` is ChatGPT/Codex OAuth only.
3. **Image model**
4. **Audio model**
5. **MCP platform** — Composio, Executor, Upsy, Self-hosted, both (Executor plus Composio), or none.
6. **Web search** — native web search and page extraction providers and keys.

Upsy (`https://upsy.ai/connect`) has no API key. Setup prints a sign-in link. Paste the final browser URL back, even if the page does not load. The redirect is `http://127.0.0.1:33418/callback` and nothing listens there. Tokens stay in the volume credential `mcp-upsy` and refresh on their own. The same paste works in Telegram or WhatsApp for the bound chat. On WhatsApp the sign-in notice goes to that chat. `--aggregators upsy` does not start a login; it selects Upsy only when a refresh token is already stored. `npm run login` stays ChatGPT/Codex and is not this flow.

Self-hosted is one generic MCP URL, an optional token (credential `mcp-self-hosted`), and an optional header. An empty header sends `Authorization: Bearer`. Another name sends the raw token. An empty token sends no auth header. Optional overrides, none required: `SELF_HOSTED_MCP_URL`, `SELF_HOSTED_TOKEN`, `SELF_HOSTED_HEADER`. A set URL turns the server on even when the menu choice is something else. UsefulSoftwareCo/executor speaks Streamable HTTP at `<origin>/mcp` (local CLI `http://127.0.0.1:4312/mcp`, Docker `http://127.0.0.1:4400/mcp`) with a personal access token or local API key as `Authorization: Bearer`. The Executor menu item is still the one that keeps Executor's approval relay and jobs. runelay speaks Streamable HTTP at `<origin>/v1/mcp` (local app `http://127.0.0.1:4312/v1/mcp`) with a per-agent `rnl_…` key as `Authorization: Bearer`.

There is no `/login` command. ChatGPT/Codex OAuth needs a localhost callback or a pasted redirect URL. That path is separate from Upsy.

Environment variables are optional overrides. When one is set, it wins over the value stored on the volume. `TZ` is the container clock (log timestamps). Schedules keep their own IANA timezone. Setup does not store `TZ`. Omit it for UTC. `WHATSAPP_ALLOWED_USERS` overrides the numbers saved for WhatsApp. No new variable is required to boot.

Group and topic ids (`TELEGRAM_ALLOWED_CHATS`) stay environment-only. The compat reserve (`LLM_BASE_URL` / `LLM_API_KEY`, menu **Other**) is ignored when an official setup is already on the volume.

### Native web search and extraction

`web_search` finds links and supports `freshness` (day, week, month, year) and a `domains` allowlist. `web_extract` reads the main text of one HTTP(S) page. Both are read-only and work in scheduled runs without approval. Provider results are untrusted data, not instructions.

In `npm run setup`, select **Web search** to choose a primary and optional fallback for each tool. Select a slot, choose a provider from the numbered menu, and use **Save and back** to save the section. Keys are shared between slots and stored on the volume. The environment variables below override saved keys, including in Coolify. The order is saved in `$DATA_DIR/config.yaml` (or `CONFIG_FILE`); the default for both operations remains:

```yaml
web:
  search: [exa, firecrawl]
  extract: [exa, firecrawl]
```

| Provider  | Search | Extract | API key override      |
| --------- | ------ | ------- | --------------------- |
| Brave     | Yes    | —       | `BRAVE_API_KEY`       |
| Context   | Yes    | Yes     | `CONTEXT_DEV_API_KEY` |
| DeepSeek  | Yes    | Yes     | `DEEPSEEK_API_KEY`    |
| Exa       | Yes    | Yes     | `EXA_API_KEY`         |
| Firecrawl | Yes    | Yes     | `FIRECRAWL_API_KEY`   |
| Parallel  | Yes    | Yes     | `PARALLEL_API_KEY`    |
| Tavily    | Yes    | Yes     | `TAVILY_API_KEY`      |
| TinyFish  | Yes    | Yes     | `TINYFISH_API_KEY`    |
| Local     | —      | Yes     | None                  |

Brave's LLM Context API returns excerpts from search results, not arbitrary-URL extraction. Local needs no API key. Like [Piko](https://github.com/dandkong/piko/blob/8e9f4405fa1c87e1bbdc7a73a41938442284b9aa/server/tools/web-extract.ts), it uses Mozilla Readability to extract the main article from public HTML, converts it to Markdown, and falls back to cleaned page text if it cannot identify an article. It does not run JavaScript or load embedded resources; choose a hosted extractor for pages that require rendering. Local checks every redirect and blocks non-public destinations.

A keyed provider without a key is skipped. With one available provider, the tool works without fallback and `npm run doctor` warns. With two, the tool tries the fallback after an error, rate limit, timeout, zero search results, or empty or whitespace-only page content. If the fallback also returns an empty result, that result is returned normally. If no fallback is available or it fails, a successful empty result from the primary is still returned. An empty list disables that operation. Local is available only when explicitly selected. If no provider is available, the native tool is not registered and the assistant can use the configured Composio or Executor MCP tools as before. Restart after changing the setup.

### Sandbox

The long-running code task is `sandbox_code_task` (Instabox by default). It is off until the operator configures it. Nothing in the shipped config names a machine, an account, or a repository.

- `INSTABOX_ACCOUNT_ID` and `INSTABOX_MACHINE_ID` are optional. When unset, discovery uses an account only when exactly one is linked, and a machine only when exactly one is running. Zero or several is an error that lists them. There is no default machine name.
- `INSTABOX_REPO_ALLOWLIST` (or `sandbox_code_task.allow.patterns` in `$DATA_DIR/config.yaml`) is the repository allowlist. It is empty by default, so no repository is allowed until you set it. `owner/*` matches that owner. A set environment variable wins over the file.

The shared Instabox runner has write credentials. It only accepts `writes=true`, and the bot waits for approval before dispatching the job. Read-only jobs are rejected; run them in a separate environment without access to write credentials. Update the bot and both machine scripts before re-enabling Instabox. See [docs/jobs.md](docs/jobs.md).

Telegram deliveries are HTML. Bold wrapped around inline code does not leave an empty tag. If Telegram answers HTTP 400 because it cannot parse entities, that same delivery is sent once as plain text to the same chat, topic and reply. A 400 that is not a parse error is not resent. Telegram's `description` is redacted before it is logged or stored. `Bearer` and `sk-` tokens are masked by the same redactor that already covers configured secrets, including in the scheduled-run log line. A stored MCP list that still has `cuaViewer` fails validation.

A message that starts a turn gets an eyes reaction only when the reply is still unsent after 4 seconds. `reaction_delay_ms` in `config.default.yaml` sets that wait; `$DATA_DIR/config.yaml` overrides it. A reply that goes out first cancels the reaction, and the timer is cleared. `0` reacts as soon as the message is accepted. There is no environment variable for this. WhatsApp does not send this reaction.

A long task posts one short note in that same chat before the work, naming the first step, then the final answer on its own. Later notes are only for a result, a blocker, or a changed plan: at most one every 30 seconds and three in that task. A quick reply does not send the extra note. The note is the `progress` tool. It uses the same delivery path as the reply and does not end the turn. A scheduled run does not call `progress` and stays silent unless it calls `notify`. The eyes reaction still waits for the turn's reply.

[Freestyle](https://freestyle.sh) is another hosted Linux VM sandbox ([docs](https://www.freestyle.sh/docs), [quickstart](https://www.freestyle.sh/docs/quickstart)). This feature does not use it. The shipped `sandbox_code_task` block, the `INSTABOX_*` variables, discovery, and `scripts/instabox/` target Instabox. Freestyle's current docs describe an API and a CLI for those VMs. They do not publish an MCP that runs the VMs, so an entry in the MCP list does not switch the code task to Freestyle.

### Operator skills

Optional instructions on the volume apply to every reply, including scheduled runs. Each skill is a folder, for example `$DATA_DIR/skills/weekly-review/SKILL.md`:

```md
---
name: weekly-review
description: What to check in a weekly review
---

List what is still open from the week and what can wait.
```

Name the folders in `$DATA_DIR/config.yaml`. The list replaces the default empty list:

```yaml
skills:
  always:
    - weekly-review
```

The system prompt lists each name and description, in that order, after the base instructions and before the MCP sections. The model loads a body with the read-only `read_skill` tool. The list is the same on every reply, including scheduled runs. An empty list, or a skills folder that is not there, leaves the prompt unchanged and does not register the tool. A missing name, invalid frontmatter, or an unreadable file is logged and skipped. An unknown `read_skill` name returns an error and no body. The bot still starts.

### Long-term memory

The bot reads up to 8 KB from `$DATA_DIR/memory/MEMORY.md` on each turn. It can look up daily notes (`YYYY-MM-DD.md`, UTC) using `memory_search`. Both files are plain Markdown you can edit. Memory is shared across all authorized chats and topics for the installation, including scheduled turns. Only direct user messages count toward curation: after 30 idle minutes and at least three new user messages, the background curator reviews the new messages once. It uses the conversation's configured model by default, with no shell, MCP, or extra model required.

On Telegram or WhatsApp, `/memory` shows `MEMORY.md` and `/forget <text>` removes matching lines from both durable and daily notes (case-insensitive literal text). These commands do not rewrite conversation history or prior replies.

To disable memory, set `memory.enabled: false` in `$DATA_DIR/config.yaml` and restart. To use another already configured model just for curation, set `memory.curator_model.provider` and `memory.curator_model.model_id` in that file.

### Subagents

Off by default. When on, the model can hand self-contained read-only work (broad research, long reads) to a `subagent` and keep only its final answer in the conversation. A subagent uses the same model, sees only MCP tools, and every MCP call that is not a read is refused before it is sent. `/stop` stops running subagents too. Turn it on in `$DATA_DIR/config.yaml` and restart:

```yaml
subagents:
  enabled: true
```

Limits, rules and how to measure the cost: [docs/subagents.md](docs/subagents.md).

## There's an API or MCP for that

Steve Jobs closed the 2010 iPad event with "there's an app for that" ([CBS](https://www.cbsnews.com/news/steve-jobs-at-the-heavenly-gates-theres-an-app-for-that/)). Before adding a capability to the bot, connect an API or an MCP server that already does the job.

`npm run setup` attaches [Composio](https://composio.dev), [Executor](https://executor.sh), [Upsy](https://upsy.ai/connect), a self-hosted gateway, both (Executor plus Composio), or neither, and stores the choice on the volume. Upsy uses OAuth 2.1 with PKCE and has no API key. Self-hosted takes a URL and an optional token or header (`SELF_HOSTED_MCP_URL`, `SELF_HOSTED_TOKEN`, `SELF_HOSTED_HEADER`). Further servers go in an MCP list: a JSON file named by `MCP_CONFIG_FILE`, or the same JSON in `MCP_SERVERS_JSON`. That list replaces the aggregators that setup saved, so repeat Executor or Composio in it when you still want them. Each entry has `name`, `url`, and, when the server needs a key, `tokenEnv` (the environment variable that holds the raw key). Leave the key out of the file. The bot sends `Authorization: Bearer <key>` unless `tokenHeader` names another header. The env value is the raw key, with no `Bearer` prefix. A URL with a query string is rejected, so use the bare endpoint even when a provider's docs show `?login` or `?tools=`. Naming a `tokenEnv` variable that is unset stops startup. Executor decides which of its calls need approval; the bot only relays that pause. It does not add a second approval from the read/write lists. An interactive pause is the existing card. A scheduled run cannot wait: the call is still sent, and if Executor returns approval-required the tool fails with `needs approval; not available in scheduled runs` plus the tool path. No card is posted and resume is not called. A server with no `tools` list of its own uses Executor's lists and the same rule. Composio has its own list, so a write there is still refused in a scheduled run before it is sent. `sandbox_code_task` with `writes=true` still waits for its card.

`$DATA_DIR/config.yaml` does not connect servers. Its `mcp_servers` map classifies tools as read or write. Those lists still apply to uncertain results, timeouts, and retries. A server with no `tools` list of its own uses the executor globs in `config.default.yaml`. Write globs win, so `get_or_create` is a write. An `execute` program is a read only when every resolved call is a read: `tools.a.b(...)`, `pick("...")`, a simple alias (`const gh = tools.github.repos` then `gh.getContent(` or `gh.repos.getContent(`, or `const { getContent } = tools.github.repos`). Brackets (`tools["a"]`) and any use that does not resolve stay writes. One write call makes the program a write. A leaf is also a read when a read verb is its own word in the name (`inboxesMessagesList`, `v1ExtractPost`); a write verb in that leaf stays a write, except a trailing HTTP `Post` next to a read verb. See [docs/mcp-uncertain.md](docs/mcp-uncertain.md). There is no webhook ingress for async jobs. Upsy's access token is not copied onto the server entry; the sign-in flow attaches it only when the URL is Upsy's. Discovery rejects a resource or issuer that does not match the one that was requested.

| Service                                | What it adds                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AgentMail](https://www.agentmail.to)  | an inbox as a tool: receive, reply, send                                                                                                           |
| [Browser Use](https://browser-use.com) | a real browser for pages that need clicking, not just reading                                                                                      |
| [Cal.com](https://cal.com)             | scheduling: availability and bookings as tools                                                                                                     |
| [Exa](https://exa.ai)                  | web search and content extraction. Hosted MCP `https://mcp.exa.ai/mcp` ([docs](https://exa.ai/docs/get-started/exa-mcp)). Key header: `x-api-key`  |
| [Firecrawl](https://www.firecrawl.dev) | crawl a whole site and extract it as clean text                                                                                                    |
| [Fish Audio](https://fish.audio)       | speech synthesis the assistant can call ([MCP](https://docs.fish.audio/overview/mcp))                                                              |
| [GitHub](https://github.com)           | repositories, issues and pull requests ([official MCP](https://github.com/github/github-mcp-server))                                               |
| [Instabox](https://instabox.sh)        | a Linux sandbox as a tool: real shell, browser and persistent disk — run code, build and publish artifacts                                         |
| [Parallel](https://parallel.ai)        | web search, page extraction, and research. Hosted MCP `https://mcp.parallel.ai/mcp` ([docs](https://docs.parallel.ai/integrations/mcp/quickstart)) |
| [TinyFish](https://www.tinyfish.ai)    | web search and page fetch                                                                                                                          |

A personal assistant usually needs them in this order: mail, web, voice, then scraping, browsing, calendar, code and compute. Voice here means the agent producing audio as a tool result: the bot still answers in text, and a voice bubble is not implemented.

Exa and Parallel use the same list as Executor and Composio. Point `MCP_CONFIG_FILE` at a file on the volume (for example `/app/data/mcp.json`) and set `EXA_API_KEY` and `PARALLEL_API_KEY` in the environment. Those names are placeholders for your own keys:

```json
[
  {
    "name": "exa",
    "url": "https://mcp.exa.ai/mcp",
    "tokenEnv": "EXA_API_KEY",
    "tokenHeader": "x-api-key"
  },
  {
    "name": "parallel",
    "url": "https://mcp.parallel.ai/mcp",
    "tokenEnv": "PARALLEL_API_KEY"
  }
]
```

Exa documents the key in `x-api-key` ([MCP docs](https://exa.ai/docs/get-started/exa-mcp)). Parallel accepts `Authorization: Bearer` (omit `tokenHeader`) or `x-api-key` ([MCP docs](https://docs.parallel.ai/integrations/mcp/quickstart), [programmatic use](https://docs.parallel.ai/integrations/mcp/programmatic-use)). With a key, Exa also lists `agent_run` and Parallel also lists `web_research`. Without `tokenEnv`, both stay on keyless search and fetch.

Executor and Composio use those same fields. The Executor v2 cloud URL in [docs/jobs.md](docs/jobs.md) is `https://mcp.executor.sh/mcp` with `tokenEnv` set to `EXECUTOR_TOKEN`. Composio Connect is `https://connect.composio.dev/mcp` with `tokenEnv` set to `COMPOSIO_API_KEY` and `tokenHeader` set to `x-consumer-api-key`. Repeat the URL that `npm run setup` stored when it is different. Other Composio MCP hosts use `x-api-key` and a `userId`.

## WhatsApp

One phone gateway per install. Choose it in `npm run setup`. Saving WhatsApp turns Telegram off, and saving Telegram turns WhatsApp off. An install that never chooses stays on Telegram. WhatsApp uses [Baileys](https://github.com/WhiskeySockets/Baileys) and [qrcode-terminal](https://github.com/gtanner/qrcode-terminal). Baileys speaks unofficial WhatsApp Web, which can lead to account restrictions. No new environment variable is required to boot.

### Setup

```sh
docker exec -it <container> npm run setup
```

Open **Setup gateway**, then **2 - WhatsApp**.

Yes/no questions prompt `(y/n) [y]` or `(y/n) [n]`. Enter keeps the suggestion in brackets. Use `y` or `yes` to accept and `n` or `no` to decline. Any other text is asked again.

**1 - Allowed numbers** asks for digits and a country code. The first number is the owner. Extra numbers are optional and comma-separated, for example `15550001111,5500900000001`. Each number must be 8 to 15 digits. **Save and back** writes that list and selects WhatsApp. The owner number is required before the save, and before pairing.

A Brazilian mobile is country code `55`, a two-digit area code, and 8 digits. The number people dial often adds a `9` immediately after the area code, while the WhatsApp JID for an older account is the same number without that `9`: `5500900000001` and `550000000001` (area code `00`). Setup stores the digits you type, in the allow list and in `WHATSAPP_ALLOWED_USERS`. It does not rewrite either form into the other. When a message arrives, the allow list and the linked account treat those two shapes as the same number, so the message is not dropped as `not-allowed` only because one side has the `9`. The chat stays bound to the JID WhatsApp sent, which may be the shorter form, and replies go to that chat. The extra digit counts only when it is a `9` right after the area code. `5500911111111` is a different number. A number that is not exactly one of those two shapes, including a 13-digit number whose digit after the area code is not `9`, is compared as written. A LID is not a phone number and is not rewritten. `npm run diagnose` and the `dropped inbound` line show only the last four digits, so they do not show whether the `9` is present.

`WHATSAPP_ALLOWED_USERS` is optional. It is read only when WhatsApp is the gateway. When it is set, it replaces the saved list. Leave it unset to use the numbers from setup. A value that is not a comma-separated list of those numbers stops startup. It is not required to boot.

While setup is waiting for an answer, and while it is waiting for the phone to connect, the Baileys logger stays silent. Dropped-inbound lines are not printed during pairing, so they do not cover the prompt. The QR or the pairing code is what the terminal shows until the phone connects.

### Pairing and where the session is stored

**2 - Pair with QR** prints a QR in that terminal. Scan it in WhatsApp under Linked devices. **3 - Pair with phone code** asks which number to link (Enter keeps the owner) and then prints `WhatsApp pairing code: …`. Pairing stays open until the phone connects. The menu prompt is paused for that wait, so a closed prompt cannot exit the process before the QR appears.

The session directory is `$DATA_DIR/whatsapp-auth/`. `creds.json` in that directory means the phone is paired. In the container, `$DATA_DIR` is `/app/data` on the Compose volume `pi_bot_data`. Next to the session, the volume also holds `whatsapp-lid-map.json` (a LID tied to a phone) and `whatsapp-sent.json` (the last 200 sent ids, kept for seven days, so an echo of the bot's own send is still dropped after a restart). A new empty volume has none of these files.

If the running gateway already holds `$DATA_DIR/owner.lock`, setup refuses a second session and prints `o gateway já mostra o QR nos logs`. Read that QR from the container logs, or stop the gateway before pairing from setup.

### Who can send, and the `Pi: ` prefix

The owner, the extra numbers saved with that number, and the linked account's own chat can send text, images, and voice notes. The linked account is always accepted, saved list or not: its phone (a device suffix such as `:31` included), its LID, and "message yourself". The bot replies in the same chat. Only that own chat prefixes text and captions with `Pi: `. A reply that already starts with `Pi:` is not prefixed again. A chat with any other allowed number is unchanged.

Groups, status broadcasts, newsletters, and every other number are ignored. A video, a sticker, or a document that is not a JPEG, PNG, WebP, or GIF gets `Attachment received, but for now I only read images (photo or JPEG/PNG/WebP/GIF) and voice notes.` and does not start a turn.

Replies are plain text, cut at 3800 characters. A Markdown heading becomes `*title*`, `**bold**` becomes `*bold*`, and `[label](https://example.test)` becomes `label (https://example.test)`. There are no buttons. `ask_user` is not registered on WhatsApp. Approvals are a numbered list; reply with the number. That number is taken before a model, effort, or schedule number.

### Commands

There is no BotFather menu. Type the command in the chat. `/help` and `/start` send this list:

| Command      | What WhatsApp does                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/status`    | Status, tokens, and cost for this chat                                                                                                                                 |
| `/receipt`   | Receipt for the latest turn. `/receipt <n>` counts back from the latest (1)                                                                                            |
| `/approvals` | Reads that are always allowed, numbered for `/revoke`                                                                                                                  |
| `/revoke`    | `/revoke <n>` removes a rule; that read asks for approval again                                                                                                        |
| `/stop`      | Cancels pending work in this chat, then the text is still sent to the model. A caption on a photo or voice note counts. `/cancel` is not a command                     |
| `/new`       | New conversation in this chat. The previous one stays on the volume. Uncertain MCP results stay; `/resume` dismisses those. This chat is bound to the new conversation |
| `/resume`    | Resume a stuck task, or dismiss an uncertain MCP result                                                                                                                |
| `/compact`   | Compact this chat. Text after the command is optional focus                                                                                                            |
| `/model`     | Numbered model list. Reply with the number. Words after `/model` do not select a model; they still open the list                                                       |
| `/thinking`  | Numbered effort list. Reply with the number                                                                                                                            |
| `/crons`     | Schedules in this chat. Reply with the number to turn one on or off. This command does not create a schedule                                                           |
| `/help`      | The list above                                                                                                                                                         |

A message that starts with `//` is text, not a command. One slash is removed before the model sees it, so `//status` arrives as `/status`. An unknown command gets the help list and does not start a turn. A photo or a voice note is not a command, except when the caption is `/stop`.

Ask in the chat to create a schedule. `/crons` only toggles one that already exists in this chat.

### Schedules and notifications

A schedule created in a WhatsApp chat stays in that chat. `notify` is delivered to the WhatsApp chat bound to the conversation. The run stays silent unless it calls `notify`. The scheduler starts with the WhatsApp gateway. Telegram still starts its own scheduler from the polling loop. Starting either gateway cancels the other channel's pending sends, logs `Inactive gateway: cancelled N pending deliveries.`, and stores the reason `gateway inativo`. A row that has no channel is treated as Telegram.

### Upsy

Setup prints the Upsy sign-in link. Paste the final browser URL into the bound WhatsApp chat, the same paste Telegram accepts, even if the page does not load. The redirect is `http://127.0.0.1:33418/callback` and nothing listens there. That paste is not sent to the model. The reply goes back to the same chat. There is no `/login` command. `npm run login` is ChatGPT/Codex OAuth only, and `--aggregators upsy` does not start a login.

### Docker

`docker compose up` mounts `pi_bot_data` at `/app/data`. The Baileys session is only on that volume. A new or renamed volume is empty and needs pairing again. To keep a session, stop the container and copy the old volume onto the new one before you start it. While the process is waiting for a QR, or reconnecting after a drop that is not a logout, the health file stays current so Docker does not restart it. The QR printed by the running gateway is in `docker compose logs`, not in a second setup session.

### Troubleshooting

- **Pair again.** In setup, choose **2** or **3**. If the gateway is already running, use the QR in its logs. After the phone connects, setup prints `WhatsApp paired. The session stays on the data volume.`
- **Logged out.** If the phone removes the linked device, the process stays up and logs `WhatsApp: session logged out. Pair again with npm run setup, or scan the QR in these logs.` The directory `whatsapp-auth` is renamed to `whatsapp-auth.loggedout-<timestamp>`, and a new empty `whatsapp-auth` is created. The next QR is in those logs. A disconnect that is not a logout reconnects without exiting. If the socket cannot be opened, the number in the error is masked, the process stays up, and another reconnect is scheduled.
- **`dropped inbound`.** A message that is not admitted is one line: `WhatsApp: dropped inbound (<reason>) ***<last four digits> remote=pn|lid|other alt=yes|no fromMe=true|false`. The reason is `group`, `broadcast`, `echo` (the bot's own send), `not-allowed` (not an allowed number and not the linked account), `not-self` (sent by the linked account to someone else), `empty`, or `history` (an old sync, not a new message). An empty event from the linked account itself is not logged. Setup pairing does not print these lines. A failed send is `WhatsApp: send failed (...)`, with long numbers masked. On a WhatsApp install, `npm run diagnose` prints numbers masked to the last four digits and skips the Telegram checks.

## Commands

On Telegram the app registers this menu on start. There is nothing to set in BotFather. On WhatsApp the names are text in the chat. [WhatsApp](#whatsapp) is the list `/help` sends there: `/crons` only turns a schedule in that chat on or off.

| Command      | What it does                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `/model`     | Provider and model for this topic                                                                 |
| `/thinking`  | Effort for this topic                                                                             |
| `/crons`     | Create and manage schedules                                                                       |
| `/new`       | Another conversation in this topic. The previous one stays on the volume                          |
| `/resume`    | Resume a stuck task: a crash-parked task, or an uncertain MCP result                              |
| `/stop`      | Stop this topic                                                                                   |
| `/compact`   | Compact this topic now. Text after the command is optional focus. Refused while the topic is busy |
| `/status`    | Model, this topic's tokens and cost, MCPs, the current run, and the version                       |
| `/receipt`   | Receipt for the latest turn. `/receipt <n>` counts back from the latest (1)                       |
| `/approvals` | Reads that are always allowed, numbered for `/revoke`                                             |
| `/revoke`    | `/revoke <n>` removes a rule; that read asks for approval again                                   |
| `/help`      | This list                                                                                         |

`/resume` dismisses an uncertain MCP result without repeating the call (the call may already have run) and continues a task that was parked after a crash. `/new` does not clear an uncertain result.

Receipts are stored per conversation from the time this feature is installed. They show tool counts, execution time, errors, approval requests, unresolved MCP outcomes, calls to search tools, and model tokens and cost when known. They don't store conversation text, tool arguments, page content, or keys. Set `turn_receipt.footer: true` in `config.yaml` to add a short receipt line to final chat replies; it is off by default.

Each native topic (a forum topic) has its own history, model, and effort.

## Upgrade

### Upgrading from pi-agent-tg

The Compose service is `pi-bot` and the named volume is `pi_bot_data`, still mounted at `/app/data`. A renamed volume is a new empty volume. To keep data, stop the container, copy the old volume into the new one, then deploy and check `/status`. Keep the old volume as a backup for a few days.

```sh
docker run --rm -v old:/from -v new:/to alpine cp -a /from/. /to/
```

`old` is the existing `pi_agent_tg_data` volume and `new` is `pi_bot_data`. Use the names from `docker volume ls` when Compose has prefixed them with the project name.

Back up the volume before upgrading. The first boot of this release migrates `pending_jobs` by adding columns. SQLite `ALTER TABLE` has no down migration. On startup, leftover `mcp_calls` rows whose id starts with `mcp-stage:` are deleted, and a call left `running` is reclassified (`failed` for a read, `uncertain` for a write). The jobs poller then deletes finished job rows older than 30 days. Open rows stay. There is no rollback of that data: restore the backup if you need the previous volume. The earlier `durable.sqlite` migration to schema 2, from the previous release, still has no rollback either.

Rolling the image back without restoring the backup leaves the ledger on a shape the previous release may not read. Pi 1.6.0 keeps SQLite schema 2 and writes `pi.tool` version 4 and `pi.generation` version 3; the previous image blocks those tasks.

## Notes

- The harness is Pi 1.6.0 (`pi-ai`, `pi-durable`, and `chord`). Conversations stay in `durable.sqlite`. The process is headless, so a turn runs without a Continue, Fork, or Cancel prompt. Deferred MCP search matches a tool whose parameters only name a model through a local `$ref`. The OpenAI, Azure, and Codex catalogs include GPT-6.2 Astra and GPT-6.2 Sol. `/thinking` does not offer `off` for those models. A conversation keeps the model it already saved.
- Chat history, credentials, and the ledger are only as private as the volume and the host.
- The assistant has no shell, file, patch, or browser of its own. MCP results are untrusted data.
- `ask_user` posts one question in the same chat and topic and ends the turn. Up to six choices become buttons (`ask:<32 hex>:<index>`). A tap is the next message (`Answer to: … -> …`). Typing is a normal message and clears the buttons. A repeated or stale tap does nothing. Scheduled runs cannot ask. These buttons are not approval cards.
- Ollama is the compat exception. A base URL on `ollama.com`, port `11434`, or a path containing `/api` is probed once per model (`POST /api/show`, about 2s, cached). If the model advertises thinking, `/thinking` offers `off`, `low`, `medium`, and `high`, or the named levels from that response. An explicit `LLM_MODELS` reasoning field still wins. The chat request sends `reasoning_effort` (`none` turns thinking off). A failed probe leaves the model as declared.
- A returned MCP or Executor error stays with the model. The chat hears about a call only when a write left no known result, once, in a short message with **Record verification** and, when there is something to show, **Details**. A dropped read is retried twice (40 ms, then 80 ms). A write is never resent. Confirming the card keeps that call's original error and stores the note beside it. `/status` lists the state and does not post another card.
- After the user approves or declines an MCP card, the assistant's final text in that follow-up is delivered in the same chat. An empty reply sends nothing. The "Succeeded" / "Did not run" check is unchanged. A tool that returns only a task id, with no async job manifest, is not a promise to return: the assistant polls for about 50 seconds, uses the registered job, or creates one one-shot schedule that calls `notify` in this chat. See [docs/jobs.md](docs/jobs.md).
- Deployment notes: [docs/coolify.md](docs/coolify.md) and [docs/verification.md](docs/verification.md).

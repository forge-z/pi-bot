# Deploy Pi Bot on Coolify

Keep credentials in runtime environment variables or the data volume, never in the repository or build arguments.

## Prerequisites

- Repository: `https://github.com/forge-z/pi-bot`, branch `main`.
- Docker Engine and Compose v2.24+ (amd64 or arm64).
- One phone gateway per installation. For Telegram, use a dedicated bot with no active webhook or second polling consumer. To use WhatsApp instead, select it in `npm run setup` and pair it from the container terminal.

## 0. Before the first deployment

After the container starts, run `npm run setup` in its terminal to configure a model provider or `npm run login` to sign in with a ChatGPT/Codex subscription. `LLM_BASE_URL` and `LLM_API_KEY` are only for the optional compatible provider (**Other** in setup).

If you use a compatible provider, check it before deployment:

1. Use the exact base URL from the provider's docs. The adapter appends `/chat/completions`, and discovery appends `/models`. Examples: `https://api.openai.com/v1` and `https://api.deepseek.com` (DeepSeek also accepts `/v1`).
2. Validate the URL and key, not just their presence:
   ```sh
   npm run build
   LLM_BASE_URL=... LLM_API_KEY=... node scripts/diagnose-tg-runtime.mjs --probe
   ```
   The probe calls `GET {LLM_BASE_URL}/models` and lists model IDs. Correct any catalog failure before deploying.
3. Set `LLM_MODELS` if the discovered catalog cannot supply the model limits or reasoning levels you need. See [Model catalog and reasoning](#model-catalog-and-reasoning).

Use a fresh Telegram bot and volume. Pi Bot refuses a volume associated with a different bot and does not poll with a webhook or a second consumer. Have the Telegram token and numeric user IDs ready for setup, along with any model and MCP credentials.

## 1. Create the resource

- In Coolify, choose **New Resource → Docker Compose**, then select `forge-z/pi-bot` on `main`.
- Set **Docker Compose Location** to `docker-compose.yml` in the repository root. The service is `pi-bot`.
- Do not configure a domain, publish a port, or add a reverse proxy. The bot uses long polling.

## 2. Runtime variables

No environment variables are required to start the container. `npm run setup` saves the bot token, user IDs, model keys, and MCP settings in the volume's SQLite database. Token entry is hidden; Enter keeps the existing value. If the token has not been set, the process reports it and stays up so setup can run.

### Optional variables

- `TELEGRAM_BOT_TOKEN` or `TELEGRAM_BOT_TOKEN_FILE`, and `TELEGRAM_ALLOWED_USERS`: override the corresponding saved values.
- `TELEGRAM_ALLOWED_CHATS`: optional environment-only override. Chat IDs for groups and supergroups are negative. By default it uses the allowed user IDs for DMs.
- `LLM_BASE_URL` and `LLM_API_KEY`: configure the compatible `llm` provider. They do not override a complete official provider setup.
- `EXECUTOR_MCP_URL` and `EXECUTOR_TOKEN`: use together to override the saved Executor configuration. Setup offers Composio, Executor, Upsy, Self-hosted, Both, and None. `COMPOSIO_MCP_URL`, `COMPOSIO_API_KEY`, and `COMPOSIO_USER_ID` override saved Composio values. `SELF_HOSTED_MCP_URL` configures a generic gateway, with optional `SELF_HOSTED_TOKEN` and `SELF_HOSTED_HEADER`. Upsy credentials come from its OAuth setup flow, not environment variables.
- [Web provider API key variables](../README.md#native-web-search-and-extraction) override keys saved through **Web search**. Local extraction needs no key. `npm run doctor` shows active providers and warns when there is no fallback.
- `TZ`: container clock timezone for logs, for example `America/Sao_Paulo`. The container defaults to UTC. Schedules store their own IANA zones, and setup does not write `TZ`.
- `LLM_MODELS`, `LLM_INPUT`, `VISION_*`, `AUDIO_*`, `ASYNC_JOB_*`, and `INSTABOX_*`: see [the example environment file](../.env.example) for details.

The assistant has no local shell, file, patch, or browser tools and cannot see the host, volume, or source tree. Use an authenticated MCP gateway for external integrations, such as [Executor](https://executor.sh), [Composio](https://composio.dev), [Upsy](https://upsy.ai/docs), or a self-hosted gateway. Executor uses `Authorization: Bearer`. Composio Connect (`https://connect.composio.dev/mcp`) uses `x-consumer-api-key`; other Composio MCP URLs use `x-api-key` and the `user_id` query parameter. Upsy (`https://upsy.ai/connect`) uses OAuth 2.1 with PKCE. Setup prints the authorization link, and the operator pastes the final browser URL (`http://127.0.0.1:33418/callback`; nothing listens there). The bot sends and refreshes the bearer token automatically. Self-hosted uses bearer authentication or the header set in `SELF_HOSTED_HEADER`. Without an MCP gateway, the bot starts without external MCP tools.

`MODEL_PROVIDER`, `MODEL_ID`, and the older per-provider environment variables are no longer used. Use setup for official providers or `LLM_*` for the compatible provider.

### How Coolify passes variables to the container

Coolify locks variables declared in `docker-compose.yml` in the dashboard. To keep optional values editable, Compose does not list any under `environment:`. Instead it loads Coolify's generated `.env`:

```yaml
env_file:
  - path: .env
    required: false
```

Add optional values under **Environment Variables**. Coolify writes them into the deployment directory's `.env`, and Compose passes them to the container.

### Clean up an older deployment

Coolify may retain variables previously declared in Compose. After redeploying, remove obsolete `ASYNC_JOB_TOOLS` and `EXECUTOR_ACCOUNT_ID`. The poller gets the read account from the invocation that started the job, and the `pending_jobs.account_id` column is created on startup. Keep optional values you still use. Once setup saves the Telegram token and allowed user IDs on the volume, you can remove their environment overrides.

### Image defaults

The Dockerfile sets `NODE_ENV=production` and `DATA_DIR=/app/data`. Leave these out of the Coolify panel. Coolify injects `SOURCE_COMMIT` at runtime.

### Model catalog and reasoning

Without `LLM_MODELS`, the catalog comes from `GET {LLM_BASE_URL}/models`. Discovery uses conservative limits and offers only `off` in `/thinking` because listing models does not report their capabilities. Ollama is an exception: host `ollama.com`, port `11434`, or an `/api` path triggers a cached `POST /api/show` per model with a short timeout. If `capabilities` includes `thinking`, standard Ollama levels (`off`, `low`, `medium`, `high`) or `thinking.values` are available. Explicit `LLM_MODELS` reasoning overrides discovery, and discovery failures do not change the catalog. Requests use `reasoning_effort`; `none` disables it.

Supply each entry as `id` or `id|contextWindow|maxTokens|reasoning`. Set `contextWindow >= 32768` and `0 < maxTokens < contextWindow`. Reasoning accepts `false` (off only), `true` (standard levels: `off minimal low medium high`), or levels separated by `+`. Use provider-supported limits and levels. For example, DeepSeek's `deepseek-flash` rejects `minimal` and `medium` and supports `max`; the pi-ai 1.6.0 catalog records it as:

```sh
LLM_MODELS='deepseek-flash|1000000|384000|off+low+high+max'
```

### Never pass secrets as build arguments

The Dockerfile does not accept build arguments. Passing secrets as build arguments can leave them in image layers.

## 3. Commit SHA in `/status`

Coolify injects `SOURCE_COMMIT`, which `/status` and `npm run diagnose` show. Pi Bot also accepts `GIT_COMMIT`, `COMMIT_SHA`, `COOLIFY_COMMIT`, and `COOLIFY_SOURCE_COMMIT`. Where `.git` exists, it can fall back to `git rev-parse HEAD`. No build argument or **Available during build** setting is needed.

## 4. Volume and persistence

The named volume `pi_bot_data` mounts at `/app/data`. Data is stored in `/app/data/app.sqlite` using Node 24's SQLite support; the image has no `sqlite3` CLI. Run only one process per volume, keep a separate volume for each deploy, and make a backup before changing versions. Topics and conversations are created on first use, not at startup.

## 5. Container hardening

Compose sets `read_only: true`, a 16 MB tmpfs at `/tmp`, `cap_drop: ALL`, `no-new-privileges`, `init: true`, `restart: unless-stopped`, and a 45-second shutdown grace period. The health check runs `node dist/src/healthcheck.js` every 30 seconds after a 40-second start period, with three attempts.

The only writable locations should be `/app/data` and `/tmp`. If writes are denied, verify the volume mount before changing `read_only`. The first poll must finish before the service reports healthy, so an initial `unhealthy` with normal logs can be temporary.

## 6. Verify deployment

- Run `docker compose ps` and `docker compose logs --tail=100 pi-bot`.
- In the Coolify service terminal, run `npm run diagnose` or `node scripts/diagnose-tg-runtime.mjs`. It reports whether environment values are set, empty, or placeholders without printing values.
- Run `npm run setup -- --list` to set a global default model. With no selection, the first catalog entry is used and the bot reports the choice once per conversation. Use `/model` to switch in chat. `npm run login` only handles OAuth; both setup and login use the volume.
- From the host checkout, run `bash scripts/diagnose-tg-deploy.sh .` over SSH. This script is not part of the image.
- Send `/status` in an existing Telegram topic.

## 7. Optional BuildKit secret `npm_ca`

The Dockerfile supports `--mount=type=secret,id=npm_ca` for `npm ci` behind a proxy that uses its own CA. Normal builds do not need it. The secret is not copied into the image.

## 8. Update or roll back

### Upgrading from pi-agent-tg

The Compose service is now `pi-bot` and the volume is `pi_bot_data`, still mounted at `/app/data`. Docker creates an empty volume under a new name. Stop the container, copy the old volume to the new one, deploy, and verify `/status`. Keep the old volume as a backup.

```sh
docker run --rm -v old:/from -v new:/to alpine cp -a /from/. /to/
```

Use the actual names from `docker volume ls`: `old` is the existing `pi_agent_tg_data` volume and `new` is the new `pi_bot_data` volume. Compose may prepend the project name.

- A push to `main` runs type checking, linting, format checking, the build, offline tests, Compose validation, and a container smoke test.
- To rebuild locally, use `npm run compose:up` or `SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build`.
- To roll back, deploy the earlier commit and restore the corresponding volume backup. The SQLite ledger is the source of truth for conversations.

## 9. Troubleshooting

| Symptom                                        | Check                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invalid LLM endpoint                           | Use the provider's HTTPS base URL with no credentials or query. HTTP is allowed only on loopback.                                                |
| Missing LLM API key                            | For the compatible provider, set `LLM_API_KEY` or `LLM_API_KEY_FILE`.                                                                            |
| Model catalog returns HTTP 401                 | Check the key.                                                                                                                                   |
| Model catalog returns HTTP 404                 | Check the base URL, including a version segment such as `/v1` if required.                                                                       |
| Model catalog unreachable or times out         | Run the host `--probe` and check network, DNS, TLS, and hostname.                                                                                |
| Catalog invalid or empty                       | Verify the response shape or set `LLM_MODELS` explicitly.                                                                                        |
| Invalid `LLM_MODELS`                           | Use one of the formats under [Model catalog and reasoning](#model-catalog-and-reasoning).                                                        |
| Missing or invalid Telegram token or allowlist | Run `npm run setup`, or correct the matching environment override. Use numeric user IDs, not the bot ID. For DMs, omit `TELEGRAM_ALLOWED_CHATS`. |
| Volume belongs to another bot                  | Use a separate volume.                                                                                                                           |
| Telegram update ignored                        | Check the allowlisted users and chats and whether the chat type is supported.                                                                    |
| No commit shown in `/status`                   | Check runtime injection of `SOURCE_COMMIT`; export it yourself outside Coolify.                                                                  |
| Container is initially unhealthy               | Allow about a minute for the first polling cycle before investigating.                                                                           |

There is no public port, domain, webhook, or web chat in this deployment. Do not run two processes against one volume.

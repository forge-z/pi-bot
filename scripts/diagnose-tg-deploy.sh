#!/usr/bin/env bash
# Offline-safe checks for the pi-bot Telegram deployment. Never prints secret values.
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

section() {
  printf '\n=== %s ===\n' "$1"
}

mask_env() {
  awk -F= '
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      key=$1
      val=substr($0, length(key)+2)
      if (val == "") status="VAZIO"
      else if (val ~ /^replace_with/i) status="PLACEHOLDER"
      else status="definido"
      print key "=" status
    }
  '
}

section "Host and directory"
pwd
command -v docker >/dev/null && docker --version || echo "docker: missing"
docker compose version 2>/dev/null || echo "docker compose: missing"
git rev-parse --abbrev-ref HEAD 2>/dev/null || true
git rev-parse --short HEAD 2>/dev/null || true

section ".env file (presence only; no values)"
if [[ -f .env ]]; then
  mask_env < .env
else
  echo ".env: AUSENTE (copie .env.example e edite no servidor)"
fi

section "docker compose config"
if docker compose config --quiet 2>/dev/null; then
  echo "compose config: OK"
else
  echo "compose config: FALHOU"
  docker compose config 2>&1 | tail -20 || true
fi

section "Containers"
docker compose ps 2>/dev/null || true

SERVICE=pi-bot
section "Recent logs (secrets are not filtered; review before sharing publicly)"
docker compose logs --tail=80 "$SERVICE" 2>/dev/null || echo "no logs for $SERVICE"

section "Healthcheck do container"
CID="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
if [[ -n "$CID" ]]; then
  docker inspect --format 'State={{.State.Status}} Health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} ExitCode={{.State.ExitCode}}' "$CID"
  if docker exec "$CID" node dist/src/healthcheck.js >/dev/null 2>&1; then
    echo "healthcheck exec: OK"
  else
    echo "healthcheck exec: FAILED (container is running, but heartbeat or polling may not be healthy)"
  fi
else
  echo "container $SERVICE is not running"
fi

section "Effective container environment variables (masked)"
if [[ -n "${CID:-}" ]]; then
  docker exec "$CID" sh -c 'for k in TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS TELEGRAM_ALLOWED_CHATS LLM_API_KEY LLM_BASE_URL EXECUTOR_TOKEN EXECUTOR_MCP_URL; do v="${!k-}"; if [ -z "$v" ]; then echo "$k=VAZIO"; elif printf "%s" "$v" | grep -qi replace_with; then echo "$k=PLACEHOLDER"; else echo "$k=definido"; fi; done' 2>/dev/null || true
fi

section "Quick tips"
cat <<'EOF'
- TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS are optional: `npm run setup` saves both to the volume. Environment values override saved values.
- TELEGRAM_ALLOWED_CHATS is optional (omit for DMs; use a negative ID for a supergroup, e.g. -100…).
- User ID de quem controla o bot (@userinfobot no privado) entra no setup, ou em TELEGRAM_ALLOWED_USERS como override.
- Private chat: CHATS can use the same positive ID as your user.
- npm run setup is the full wizard (provider, vision, and audio). npm run login is only for OAuth (device-code: npm run login -- openai-codex --device-code). Both save to the volume; environment LLM_* values take precedence.
- LLM_BASE_URL and LLM_API_KEY remain valid and override saved compatible-provider values, but are not required after setup.
- Without LLM_MODELS, the catalog comes from GET {LLM_BASE_URL}/models and reasoning is disabled.
- Global default: npm run setup -- --list. Use /model to switch models in chat.
- Rebuild after git pull: SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
- Um processo por volume: use o volume dedicado pi_bot_data.
EOF

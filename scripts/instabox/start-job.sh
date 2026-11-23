#!/usr/bin/env bash
set -euo pipefail
umask 077

JOB_ID="${1:-}"

if [[ ! "$JOB_ID" =~ ^[a-z0-9-]{8,40}$ ]]; then
  echo '{"error":"Invalid jobId"}' >&2
  exit 1
fi

JOBS_BASE="$HOME/jobs"
JOB_DIR="$JOBS_BASE/$JOB_ID"

if [ -d "$JOB_DIR" ]; then
  if [ -f "$JOB_DIR/status.json" ]; then
    cat "$JOB_DIR/status.json"
  else
    echo "{\"jobId\":\"$JOB_ID\",\"state\":\"PENDING\"}"
  fi
  exit 0
fi

# O runner compartilhado tem credenciais de escrita. Recuse o modo legado.
request=$(cat)
if [ "${JOB_READONLY:-}" = "1" ] || ! node -e '
  try {
    if (JSON.parse(require("fs").readFileSync(0, "utf8")).writes === true) process.exit(0);
  } catch {}
  process.exit(1);
' <<< "$request"; then
  echo '{"error":"The shared sandbox requires writes: true."}' >&2
  exit 1
fi

mkdir -p "$JOB_DIR"
printf '%s\n' "$request" > "$JOB_DIR/request.json"

echo '{"state":"PENDING"}' > "$JOB_DIR/status.json.tmp"
mv "$JOB_DIR/status.json.tmp" "$JOB_DIR/status.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/run-job.sh" ]; then
  cp "$SCRIPT_DIR/run-job.sh" "$JOB_DIR/run-job.sh"
  chmod +x "$JOB_DIR/run-job.sh"
  RUNNER="$JOB_DIR/run-job.sh"
elif [ -f "$HOME/bin/run-job.sh" ]; then
  RUNNER="$HOME/bin/run-job.sh"
else
  RUNNER="$(command -v run-job.sh || true)"
fi

if [ -z "$RUNNER" ] || [ ! -f "$RUNNER" ]; then
  echo '{"error":"run-job.sh not found"}' >&2
  exit 1
fi

# New session and ignored SIGHUP: when machines.exec ends it must not kill the runner.
nohup setsid bash "$RUNNER" "$JOB_ID" >/dev/null 2>&1 </dev/null &

echo "{\"jobId\":\"$JOB_ID\",\"state\":\"PENDING\"}"
exit 0

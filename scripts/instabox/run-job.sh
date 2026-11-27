#!/usr/bin/env bash
set -euo pipefail

JOB_ID="${1:-}"

if [[ ! "$JOB_ID" =~ ^[a-z0-9-]{8,40}$ ]]; then
  echo "Invalid jobId" >&2
  exit 1
fi

JOBS_BASE="$HOME/jobs"
JOB_DIR="$JOBS_BASE/$JOB_ID"
STATUS_FILE="$JOB_DIR/status.json"
AGENT_LOG="$JOB_DIR/agent.log"
PHASE=""

# `node -e` has no script name: argv is [node, arg, ...]. `[,, x]` skips the first arg.
fail() {
  local err="$1"
  node -e '
    const fs = require("fs");
    const [, statusPath, err, phase] = process.argv;
    const data = { state: "FAILED", error: err, finishedAt: Date.now(), ...(phase ? { phase } : {}) };
    fs.writeFileSync(statusPath + ".tmp", JSON.stringify(data));
    fs.renameSync(statusPath + ".tmp", statusPath);
  ' "$STATUS_FILE" "$err" "$PHASE"
  exit 1
}

# Grava status RUNNING ou atualiza a fase de forma atômica
running() {
  PHASE="${1:-}"
  node -e '
    const fs = require("fs");
    const [, statusPath, phase] = process.argv;
    const data = phase
      ? { ...JSON.parse(fs.readFileSync(statusPath, "utf8")), phase }
      : { state: "RUNNING", startedAt: Date.now() };
    fs.writeFileSync(statusPath + ".tmp", JSON.stringify(data));
    fs.renameSync(statusPath + ".tmp", statusPath);
  ' "$STATUS_FILE" "$PHASE"
}

if [ ! -f "$JOB_DIR/request.json" ]; then
  fail "request.json not found in the job directory"
fi

# Não execute o modo legado na mesma conta que tem credenciais de escrita.
if [ "${JOB_READONLY:-}" = "1" ] || [ -f "$JOB_DIR/readonly" ] || ! node -e '
  try {
    if (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).writes === true) process.exit(0);
  } catch {}
  process.exit(1);
' "$JOB_DIR/request.json"; then
  fail "The shared sandbox requires writes: true."
fi

if [ -f "$HOME/.agents-env.sh" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.agents-env.sh"
fi

running

# Lê parâmetros de request.json via node
REPO=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(r.repo||"");' "$JOB_DIR/request.json")
AGENT=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(r.agent||"");' "$JOB_DIR/request.json")
BRANCH=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(r.branch||"");' "$JOB_DIR/request.json")
PROMPT=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(r.prompt||"");' "$JOB_DIR/request.json")

if [ -z "$REPO" ]; then
  fail "Missing repo field in request.json"
fi

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || [[ "$REPO" =~ (^|/)\.\.?(/|$) ]]; then
  fail "Invalid repo field in request.json"
fi

if [ -z "$BRANCH" ]; then
  BRANCH="agent/$JOB_ID"
fi

if [[ ! "$BRANCH" =~ ^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$ ]] ||
  [[ "$BRANCH" == *..* || "$BRANCH" == *//* || "$BRANCH" == */. || "$BRANCH" == */ || "$BRANCH" == *.lock || "$BRANCH" == */.* || "$BRANCH" == *. ]]; then
  fail "Invalid branch field in request.json"
fi

WORK_DIR="$HOME/work/$REPO"
mkdir -p "$(dirname "$WORK_DIR")"

running clone
if [ ! -d "$WORK_DIR/.git" ]; then
  gh repo clone "$REPO" "$WORK_DIR" > "$JOB_DIR/clone.log" 2>&1 || fail "Failed to clone repository $REPO"
else
  git -C "$WORK_DIR" fetch origin > "$JOB_DIR/fetch.log" 2>&1 || fail "Git fetch failed for repository $REPO"
fi

# Cria/reseta branch a partir de origin/HEAD
git -C "$WORK_DIR" checkout -B "$BRANCH" origin/HEAD > "$JOB_DIR/checkout.log" 2>&1 || \
git -C "$WORK_DIR" checkout -B "$BRANCH" HEAD > "$JOB_DIR/checkout.log" 2>&1 || \
fail "Failed to create branch $BRANCH in repository $REPO"

if [ -f "$WORK_DIR/package-lock.json" ]; then
  running npm_ci
  (cd "$WORK_DIR" && npm ci) > "$JOB_DIR/npm-ci.log" 2>&1 || fail "npm ci failed in $REPO"
fi

# Executa agente pedido com timeout de 20 min (1200 segundos) e stdin de /dev/null
AGENT_EXIT=0
case "$AGENT" in
  agy)
    running agent
    (cd "$WORK_DIR" && timeout 1200 agy -p "$PROMPT" --dangerously-skip-permissions --add-dir "$JOB_DIR" </dev/null) > "$AGENT_LOG" 2>&1 || AGENT_EXIT=$?
    ;;
  pi)
    running agent
    (cd "$WORK_DIR" && timeout 1200 pi -p "$PROMPT" </dev/null) > "$AGENT_LOG" 2>&1 || AGENT_EXIT=$?
    ;;
  claude)
    running agent
    (cd "$WORK_DIR" && timeout 1200 claude -p "$PROMPT" --dangerously-skip-permissions </dev/null) > "$AGENT_LOG" 2>&1 || AGENT_EXIT=$?
    ;;
  *)
    fail "Agente $AGENT unknown"
    ;;
esac

if [ "$AGENT_EXIT" -eq 124 ]; then
  fail "Agent exceeded the 20-minute time limit"
elif [ "$AGENT_EXIT" -ne 0 ]; then
  fail "Agent $AGENT exited with error code $AGENT_EXIT"
fi

PR_URL=""
# Verifica se há alterações para commitar e criar PR
if [ -n "$(git -C "$WORK_DIR" status --porcelain)" ]; then
  running git
  git -C "$WORK_DIR" add -A > "$JOB_DIR/git.log" 2>&1
  COMMIT_MSG="feat(agent): task $JOB_ID"
  git -C "$WORK_DIR" commit -m "$COMMIT_MSG" >> "$JOB_DIR/git.log" 2>&1 || true
fi

# Se a branch local estiver à frente da origin, faz push normal e cria PR
LOCAL_REV=$(git -C "$WORK_DIR" rev-parse HEAD 2>/dev/null || true)
REMOTE_REV=$(git -C "$WORK_DIR" rev-parse "origin/$BRANCH" 2>/dev/null || true)

if [ "$LOCAL_REV" != "$REMOTE_REV" ] && [ -n "$LOCAL_REV" ]; then
  running push
  git -C "$WORK_DIR" push -u origin "$BRANCH" >> "$JOB_DIR/git.log" 2>&1 || fail "Failed to push branch $BRANCH to origin"
  PR_URL=$(cd "$WORK_DIR" && gh pr create --fill --head "$BRANCH" 2>> "$JOB_DIR/git.log" || gh pr view --json url -q .url 2>> "$JOB_DIR/git.log" || true)
fi

# Grava status final DONE com JSON.stringify via node de forma atômica
node -e '
  const fs = require("fs");
  const [, statusPath, agentLogPath, prUrl, branch, phase] = process.argv;
  let summary = "";
  try {
    if (fs.existsSync(agentLogPath)) {
      const content = fs.readFileSync(agentLogPath, "utf8");
      summary = content.slice(-1500).trim();
    }
  } catch {}
  const result = {
    pr: prUrl ? prUrl.trim() : undefined,
    summary: summary || "Task completed successfully.",
  };
  if (branch) result.branch = branch;
  const res = {
    state: "DONE",
    result,
    finishedAt: Date.now(),
    ...(phase ? { phase } : {}),
  };
  fs.writeFileSync(statusPath + ".tmp", JSON.stringify(res));
  fs.renameSync(statusPath + ".tmp", statusPath);
' "$STATUS_FILE" "$AGENT_LOG" "$PR_URL" "$BRANCH" "$PHASE"

exit 0

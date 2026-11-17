import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const START = join(process.cwd(), "scripts/instabox/start-job.sh");
const RUN = join(process.cwd(), "scripts/instabox/run-job.sh");

const GH = `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then
  mkdir -p "$4/.git"
fi
exit 0
`;

const GIT = `#!/bin/sh
if [ "$1" = "-C" ]; then shift 2; fi
case "$1" in
  rev-parse) printf '%s\\n' abc123 ;;
esac
exit 0
`;

const AGENT = `#!/bin/sh
ps -o sid= -p $$ | tr -d ' ' > "$HOME/agent-sid.txt"
printf '%s\\n' "$*" > "$HOME/agent-args.txt"
sleep 1.2
exit 0
`;

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "instabox-job-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  await writeFile(join(bin, "gh"), GH, { mode: 0o755 });
  await writeFile(join(bin, "git"), GIT, { mode: 0o755 });
  for (const name of ["agy", "pi", "claude"])
    await writeFile(join(bin, name), AGENT, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  return {
    root,
    home,
    env,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [file, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function readStatus(home: string, jobId: string) {
  const raw = await readFile(join(home, "jobs", jobId, "status.json"), "utf8");
  return JSON.parse(raw) as {
    state: string;
    error?: string;
    result?: { pr?: string; branch?: string; summary?: string };
  };
}

async function waitStatus(
  home: string,
  jobId: string,
  ready: (state: string) => boolean,
) {
  const file = join(home, "jobs", jobId, "status.json");
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 8000) {
    try {
      last = await readFile(file, "utf8");
      const parsed = JSON.parse(last) as { state?: string };
      if (parsed.state && ready(parsed.state)) return parsed;
    } catch {
      /* status is replaced atomically; a missing or partial read retries */
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(
    `status de ${jobId} não chegou a tempo: ${last || "<ausente>"}`,
  );
}

test("run-job.sh grava RUNNING e DONE com os argumentos do node -e", async () => {
  const box = await sandbox();
  const jobId = "cj-argvfix1";
  const prompt = 'corrija o argv do node -e, "sem" perder o prompt';
  try {
    const jobDir = join(box.home, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, "request.json"),
      JSON.stringify({
        repo: "example/app",
        agent: "agy",
        prompt,
        branch: "agent/cj-argvfix1",
      }),
    );
    const result = await run(RUN, [jobId], box.env);
    assert.equal(
      result.code,
      0,
      `run-job falhou\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
    const status = await readStatus(box.home, jobId);
    assert.equal(status.state, "DONE");
    assert.equal(status.result?.branch, "agent/cj-argvfix1");
    assert.match(
      status.result?.summary ?? "",
      /stub|Tarefa concluída|sleep|agy/i,
    );
    const args = await readFile(join(box.home, "agent-args.txt"), "utf8");
    assert.match(args, /corrija o argv/);
    assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE|newPath/);
  } finally {
    await box.close();
  }
});

test("fail() grava FAILED no status.json e não perde o caminho no argv", async () => {
  const box = await sandbox();
  const jobId = "cj-failpath";
  try {
    await mkdir(join(box.home, "jobs", jobId), { recursive: true });
    const result = await run(RUN, [jobId], box.env);
    assert.notEqual(result.code, 0);
    const status = await readStatus(box.home, jobId);
    assert.equal(status.state, "FAILED");
    assert.match(status.error ?? "", /request\.json não encontrado/);
    assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE|newPath/);
  } finally {
    await box.close();
  }
});

test("start-job.sh solta o runner numa sessão nova que sobrevive ao fim do exec", async () => {
  const box = await sandbox();
  const jobId = "cj-detach1";
  const prompt = "continue depois que a sessão do exec acabar";
  try {
    const child = spawn("bash", [START, jobId], {
      env: { ...box.env, JOB_READONLY: "1" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(
      JSON.stringify({
        repo: "example/app",
        agent: "agy",
        prompt,
        branch: "agent/cj-detach1",
      }),
    );
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve(status ?? 1));
    });
    assert.equal(code, 0, `start-job falhou\n${stderr}\n${stdout}`);
    assert.match(stdout, /PENDING/);
    await readFile(join(box.home, "jobs", jobId, "readonly"));

    await waitStatus(box.home, jobId, (state) => state === "RUNNING");
    const sidFile = join(box.home, "agent-sid.txt");
    let runnerSid = "";
    const sidWait = Date.now();
    while (Date.now() - sidWait < 4000) {
      try {
        runnerSid = (await readFile(sidFile, "utf8")).trim();
        if (runnerSid) break;
      } catch {
        /* the agent writes its session id as it starts */
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(runnerSid, "o agente não chegou a gravar a sessão");
    assert.notEqual(
      runnerSid,
      String(child.pid),
      "o runner continua na sessão do launcher",
    );
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      try {
        process.kill(-child.pid!, signal);
      } catch (error) {
        const missing =
          !!error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ESRCH";
        if (!missing) throw error;
      }
    }
    const status = await waitStatus(
      box.home,
      jobId,
      (state) => state === "DONE",
    );
    assert.equal(status.state, "DONE");
    const args = await readFile(join(box.home, "agent-args.txt"), "utf8");
    assert.match(args, /sessão do exec/);
  } finally {
    await box.close();
  }
});

function execNode(code: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile("node", ["-e", code, ...args], (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error)));
      else resolve();
    });
  });
}

test("JOB_READONLY=1 drops write credentials and does not open a PR", async () => {
  const box = await sandbox();
  const jobId = "cj-readonly1";
  const bin = join(box.home, "..", "bin");
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$HOME/cmd.log"
if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then
  mkdir -p "$4/.git"
  printf '{}\\n' > "$4/package-lock.json"
fi
if [ "$1" = "pr" ]; then printf '%s\\n' "https://example.test/pull/1"; fi
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "npm"),
    `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$HOME/cmd.log"
printf '%s\\n' "GIT_CONFIG_GLOBAL=\${GIT_CONFIG_GLOBAL-}" "GIT_CONFIG_NOSYSTEM=\${GIT_CONFIG_NOSYSTEM-}" "SSH_AUTH_SOCK=\${SSH_AUTH_SOCK-}" > "$HOME/npm-env.txt"
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
printf 'git %s\\n' "$*" >> "$HOME/cmd.log"
if [ "$1" = "-C" ]; then shift 2; fi
case "$1" in
  rev-parse)
    if [ "$2" = "HEAD" ]; then printf 'local\\n'; else printf 'remote\\n'; fi
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "pi"),
    `#!/bin/sh
printf '%s\\n' "\${GH_TOKEN-}" "\${GITHUB_TOKEN-}" "\${GH_ENTERPRISE_TOKEN-}" "\${GH_CONFIG_DIR-}" "\${GIT_TERMINAL_PROMPT-}" "\${GIT_CONFIG_GLOBAL-}" "\${GIT_CONFIG_NOSYSTEM-}" "\${SSH_AUTH_SOCK-}" > "$HOME/seen.txt"
printf '%s\\n' "$*" > "$HOME/agent-args.txt"
exit 0
`,
    { mode: 0o755 },
  );
  try {
    const jobDir = join(box.home, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, "request.json"),
      JSON.stringify({
        repo: "example/app",
        agent: "pi",
        prompt: "só leia o código",
        branch: "agent/cj-readonly1",
      }),
    );
    const result = await run(RUN, [jobId], {
      ...box.env,
      JOB_READONLY: "1",
      GH_TOKEN: "should-not-reach-the-agent",
      GITHUB_TOKEN: "should-not-reach-the-agent",
      GH_ENTERPRISE_TOKEN: "should-not-reach-the-agent",
      SSH_AUTH_SOCK: "/tmp/ssh-agent-should-not-reach",
    });
    assert.equal(result.code, 0, result.stderr);
    const status = await readStatus(box.home, jobId);
    assert.equal(status.state, "DONE");
    assert.equal(status.result?.pr, undefined);
    assert.equal("branch" in (status.result ?? {}), false);
    const [
      gh,
      github,
      enterprise,
      configDir,
      promptFlag,
      gitConfig,
      noSystem,
      ssh,
    ] = (await readFile(join(box.home, "seen.txt"), "utf8")).split("\n");
    assert.equal(gh, "");
    assert.equal(github, "");
    assert.equal(enterprise, "");
    assert.match(configDir ?? "", /\/gh-readonly$/);
    assert.equal(promptFlag, "0");
    assert.equal(gitConfig, "/dev/null");
    assert.equal(noSystem, "1");
    assert.equal(ssh, "");
    assert.deepEqual(await readdir(configDir ?? ""), []);
    const npmEnv = (
      await readFile(join(box.home, "npm-env.txt"), "utf8")
    ).split("\n");
    assert.deepEqual(npmEnv.slice(0, 3), [
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_NOSYSTEM=1",
      "SSH_AUTH_SOCK=",
    ]);
    assert.match(
      await readFile(join(box.home, "agent-args.txt"), "utf8"),
      /não faça push/,
    );
    const cmds = await readFile(join(box.home, "cmd.log"), "utf8");
    assert.match(cmds, /gh repo clone/);
    assert.match(cmds, /config --local --unset-all credential\.helper/);
    assert.match(cmds, /remote set-url --push origin no-push/);
    const helperAt = cmds.indexOf("credential.helper");
    const npmAt = cmds.indexOf("\nnpm ci");
    assert.ok(helperAt >= 0 && npmAt > helperAt, cmds);
    assert.doesNotMatch(cmds, /\bpush -u\b/);
    assert.doesNotMatch(cmds, /\bpr\b/);
  } finally {
    await box.close();
  }
});

test("a readonly marker blocks publish when the env var was dropped", async () => {
  const box = await sandbox();
  const jobId = "cj-romarker";
  const bin = join(box.home, "..", "bin");
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
printf 'git %s\\n' "$*" >> "$HOME/cmd.log"
if [ "$1" = "-C" ]; then shift 2; fi
case "$1" in
  rev-parse)
    if [ "$2" = "HEAD" ]; then printf 'local\\n'; else printf 'remote\\n'; fi
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$HOME/cmd.log"
if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then mkdir -p "$4/.git"; fi
if [ "$1" = "pr" ]; then printf '%s\\n' "https://example.test/pull/9"; fi
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    const jobDir = join(box.home, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "readonly"), "");
    await writeFile(
      join(jobDir, "request.json"),
      JSON.stringify({
        repo: "example/app",
        agent: "pi",
        prompt: "só leia",
        branch: "agent/cj-romarker",
      }),
    );
    const env: NodeJS.ProcessEnv = { ...box.env };
    delete env.JOB_READONLY;
    const result = await run(RUN, [jobId], env);
    assert.equal(result.code, 0, result.stderr);
    const status = await readStatus(box.home, jobId);
    assert.equal(status.state, "DONE");
    assert.equal(status.result?.pr, undefined);
    assert.equal("branch" in (status.result ?? {}), false);
    const cmds = await readFile(join(box.home, "cmd.log"), "utf8");
    assert.doesNotMatch(cmds, /\bpush -u\b/);
    assert.doesNotMatch(cmds, /\bpr\b/);
  } finally {
    await box.close();
  }
});

test("writes:false keeps a local commit unpublished and unreachable credentials", async () => {
  const box = await sandbox();
  const jobId = "cj-rocommit";
  const bin = join(box.home, "..", "bin");
  const bare = join(box.root, "bare.git");
  const seed = join(box.root, "seed");
  const helper = join(bin, "cred-helper");
  const embedded = "ghs_embed_should_not_leak";
  const fromHelper = "ghs_helper_should_not_leak";
  const fromEnv = "ghs_env_should_not_leak";
  const gitEnv: NodeJS.ProcessEnv = {
    ...box.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete gitEnv.GIT_CONFIG_GLOBAL;
  delete gitEnv.GH_TOKEN;
  delete gitEnv.GITHUB_TOKEN;
  const git = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "/usr/bin/git",
        args,
        { env: gitEnv },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(`${args.join(" ")}\n${stderr || String(error)}`));
          else resolve(stdout);
        },
      );
    });
  await git(["init", "-q", "-b", "main", seed]);
  await git(["-C", seed, "config", "user.email", "t@example.com"]);
  await git(["-C", seed, "config", "user.name", "Test"]);
  await writeFile(join(seed, "README"), "seed\n");
  await git(["-C", seed, "add", "README"]);
  await git(["-C", seed, "commit", "-q", "-m", "seed"]);
  await git(["clone", "--bare", "-q", seed, bare]);
  await writeFile(
    helper,
    `#!/bin/sh
printf '%s\\n' "username=x-access-token" "password=${fromHelper}"
`,
    { mode: 0o755 },
  );
  await git([
    "config",
    "--file",
    join(box.home, ".gitconfig"),
    "user.name",
    "Test",
  ]);
  await git([
    "config",
    "--file",
    join(box.home, ".gitconfig"),
    "user.email",
    "t@example.com",
  ]);
  await git([
    "config",
    "--file",
    join(box.home, ".gitconfig"),
    "credential.helper",
    `!${helper}`,
  ]);
  await git([
    "config",
    "--file",
    join(box.home, ".gitconfig"),
    "credential.https://github.com.helper",
    `!${helper}`,
  ]);
  await mkdir(join(box.home, ".config", "gh"), { recursive: true });
  await writeFile(
    join(box.home, ".config", "gh", "hosts.yml"),
    "github.com:\n  oauth_token: ghs_env_should_not_leak\n  user: example\n",
  );
  await writeFile(
    join(box.home, ".agents-env.sh"),
    `export GITHUB_TOKEN="${fromEnv}"\nexport GH_TOKEN="$GITHUB_TOKEN"\nexport ANTHROPIC_API_KEY="ant-test-key"\n`,
  );
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
printf 'git %s\\n' "$*" >> "$HOME/cmd.log"
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$HOME/cmd.log"
if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then
  /usr/bin/git clone "$FIXTURE_BARE" "$4"
  /usr/bin/git -C "$4" remote set-url origin "https://x-access-token:${embedded}@github.com/example/app.git"
  /usr/bin/git -C "$4" config credential.https://github.com.helper "!${helper}"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}" ]; then exit 0; fi
  cfg="\${GH_CONFIG_DIR:-$HOME/.config/gh}"
  if [ -f "$cfg/hosts.yml" ]; then exit 0; fi
  exit 1
fi
if [ "$1" = "pr" ]; then
  printf '%s\\n' "https://github.com/example/app/pull/1"
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "pi"),
    `#!/bin/sh
unset GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GH_CONFIG_DIR GIT_CONFIG_COUNT
unset GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1
if [ -f "$HOME/.agents-env.sh" ]; then
  . "$HOME/.agents-env.sh"
fi
{
  printf 'token=%s\\n' "\${GH_TOKEN-}"
  printf 'github=%s\\n' "\${GITHUB_TOKEN-}"
  printf 'url=%s\\n' "$(git remote get-url origin 2>/dev/null || true)"
  git credential fill <<EOF || true
protocol=https
host=github.com

EOF
  git credential fill <<EOF || true
url=$(git remote get-url origin 2>/dev/null || true)

EOF
  gh auth status >/dev/null 2>&1
  printf 'gh=%s\\n' "$?"
} > "$HOME/probe.txt" 2>&1
git commit --allow-empty -m "teste read-only" >/dev/null 2>&1
printf 'commit=%s\\n' "$?" >> "$HOME/probe.txt"
exit 0
`,
    { mode: 0o755 },
  );
  try {
    const jobDir = join(box.home, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, "request.json"),
      JSON.stringify({
        repo: "example/app",
        agent: "pi",
        prompt: "teste read-only",
        writes: false,
      }),
    );
    const env: NodeJS.ProcessEnv = {
      ...gitEnv,
      FIXTURE_BARE: bare,
      GH_TOKEN: fromEnv,
      GITHUB_TOKEN: fromEnv,
    };
    delete env.JOB_READONLY;
    const result = await run(RUN, [jobId], env);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const status = await readStatus(box.home, jobId);
    assert.equal(status.state, "DONE");
    assert.equal(status.result?.pr, undefined);
    assert.equal("branch" in (status.result ?? {}), false);
    const probe = await readFile(join(box.home, "probe.txt"), "utf8");
    assert.match(probe, /^token=$/m);
    assert.match(probe, /^github=$/m);
    assert.match(probe, /^gh=1$/m);
    assert.match(probe, /^commit=0$/m);
    assert.doesNotMatch(probe, /password=/);
    assert.doesNotMatch(probe, new RegExp(fromHelper));
    assert.doesNotMatch(probe, new RegExp(fromEnv));
    assert.doesNotMatch(probe, new RegExp(embedded));
    assert.match(probe, /^url=https:\/\/github\.com\/example\/app\.git$/m);
    const work = join(box.home, "work", "example", "app");
    const subject = (
      await git(["-C", work, "log", "-1", "--format=%s"])
    ).trim();
    assert.equal(subject, "teste read-only");
    const published = await git(["-C", bare, "log", "--all", "--format=%s"]);
    assert.doesNotMatch(published, /teste read-only/);
    const cmds = await readFile(join(box.home, "cmd.log"), "utf8");
    assert.doesNotMatch(cmds, /\bpush -u\b/);
    assert.doesNotMatch(cmds, /\bpr create\b/);
    const restored = await readFile(join(box.home, ".agents-env.sh"), "utf8");
    assert.match(restored, new RegExp(fromEnv));
    assert.match(restored, /ANTHROPIC_API_KEY/);
    const gitconfig = await readFile(join(box.home, ".gitconfig"), "utf8");
    assert.match(gitconfig, /credential/);
    await readFile(join(box.home, ".config", "gh", "hosts.yml"), "utf8");
    const pushUrl = (
      await git(["-C", work, "remote", "get-url", "--push", "origin"])
    ).trim();
    assert.match(pushUrl, new RegExp(embedded));
    assert.notEqual(pushUrl, "no-push");
    let helperLine = "unset";
    try {
      helperLine = (
        await git([
          "-C",
          work,
          "config",
          "--local",
          "--get-regexp",
          "^credential\\.helper$",
        ])
      ).trim();
    } catch {
      helperLine = "unset";
    }
    assert.equal(helperLine, "unset");
    const urlHelper = (
      await git([
        "-C",
        work,
        "config",
        "--local",
        "--get",
        "credential.https://github.com.helper",
      ])
    ).trim();
    assert.match(urlHelper, /cred-helper/);
    const filled = await new Promise<string>((resolve, reject) => {
      const child = spawn("/usr/bin/git", ["-C", work, "credential", "fill"], {
        env: gitEnv,
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(err || String(code)));
        else resolve(out);
      });
      child.stdin.end("protocol=https\nhost=github.com\n\n");
    });
    assert.match(filled, new RegExp(`password=${fromHelper}`));
  } finally {
    await box.close();
  }
});

test("os trechos node -e do run-job aceitam o primeiro argumento como caminho", async () => {
  const source = await readFile(RUN, "utf8");
  const snippets = [...source.matchAll(/node -e '([\s\S]*?)'/g)].map(
    (match) => match[1] ?? "",
  );
  const writers = snippets.filter((code) => code.includes("const ["));
  assert.equal(writers.length, 3, "FAILED, RUNNING e DONE gravam status");
  for (const code of writers) {
    assert.match(code, /const \[, /);
    assert.doesNotMatch(code, /const \[,, /);
  }
  for (const code of snippets) {
    if (code.includes("process.stdout.write"))
      assert.match(code, /process\.argv\[1\]/);
  }
  const dir = await mkdtemp(join(tmpdir(), "instabox-snippet-"));
  try {
    const statusPath = join(dir, "status.json");
    const logPath = join(dir, "agent.log");
    await writeFile(logPath, "resumo do agente\n");
    const failed = writers.find((code) => code.includes('"FAILED"'));
    const running = writers.find((code) => code.includes('"RUNNING"'));
    const done = writers.find((code) => code.includes('"DONE"'));
    assert.ok(failed && running && done);
    await execNode(running, [statusPath]);
    assert.equal(
      JSON.parse(await readFile(statusPath, "utf8")).state,
      "RUNNING",
    );
    await execNode(failed, [statusPath, "request.json não encontrado"]);
    const failure = JSON.parse(await readFile(statusPath, "utf8")) as {
      state: string;
      error?: string;
    };
    assert.equal(failure.state, "FAILED");
    assert.match(failure.error ?? "", /request\.json não encontrado/);
    await execNode(done, [
      statusPath,
      logPath,
      "https://github.com/example/other/pull/9",
      "agent/cj-snippet",
    ]);
    const status = JSON.parse(await readFile(statusPath, "utf8")) as {
      state: string;
      result?: { pr?: string; branch?: string; summary?: string };
    };
    assert.equal(status.state, "DONE");
    assert.equal(status.result?.pr, "https://github.com/example/other/pull/9");
    assert.equal(status.result?.branch, "agent/cj-snippet");
    assert.match(status.result?.summary ?? "", /resumo do agente/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * scripts/push-releases.mjs · scripts/pull-releases.mjs · scripts/lib 의 테스트. 네트워크 없이 돈다.
 * 임시 폴더에 bare 원격 + 작업 저장소 + 가짜 발행물 폴더를 만들고, 스크립트를 실제 경로에서
 * TROVE_APP_ROOT=<작업 저장소> 로 실행한다(스크립트는 자기 위치가 아니라 그 폴더를 앱 루트로 본다).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  agentEnvironment,
  buildPlist,
  escapeXml,
  parseLaunchctlPrint,
  programFromPlist,
  protectedFolderOf,
  stableNodePath,
  unescapeXml,
} from "../lib/launchd.mjs";
import { buildCommitMessage, isHttpRemote, isSshRemote, parseRemote, pullReleases, shouldRefuse } from "../lib/releases.mjs";

const execFileAsync = promisify(execFile);
const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUSH_SCRIPT = resolve(scriptsDir, "push-releases.mjs");
const PULL_SCRIPT = resolve(scriptsDir, "pull-releases.mjs");
const AGENT_SCRIPT = resolve(scriptsDir, "macos", "data-push-agent.mjs");

const ITEMS = [
  { id: "m1", title: "앨범 하나", category: "music" },
  { id: "m2", title: "앨범 둘", category: "music" },
  { id: "c1", title: "공연 하나", category: "concert" },
];
const META = { publishedAt: "2026-10-15T15:17:28.580Z", count: ITEMS.length };
const SEOUL_STAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

async function sh(command, args, { cwd, env }) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, env, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    if (typeof cause?.stdout !== "string") throw cause;
    return { code: typeof cause.code === "number" ? cause.code : 1, stdout: cause.stdout, stderr: cause.stderr };
  }
}

/** 호스트의 git 설정·환경이 섞이지 않게 GIT_ 와 TROVE_ 로 시작하는 변수를 걷어내고 HOME 을 임시 폴더로 돌린다. */
function cleanEnv(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || key.startsWith("TROVE_")) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const count = (text, needle) => text.split(needle).length - 1;

async function writeData(dataDir, items, meta = META) {
  await writeFile(join(dataDir, "releases.json"), `${JSON.stringify(items, null, 2)}\n`);
  if (meta === null) await rm(join(dataDir, "releases.meta.json"), { force: true });
  else await writeFile(join(dataDir, "releases.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

/** bare 원격 + main 브랜치 작업 저장소(초기 커밋 1개) + 발행물 폴더. */
async function makeFixture({ withPublic = false } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "trove-push-"));
  const home = join(tmp, "home");
  const bare = join(tmp, "remote.git");
  const app = join(tmp, "app");
  const data = join(tmp, "data");
  await Promise.all([mkdir(home), mkdir(bare), mkdir(app), mkdir(data)]);
  const baseEnv = cleanEnv(home);

  const git = async (args, cwd = app) => {
    const result = await sh("git", args, { cwd, env: baseEnv });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} 실패 (${result.code}):\n${result.stderr}`);
    return result.stdout.trim();
  };

  await git(["init", "--quiet", "--bare", "--initial-branch=main"], bare);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["config", "user.name", "Trove Test"]);
  await git(["config", "user.email", "trove-test@example.com"]);
  await writeFile(join(app, "package.json"), `${JSON.stringify({ name: "trove-fixture", private: true }, null, 2)}\n`);
  await mkdir(join(app, "src"));
  await writeFile(join(app, "src", "note.txt"), "원본 내용\n");
  if (withPublic) {
    await mkdir(join(app, "public"));
    await writeFile(join(app, "public", "keep.txt"), "keep\n");
  }
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "init"]);
  await git(["remote", "add", "origin", bare]);
  await git(["push", "--quiet", "origin", "main"]);
  await writeData(data, ITEMS);

  const env = { ...baseEnv, TROVE_APP_ROOT: app, TROVE_OPS_DATA_DIR: data };
  const fx = {
    tmp,
    home,
    bare,
    app,
    data,
    env,
    git,
    push: (flags = [], extraEnv = {}) =>
      sh(process.execPath, [PUSH_SCRIPT, ...flags], { cwd: app, env: { ...env, ...extraEnv } }),
    remoteLog: async () => (await git(["--git-dir", bare, "log", "--format=%s", "main"])).split("\n"),
    remoteHead: () => git(["--git-dir", bare, "rev-parse", "main"]),
    remoteFile: (path) => git(["--git-dir", bare, "show", `main:${path}`]),
    remoteCommitFiles: async (ref = "main") =>
      (await git(["--git-dir", bare, "diff-tree", "--no-commit-id", "--name-only", "-r", ref]))
        .split("\n")
        .filter(Boolean)
        .sort(),
    localStatus: () => git(["status", "--porcelain", "--untracked-files=all"]),
    localLog: async () => (await git(["log", "--format=%s"])).split("\n"),
    /** 원격(bare)에만 다른 사람의 커밋을 하나 얹는다(트리는 그대로). "원격이 앞서 나간" 상황을 만든다. */
    advanceRemote: async (subject) => {
      const tree = await git(["--git-dir", bare, "rev-parse", "refs/heads/main^{tree}"]);
      const commit = await git([
        "--git-dir", bare, "-c", "user.name=Other", "-c", "user.email=other@example.com",
        "commit-tree", tree, "-p", "refs/heads/main", "-m", subject,
      ]);
      await git(["--git-dir", bare, "update-ref", "refs/heads/main", commit]);
    },
    /** 다른 체크아웃에서 파일을 고쳐 커밋·푸시한다(원격이 같은 파일을 바꾼 상황). */
    pushFromOtherClone: async (subject, mutate) => {
      const dir = await mkdtemp(join(tmp, "other-"));
      await git(["clone", "--quiet", bare, dir], tmp);
      await mutate(dir);
      await git(["add", "-A"], dir);
      await git(["-c", "user.name=Other", "-c", "user.email=other@example.com", "commit", "--quiet", "-m", subject], dir);
      await git(["push", "--quiet", "origin", "main"], dir);
    },
    /** bare 원격에 pre-receive 훅을 둔다(지우려면 null). */
    setPreReceiveHook: async (lines) => {
      const path = join(bare, "hooks", "pre-receive");
      if (lines === null) return rm(path, { force: true });
      await mkdir(join(bare, "hooks"), { recursive: true });
      await writeFile(path, `${["#!/bin/sh", ...lines, ""].join("\n")}`, { mode: 0o755 });
    },
    /** 작업 저장소에 pre-commit 훅을 둔다(지우려면 null). `git commit` 이 실패하는 상황을 만든다. */
    setPreCommitHook: async (lines) => {
      const path = join(app, ".git", "hooks", "pre-commit");
      if (lines === null) return rm(path, { force: true });
      await mkdir(join(app, ".git", "hooks"), { recursive: true });
      await writeFile(path, `${["#!/bin/sh", ...lines, ""].join("\n")}`, { mode: 0o755 });
    },
    /** PATH 앞에 둘 git 대용품: `remote get-url` 에는 GitHub 주소를 답하고 나머지는 진짜 git 에 넘긴다. */
    githubRemoteShim: async () => {
      const bin = join(tmp, "github-bin");
      await mkdir(bin);
      const realGit = (await sh("sh", ["-c", "command -v git"], { cwd: app, env: baseEnv })).stdout.trim();
      await writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          `if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then echo 'https://github.com/test/repo.git'; exit 0; fi`,
          `exec '${realGit}' "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return { ...env, PATH: `${bin}:${process.env.PATH}` };
    },
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
  return fx;
}

const readText = (path) => readFile(path, "utf8");

describe("push-releases: 순서대로 이어지는 시나리오", () => {
  let fx;
  before(async () => {
    fx = await makeFixture({ withPublic: false });
  });
  after(() => fx?.cleanup());

  test("(1) 첫 실행은 public/ 을 만들고 두 파일만 담은 커밋을 푸시한다", async () => {
    const result = await fx.push();
    assert.equal(result.code, 0, result.stderr);

    const log = await fx.remoteLog();
    assert.equal(log.length, 2);
    assert.match(log[0], /^data: 발행 반영 \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(3건: music 2 · concert 1\)$/);
    assert.equal(await fx.remoteFile("public/releases.json"), (await readText(join(fx.data, "releases.json"))).trim());
    assert.equal(await fx.remoteFile("public/releases.meta.json"), (await readText(join(fx.data, "releases.meta.json"))).trim());
    assert.deepEqual(await fx.remoteCommitFiles(), ["public/releases.json", "public/releases.meta.json"]);

    const sha = await fx.git(["rev-parse", "HEAD"]);
    assert.ok(result.stdout.includes(sha), `출력에 커밋 해시가 있어야 해요:\n${result.stdout}`);
    assert.ok(result.stdout.includes("GitHub 가 아니라서"), result.stdout);
    assert.equal(await fx.localStatus(), "");
    assert.equal(await exists(join(fx.app, ".git", "trove-data-push.lock")), false, "잠금은 끝나면 풀려야 해요");

    // 커밋에 trailer 가 붙지 않았는지 (본문은 제목 한 줄)
    const body = await fx.git(["log", "-1", "--format=%B"]);
    assert.equal(body.split("\n").length, 1, body);
  });

  test("(2) 발행물이 그대로면 '변경 없음' 만 찍고 커밋하지 않는다", async () => {
    const result = await fx.push();
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes("변경 없음"), result.stdout);
    assert.equal((await fx.remoteLog()).length, 2);

    const quiet = await fx.push(["--quiet"]);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.equal(quiet.stderr, "");
    const lines = quiet.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, quiet.stdout);
    assert.ok(lines[0].startsWith("변경 없음"), lines[0]);
  });

  test("(3) 발행물이 바뀌면 건수를 담은 두 번째 커밋을 만든다 (--quiet 는 시각 줄을 먼저 찍는다)", async () => {
    const more = [...ITEMS, { id: "g1", category: "game" }, { id: "c2", category: "concert" }];
    await writeData(fx.data, more, { ...META, count: more.length });
    const result = await fx.push(["--quiet"]);
    assert.equal(result.code, 0, result.stderr);
    const log = await fx.remoteLog();
    assert.equal(log.length, 3);
    assert.ok(log[0].includes("(5건: concert 2 · music 2 · game 1)"), log[0]);
    assert.ok(result.stdout.includes("5건"), result.stdout);
    assert.match(result.stdout.split("\n")[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/, result.stdout);
    assert.equal(count(result.stdout, "["), 1, `시각 줄은 한 번만:\n${result.stdout}`);
  });

  test("(3b) 절반 넘게 줄면 거부하고 --allow-shrink 로 넘어간다", async () => {
    const before = await readText(join(fx.app, "public", "releases.json"));
    await writeData(fx.data, ITEMS.slice(0, 2), { ...META, count: 2 });

    const refused = await fx.push();
    assert.equal(refused.code, 1);
    assert.ok(refused.stderr.includes("5건에서 2건"), refused.stderr);
    assert.ok(refused.stderr.includes("--allow-shrink"), refused.stderr);
    assert.ok(refused.stderr.includes("운영 콘솔"), refused.stderr);
    assert.equal(await readText(join(fx.app, "public", "releases.json")), before, "거부하면 원래 파일로 되돌려야 해요");
    assert.equal(await fx.localStatus(), "");
    assert.equal((await fx.remoteLog()).length, 3);

    const allowed = await fx.push(["--allow-shrink"]);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.ok((await fx.remoteLog())[0].includes("(2건: music 2)"));
  });

  test("(4) 빈 목록은 거부하고 되돌리며, --allow-empty 면 반영한다", async () => {
    const before = await readText(join(fx.app, "public", "releases.json"));
    await writeData(fx.data, [], { ...META, count: 0 });

    const refused = await fx.push();
    assert.equal(refused.code, 1);
    assert.ok(refused.stderr.includes("0건"), refused.stderr);
    assert.ok(refused.stderr.includes("--allow-empty"), refused.stderr);
    assert.equal(await readText(join(fx.app, "public", "releases.json")), before);
    assert.equal(await fx.localStatus(), "");
    assert.equal((await fx.remoteLog()).length, 4);

    const allowed = await fx.push(["--allow-empty"]);
    assert.equal(allowed.code, 0, allowed.stderr);
    const log = await fx.remoteLog();
    assert.equal(log.length, 5);
    assert.ok(log[0].includes("(0건)"), log[0]);
    assert.equal(await fx.remoteFile("public/releases.json"), "[]");
  });
});

describe("push-releases: 독립 시나리오", () => {
  const fixtures = [];
  after(() => Promise.all(fixtures.map((fx) => fx.cleanup())));
  async function fixture(options) {
    const fx = await makeFixture(options);
    fixtures.push(fx);
    return fx;
  }

  test("(5) main 이 아닌 브랜치에서는 거부하고 아무것도 바꾸지 않는다 (--quiet 는 시각 줄 뒤에 이유를 찍는다)", async () => {
    const fx = await fixture();
    await fx.git(["switch", "--quiet", "-c", "feature/작업"]);
    const result = await fx.push();
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("'feature/작업' 브랜치"), result.stderr);
    assert.ok(result.stderr.includes("'main'"), result.stderr);
    assert.ok(result.stderr.includes("아무것도 바꾸지 않았어요"), result.stderr);
    assert.equal((await fx.remoteLog()).length, 1);
    assert.equal(await exists(join(fx.app, "public", "releases.json")), false);
    assert.equal(await fx.localStatus(), "");

    const quiet = await fx.push(["--quiet"]);
    assert.equal(quiet.code, 1);
    assert.match(quiet.stdout.trim(), /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/, quiet.stdout);
    assert.ok(quiet.stderr.includes("'feature/작업' 브랜치"), quiet.stderr);
  });

  test("(5b) TROVE_PUSH_BRANCH 로 다른 브랜치를 지정할 수 있다", async () => {
    const fx = await fixture();
    await fx.git(["switch", "--quiet", "-c", "data"]);
    await fx.git(["push", "--quiet", "origin", "data"]);
    const result = await fx.push([], { TROVE_PUSH_BRANCH: "data" });
    assert.equal(result.code, 0, result.stderr);
    const log = (await fx.git(["--git-dir", fx.bare, "log", "--format=%s", "data"])).split("\n");
    assert.equal(log.length, 2);
    assert.ok(log[0].startsWith("data: 발행 반영"));
  });

  test("(5c) 앱 폴더가 저장소 루트가 아니면(TROVE_APP_ROOT 가 하위 폴더) 손대기 전에 멈춘다", async () => {
    const fx = await fixture();
    const sub = join(fx.app, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "package.json"), "{}\n");
    const result = await fx.push([], { TROVE_APP_ROOT: sub });
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes("저장소의 루트"), result.stderr);
    assert.ok(result.stderr.includes("아무것도 바꾸지 않았어요"), result.stderr);
    assert.equal(await fx.localStatus(), "?? sub/package.json");
    assert.equal(await exists(join(fx.app, ".git", "trove-data-push.lock")), false);
  });

  test("(5d) TROVE_APP_ROOT 가 없는 폴더면 'git 명령을 찾지 못했어요' 가 아니라 그 폴더가 없다고 알린다", async () => {
    const fx = await fixture();
    const missing = join(fx.tmp, "missing");
    const result = await fx.push([], { TROVE_APP_ROOT: missing });
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes("앱 폴더가 없어요"), result.stderr);
    assert.ok(result.stderr.includes(missing), result.stderr);
    assert.ok(!result.stderr.includes("PATH"), result.stderr);
    assert.equal(await exists(join(fx.app, ".git", "trove-data-push.lock")), false);
  });

  test("(6) --dry-run 은 원격도 로컬도 바꾸지 않는다 (원격이 앞서 있어도 fast-forward 하지 않는다)", async () => {
    const fx = await fixture();
    // 원격만 한 커밋 앞서게 둔다: 커밋을 올린 뒤 로컬 main 만 되돌린다
    const head = await fx.git(["rev-parse", "HEAD"]);
    await fx.git(["commit", "--quiet", "--allow-empty", "-m", "feat: 다른 사람 작업"]);
    await fx.git(["push", "--quiet", "origin", "main"]);
    await fx.git(["reset", "--quiet", "--hard", head]);
    assert.equal((await fx.remoteLog()).length, 2);

    const result = await fx.push(["--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes("[dry-run]"), result.stdout);
    assert.ok(result.stdout.includes("fast-forward"), result.stdout);
    assert.ok(result.stdout.includes("data: 발행 반영"), result.stdout);
    assert.ok(result.stdout.includes("public/releases.json"), result.stdout);
    assert.equal((await fx.remoteLog()).length, 2);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), head, "dry-run 은 로컬 main 을 fast-forward 하면 안 돼요");
    assert.equal((await fx.localLog()).length, 1);
    assert.equal(await fx.localStatus(), "");
    assert.equal(await exists(join(fx.app, "public")), false, "dry-run 이 만든 public/ 은 지워야 해요");
    assert.equal(await exists(join(fx.app, ".git", "trove-data-push.lock")), false);
  });

  test("(6b) --dry-run 은 커밋되지 않은 발행 파일 변경도 그대로 둔다 (원격이 갈라져 있으면 그것도 알려 주기만 한다)", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    const dirty = '[{"id":"손으로 고친 것"}]\n';
    await writeFile(join(fx.app, "public", "releases.json"), dirty);

    const result = await fx.push(["--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stderr.includes("[dry-run] 커밋되지 않은 발행 파일 변경"), result.stderr);
    assert.equal(await readText(join(fx.app, "public", "releases.json")), dirty, "dry-run 뒤에도 손댄 내용이 그대로여야 해요");
    assert.equal(await fx.localStatus(), "M public/releases.json"); // 한 줄이라 앞 공백이 trim 된다

    // 로컬에 남의 커밋이 있고 원격도 앞서 있으면(갈라짐) dry-run 도 실제 실행처럼 멈춘다
    await fx.git(["commit", "--quiet", "--allow-empty", "-m", "feat: 로컬 작업"]);
    await fx.advanceRemote("feat: 다른 사람 작업");
    const diverged = await fx.push(["--dry-run"]);
    assert.equal(diverged.code, 1, diverged.stdout);
    assert.ok(diverged.stderr.includes("갈라져 있어요"), diverged.stderr);
    assert.equal(await readText(join(fx.app, "public", "releases.json")), dirty);
  });

  test("(6c) --dry-run 은 fast-forward 를 건너뛰어도 원격 커밋 기준으로 예측한다 (원격에 같은 발행물이 이미 있으면 '변경 없음', 급감도 그 건수 기준)", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    // 다른 머신이 이미 지금 발행물을 푸시한 상황: 로컬만 발행 커밋 전으로 돌린다(원격에는 그 커밋이 있다)
    const head = await fx.git(["rev-parse", "HEAD~1"]);
    await fx.git(["reset", "--quiet", "--hard", head]);
    assert.equal(await exists(join(fx.app, "public", "releases.json")), false);

    const result = await fx.push(["--dry-run"]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes("fast-forward"), result.stdout);
    assert.ok(result.stdout.includes("변경 없음"), `실제 실행처럼 '변경 없음' 이어야 해요:\n${result.stdout}`);
    assert.ok(!result.stdout.includes("커밋할 파일"), result.stdout);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), head, "dry-run 은 로컬 main 을 움직이면 안 돼요");
    assert.equal(await fx.localStatus(), "");
    assert.equal(await exists(join(fx.app, "public", "releases.json")), false);

    // 급감 판단도 (아직 fast-forward 하지 않은) 로컬 HEAD 가 아니라 원격 커밋의 건수를 기준으로 한다
    await writeData(fx.data, ITEMS.slice(0, 1), { ...META, count: 1 });
    const shrink = await fx.push(["--dry-run"]);
    assert.equal(shrink.code, 1, shrink.stdout);
    assert.ok(shrink.stderr.includes("3건에서 1건"), shrink.stderr);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), head);
    assert.equal(await fx.localStatus(), "");
    assert.equal(await exists(join(fx.app, "public", "releases.json")), false);
    assert.equal((await fx.remoteLog()).length, 2);
  });

  test("(7) 관련 없는 수정·스테이징은 커밋에 섞이지 않고 그대로 남는다", async () => {
    const fx = await fixture({ withPublic: true });
    await writeFile(join(fx.app, "src", "note.txt"), "고친 내용\n");
    await writeFile(join(fx.app, "notes.txt"), "메모\n");
    await fx.git(["add", "notes.txt"]);
    await writeFile(join(fx.app, "public", "keep.txt"), "changed\n");

    const result = await fx.push();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await fx.remoteCommitFiles(), ["public/releases.json", "public/releases.meta.json"]);
    assert.equal(await readText(join(fx.app, "src", "note.txt")), "고친 내용\n");
    const status = (await fx.localStatus()).split("\n").sort();
    assert.deepEqual(status, [" M public/keep.txt", " M src/note.txt", "A  notes.txt"]);
  });

  test("(8) 발행물을 읽지 못하면 스택 없이 이유와 할 일만 찍고 멈춘다", async () => {
    const fx = await fixture();
    await writeFile(join(fx.data, "releases.json"), '[{"id":"m1","title":"앨범'); // 콘솔이 쓰다 만 파일
    const broken = await fx.push(["--quiet"]);
    assert.equal(broken.code, 1, broken.stdout);
    assert.ok(broken.stderr.includes("읽지 못했어요"), broken.stderr);
    assert.ok(broken.stderr.includes("운영 콘솔에서 먼저 발행했는지"), broken.stderr);
    assert.ok(broken.stderr.includes("TROVE_OPS_DATA_DIR=/path npm run data:push:install"), broken.stderr);
    assert.ok(!broken.stderr.includes("예상치 못한"), broken.stderr);
    assert.ok(!broken.stderr.includes("    at "), `스택이 찍히면 안 돼요:\n${broken.stderr}`);
    assert.equal(await exists(join(fx.app, "public")), false);
    assert.equal(await exists(join(fx.app, ".git", "trove-data-push.lock")), false);

    const missing = await fx.push([], { TROVE_OPS_DATA_DIR: join(fx.tmp, "missing") });
    assert.equal(missing.code, 1);
    assert.ok(missing.stderr.includes("읽지 못했어요"), missing.stderr);
    assert.ok(!missing.stderr.includes("    at "), missing.stderr);
    assert.equal((await fx.remoteLog()).length, 1);
  });

  test("잠금: 살아 있는 실행의 잠금은 거부하고(--quiet 는 건너뜀), 끝난 pid 나 30분 넘은 잠금은 치운다", async () => {
    const fx = await fixture();
    const lockPath = join(fx.app, ".git", "trove-data-push.lock");
    // 이 테스트 프로세스는 살아 있으니 그 pid 로 쓴 잠금은 "진행 중" 이다
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
    const busy = await fx.push();
    assert.equal(busy.code, 1);
    assert.ok(busy.stderr.includes("진행 중"), busy.stderr);
    assert.ok(busy.stderr.includes(String(process.pid)), busy.stderr);
    assert.match(busy.stderr, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} 시작/, "시작 시각은 서울 시각으로");
    assert.doesNotMatch(busy.stderr, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `ISO 시각이 섞이면 안 돼요:\n${busy.stderr}`);
    assert.equal((await fx.remoteLog()).length, 1);
    assert.equal(await exists(lockPath), true, "남의 잠금은 지우지 않아요");

    // 주기 실행(--quiet)은 다음 주기에 다시 돌므로 실패(종료 코드 1)로 치지 않고 한 줄만 남긴다
    const quietBusy = await fx.push(["--quiet"]);
    assert.equal(quietBusy.code, 0, quietBusy.stderr);
    assert.equal(quietBusy.stderr, "");
    assert.match(quietBusy.stdout.trim(), /^다른 발행 반영이 진행 중이라 건너뛰어요 .*\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/, quietBusy.stdout);
    assert.equal(quietBusy.stdout.trim().split("\n").length, 1);
    assert.equal(await exists(lockPath), true);

    // 이미 끝난 프로세스의 pid 로 쓴 잠금은 시각이 최근이어도 치운다(강제 종료·터미널 닫힘이 남긴 것)
    const finished = await sh(process.execPath, ["-e", "console.log(process.pid)"], { cwd: fx.app, env: fx.env });
    await writeFile(lockPath, JSON.stringify({ pid: Number(finished.stdout.trim()), time: new Date().toISOString() }));
    const dead = await fx.push();
    assert.equal(dead.code, 0, dead.stderr);
    assert.ok(dead.stderr.includes("끝난 실행"), dead.stderr);
    assert.equal((await fx.remoteLog()).length, 2);
    assert.equal(await exists(lockPath), false);

    // 아래는 잠금의 나이로 판단하는 경우라, 이 머신이 켜진 지 얼마 안 됐으면(새 CI VM) 40분 전 잠금이 "재부팅 전" 으로 보여 답이 달라진다.
    // 스크립트가 보는 가동 시간을 3일로 고정해 어디서 돌려도 같은 답이 나오게 한다.
    const PINNED_UPTIME_S = 3 * 24 * 60 * 60;
    const uptimeStub = join(fx.tmp, "uptime.mjs");
    await writeFile(
      uptimeStub,
      [
        'import os from "node:os";',
        'import { syncBuiltinESMExports } from "node:module";',
        `os.uptime = () => ${PINNED_UPTIME_S};`,
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );
    const pinnedBoot = { NODE_OPTIONS: `--import=${uptimeStub}` };

    // 살아 있는 실행의 잠금은 30분이 넘었어도 치우지 않는다(치우면 두 실행이 같은 저장소를 동시에 만지고, 먼저 돌던 실행이 끝날 때 새 잠금까지 지운다)
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, time: new Date(Date.now() - 40 * 60 * 1000).toISOString() }));
    const longRunning = await fx.push([], pinnedBoot);
    assert.equal(longRunning.code, 1, longRunning.stdout);
    assert.ok(longRunning.stderr.includes("진행 중"), longRunning.stderr);
    assert.ok(longRunning.stderr.includes("30분 넘게 진행 중"), longRunning.stderr);
    assert.ok(!longRunning.stderr.includes("치웠어요"), longRunning.stderr);
    assert.equal(await exists(lockPath), true, "살아 있는 실행의 잠금은 오래됐어도 지우지 않아요");
    const quietLongRunning = await fx.push(["--quiet"], pinnedBoot);
    assert.equal(quietLongRunning.code, 0, quietLongRunning.stderr);
    assert.ok(quietLongRunning.stdout.includes("건너뛰어요"), quietLongRunning.stdout);
    assert.equal(await exists(lockPath), true);
    await rm(lockPath);

    // 이번 부팅보다 먼저 쓴 잠금은 pid 가 살아 있어 보여도 치운다 — 재부팅 뒤 같은 번호를 받은 다른 프로세스일 뿐이고, 그대로 두면 그 프로세스가 사는 동안 영영 "진행 중" 이다
    const beforeBoot = new Date(Date.now() - PINNED_UPTIME_S * 1000 - 60 * 60 * 1000).toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, time: beforeBoot }));
    const rebooted = await fx.push([], pinnedBoot);
    assert.equal(rebooted.code, 0, rebooted.stderr);
    assert.ok(rebooted.stderr.includes("재부팅 전 실행"), rebooted.stderr);
    assert.ok(rebooted.stderr.includes(String(process.pid)), rebooted.stderr);
    assert.ok(rebooted.stderr.includes("치웠어요"), rebooted.stderr);
    assert.ok(!rebooted.stderr.includes("30분"), `재부팅 전 잠금은 30분 규칙 전에 치워야 해요:\n${rebooted.stderr}`);
    assert.equal(await exists(lockPath), false, "재부팅 전 잠금이 남으면 그 pid 가 사는 동안 발행이 영영 멈춰요");
    assert.equal((await fx.remoteLog()).length, 2, "변경이 없으니 커밋은 늘지 않아요");
    // 부팅 뒤 1분 안의 시계 보정 여유: 부팅 직후 시각의 잠금은 재부팅 전으로 보지 않는다(살아 있는 pid 라 "진행 중")
    const justAfterBoot = new Date(Date.now() - PINNED_UPTIME_S * 1000 + 30 * 1000).toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, time: justAfterBoot }));
    const sinceBoot = await fx.push([], pinnedBoot);
    assert.equal(sinceBoot.code, 1, sinceBoot.stdout);
    assert.ok(sinceBoot.stderr.includes("30분 넘게 진행 중"), sinceBoot.stderr);
    assert.ok(!sinceBoot.stderr.includes("재부팅"), sinceBoot.stderr);
    assert.equal(await exists(lockPath), true);
    await rm(lockPath);

    // pid 를 알 수 없는 잠금은 30분 기준으로만 판단한다
    await writeFile(lockPath, JSON.stringify({ time: new Date(Date.now() - 40 * 60 * 1000).toISOString() }));
    const stale = await fx.push([], pinnedBoot);
    assert.equal(stale.code, 0, stale.stderr);
    assert.ok(stale.stderr.includes("30분"), stale.stderr);
    assert.equal((await fx.remoteLog()).length, 2, "변경이 없으니 커밋은 늘지 않아요");
    assert.equal(await exists(lockPath), false);
  });

  test("잠금: SIGHUP(터미널 닫힘)으로 죽어도 잠금을 푼다", async () => {
    const fx = await fixture();
    const lockPath = join(fx.app, ".git", "trove-data-push.lock");
    // fetch 가 느린 원격을 흉내 내기 어렵다. 대신 잠금을 쥔 직후 멈추도록, 원격 fetch 를 오래 걸리게 하는 git 대용품을 PATH 앞에 둔다.
    const bin = join(fx.tmp, "slow-bin");
    await mkdir(bin);
    const realGit = (await sh("sh", ["-c", "command -v git"], { cwd: fx.app, env: fx.env })).stdout.trim();
    await writeFile(
      join(bin, "git"),
      ["#!/bin/sh", `if [ "$1" = "fetch" ]; then sleep 20; fi`, `exec '${realGit}' "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );
    const child = execFile(process.execPath, [PUSH_SCRIPT], {
      cwd: fx.app,
      env: { ...fx.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
    for (let waited = 0; !(await exists(lockPath)) && waited < 10_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
    assert.equal(await exists(lockPath), true, "잠금을 쥔 상태를 만들지 못했어요");
    child.kill("SIGHUP");
    const outcome = await exited;
    assert.equal(outcome.code, 129, JSON.stringify(outcome));
    assert.equal(await exists(lockPath), false, "SIGHUP 뒤에 잠금이 남으면 안 돼요");
  });

  test("로컬에 이 스크립트가 만들지 않은 미푸시 커밋이 있으면 멈춘다", async () => {
    const fx = await fixture();
    await fx.git(["commit", "--quiet", "--allow-empty", "-m", "feat: 로컬 작업"]);
    const result = await fx.push();
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("푸시되지 않은 커밋"), result.stderr);
    assert.ok(result.stderr.includes("feat: 로컬 작업"), result.stderr);
    assert.equal((await fx.remoteLog()).length, 1);
    assert.equal(await exists(join(fx.app, "public", "releases.json")), false);
  });

  test("지난 실행이 푸시에 실패해 남긴 발행 커밋은 다음 실행이 푸시한다", async () => {
    const fx = await fixture();
    const first = await fx.push();
    assert.equal(first.code, 0, first.stderr);
    // 푸시만 빠진 상태를 재현: 원격을 한 커밋 전으로 되돌린다
    await fx.git(["--git-dir", fx.bare, "update-ref", "refs/heads/main", await fx.git(["rev-parse", "HEAD~1"])]);
    assert.equal((await fx.remoteLog()).length, 1);

    const second = await fx.push();
    assert.equal(second.code, 0, second.stderr);
    assert.ok(second.stdout.includes("푸시되지 않은 발행 커밋"), second.stdout);
    assert.equal((await fx.remoteLog()).length, 2);
  });

  test("data:pull 로 작업 폴더가 먼저 덮여 있어도 급감 거부는 HEAD 기준으로 판단한다", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    await writeData(fx.data, ITEMS.slice(0, 1), { ...META, count: 1 });
    const pulled = await sh(process.execPath, [PULL_SCRIPT], { cwd: fx.app, env: fx.env });
    assert.equal(pulled.code, 0, pulled.stderr);
    assert.notEqual(await fx.localStatus(), "", "data:pull 뒤에는 작업 폴더가 HEAD 와 달라야 해요");

    const refused = await fx.push(["--quiet"]);
    assert.equal(refused.code, 1, refused.stdout);
    assert.ok(refused.stderr.includes("3건에서 1건"), refused.stderr);
    assert.ok(refused.stderr.includes("먼저 되돌려요"), refused.stderr);
    assert.equal((await fx.remoteLog()).length, 2, "급감한 발행물이 푸시되면 안 돼요");
    assert.equal(await fx.localStatus(), "");
  });

  test("커밋되지 않은 발행 파일이 남아 있어도 먼저 되돌리고 원격과 맞춘다 (원격이 같은 파일을 바꿨어도)", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    const more = [...ITEMS, { id: "g1", category: "game" }];
    await writeData(fx.data, more, { ...META, count: more.length });
    assert.equal((await fx.push()).code, 0);
    assert.equal((await fx.remoteLog()).length, 3);
    // 로컬만 한 커밋 전으로 돌리고(원격이 public/releases.json 을 바꾼 커밋만큼 앞섬), 작업 폴더의 발행 파일을 손댄 채 둔다
    await fx.git(["reset", "--quiet", "--hard", "HEAD~1"]);
    await writeFile(join(fx.app, "public", "releases.json"), "[]\n");
    assert.equal(await fx.localStatus(), "M public/releases.json"); // 한 줄이라 앞 공백이 trim 된다

    const result = await fx.push();
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes("커밋되지 않은 발행 파일 변경을 먼저 되돌려요"), result.stderr);
    assert.ok(!result.stderr.includes("갈라져"), result.stderr);
    assert.ok(result.stdout.includes("변경 없음"), result.stdout);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), await fx.remoteHead());
    assert.equal(await fx.localStatus(), "");
    assert.equal((await fx.remoteLog()).length, 3);
  });

  test("손댄 다른 파일을 원격 커밋이 덮어쓰게 되면 '갈라짐' 이 아니라 그 파일 이름을 대며 멈춘다", async () => {
    const fx = await fixture();
    await fx.pushFromOtherClone("docs: 메모 수정", (dir) => writeFile(join(dir, "src", "note.txt"), "다른 사람이 고친 내용\n"));
    await writeFile(join(fx.app, "src", "note.txt"), "내가 고치던 내용\n");

    const result = await fx.push();
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes("커밋하지 않은 수정"), result.stderr);
    assert.ok(result.stderr.includes("src/note.txt"), result.stderr);
    assert.ok(!result.stderr.includes("갈라져"), result.stderr);
    assert.equal((await fx.remoteLog()).length, 2);
    assert.equal(await fx.localStatus(), "M src/note.txt");
    assert.equal(await readText(join(fx.app, "src", "note.txt")), "내가 고치던 내용\n");
  });

  test("푸시 직전에 원격이 앞서 나가면(non-fast-forward) 받아와 올린 뒤 다시 푸시하고, 실제로 올라간 해시를 알린다", async () => {
    const fx = await fixture();
    // 첫 푸시 때만 pre-receive 훅이 원격 main 에 다른 커밋을 끼워 넣고 정상 종료한다 → ref 갱신 실패(일시 오류로 보고 잠깐 뒤 재시도)
    // → 재시도에서 non-fast-forward → 받아와 rebase 한 뒤 푸시해야 한다.
    await fx.setPreReceiveHook([
      'marker="$GIT_DIR/hook-fired"',
      'if [ ! -f "$marker" ]; then',
      '  touch "$marker"',
      "  export GIT_AUTHOR_NAME=Other GIT_AUTHOR_EMAIL=other@example.com GIT_COMMITTER_NAME=Other GIT_COMMITTER_EMAIL=other@example.com",
      "  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES # 훅 격리 밖에서 실제 ref 를 움직인다",
      '  tree=$(git rev-parse "refs/heads/main^{tree}")',
      '  commit=$(echo "feat: 다른 사람 작업" | git commit-tree "$tree" -p refs/heads/main)',
      '  git update-ref refs/heads/main "$commit"',
      "fi",
      "exit 0",
    ]);

    const result = await fx.push();
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes("1/3"), result.stderr);
    assert.ok(result.stdout.includes("먼저 받아온 뒤 다시 푸시"), result.stdout);
    const log = await fx.remoteLog();
    assert.equal(log.length, 3, log.join("\n"));
    assert.ok(log[0].startsWith("data: 발행 반영"), log[0]);
    assert.equal(log[1], "feat: 다른 사람 작업");
    assert.equal(await fx.localStatus(), "");
    assert.equal(await fx.git(["rev-parse", "HEAD"]), await fx.remoteHead());
    assert.ok(result.stdout.includes(await fx.remoteHead()), `출력의 커밋 해시는 원격에 실제로 올라간 것이어야 해요:\n${result.stdout}`);
  });

  test("푸시 직전에 원격이 손대던 파일을 바꿨으면, 발행 커밋이 로컬에 남았다고 말하며 rebase 전에 멈춘다 ('아무것도 바꾸지 않았어요' 는 거짓이다)", async () => {
    const fx = await fixture();
    await writeFile(join(fx.app, "src", "note.txt"), "내가 고치던 내용\n");
    // PATH 앞에 둔 git 대용품이 첫 push 직전에 다른 체크아웃에서 src/note.txt 를 고친 커밋을 원격에 올린다.
    // 이 실행은 발행 커밋을 만든 뒤에야 non-fast-forward 를 보고 받아오는데, 그 커밋이 손대던 파일을 건드리므로 rebase 전에 멈춰야 한다.
    const bin = join(fx.tmp, "bin");
    const other = join(fx.tmp, "other");
    const marker = join(fx.tmp, "pushed-once");
    await mkdir(bin);
    const realGit = (await sh("sh", ["-c", "command -v git"], { cwd: fx.app, env: fx.env })).stdout.trim();
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `real='${realGit}'`,
        `if [ "$1" = "push" ] && [ ! -e '${marker}' ]; then`,
        `  : > '${marker}'`,
        `  "$real" clone --quiet '${fx.bare}' '${other}'`,
        `  printf '다른 사람이 고친 내용\\n' > '${other}/src/note.txt'`,
        `  "$real" -C '${other}' -c user.name=Other -c user.email=other@example.com commit --quiet -am "docs: 메모 수정"`,
        `  "$real" -C '${other}' push --quiet origin main`,
        "fi",
        'exec "$real" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await fx.push([], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes("먼저 받아온 뒤 다시 푸시"), result.stdout);
    assert.ok(result.stderr.includes("커밋하지 않은 수정"), result.stderr);
    assert.ok(result.stderr.includes("src/note.txt"), result.stderr);
    assert.ok(result.stderr.includes("로컬에 만들어졌고"), result.stderr);
    assert.ok(!result.stderr.includes("아무것도 바꾸지 않았어요"), `발행 커밋을 만든 뒤에 이렇게 말하면 거짓이에요:\n${result.stderr}`);
    const log = await fx.localLog();
    assert.equal(log.length, 2, log.join("\n"));
    assert.ok(log[0].startsWith("data: 발행 반영"), log[0]);
    const head = await fx.git(["rev-parse", "HEAD"]);
    assert.ok(result.stderr.includes(head.slice(0, 7)), `남은 발행 커밋의 해시를 알려 줘야 해요:\n${result.stderr}`);
    assert.deepEqual(await fx.remoteLog(), ["docs: 메모 수정", "init"]);
    assert.equal(await fx.localStatus(), "M src/note.txt");
    assert.equal(await readText(join(fx.app, "src", "note.txt")), "내가 고치던 내용\n", "충돌 표식이 들어가면 안 돼요");
    assert.equal(await fx.git(["stash", "list"]), "", "autostash 가 남으면 안 돼요");

    // 그 수정을 치우면 다음 실행이 남은 발행 커밋을 원격 위로 올려 푸시한다(메시지가 약속한 대로)
    await fx.git(["stash", "push", "--quiet", "--", "src/note.txt"]);
    const retried = await fx.push();
    assert.equal(retried.code, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.ok(retried.stdout.includes("원격 위로 올려요"), retried.stdout);
    const remote = await fx.remoteLog();
    assert.equal(remote.length, 3, remote.join("\n"));
    assert.ok(remote[0].startsWith("data: 발행 반영"), remote[0]);
    assert.equal(remote[1], "docs: 메모 수정");
    assert.equal(await fx.git(["rev-parse", "HEAD"]), await fx.remoteHead());
  });

  test("원격이 거듭 앞서 나가도 시도 횟수가 남는 동안은 매번 받아와 올린다", async () => {
    const fx = await fixture();
    // PATH 앞에 둔 git 대용품이 처음 두 번의 push 직전마다 원격을 한 커밋씩 앞서게 한다
    const bin = join(fx.tmp, "bin");
    const markers = join(fx.tmp, "markers");
    await Promise.all([mkdir(bin), mkdir(markers)]);
    const realGit = (await sh("sh", ["-c", "command -v git"], { cwd: fx.app, env: fx.env })).stdout.trim();
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `real='${realGit}'`,
        `bare='${fx.bare}'`,
        `markers='${markers}'`,
        'if [ "$1" = "push" ]; then',
        '  n=$(ls "$markers" | wc -l | tr -d " ")',
        '  if [ "$n" -lt 2 ]; then',
        "    n=$((n + 1))",
        '    : > "$markers/$n"',
        '    tree=$("$real" --git-dir "$bare" rev-parse "refs/heads/main^{tree}")',
        '    commit=$("$real" --git-dir "$bare" -c user.name=Other -c user.email=other@example.com commit-tree "$tree" -p refs/heads/main -m "feat: 다른 사람 작업 $n")',
        '    "$real" --git-dir "$bare" update-ref refs/heads/main "$commit"',
        "  fi",
        "fi",
        'exec "$real" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await fx.push([], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(count(result.stdout, "먼저 받아온 뒤 다시 푸시해요"), 2, result.stdout);
    assert.ok(!result.stderr.includes("초 뒤 다시 시도"), result.stderr);
    const log = await fx.remoteLog();
    assert.ok(log[0].startsWith("data: 발행 반영"), log.join("\n"));
    assert.deepEqual(log.slice(1), ["feat: 다른 사람 작업 2", "feat: 다른 사람 작업 1", "init"]);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), await fx.remoteHead());
    assert.ok(result.stdout.includes(await fx.remoteHead()), result.stdout);
    assert.equal(await fx.localStatus(), "");
  });

  test("로그인·권한 때문에 거절된 푸시는 재시도 없이 바로 멈추고, 원인을 고치면 다음 실행이 그 커밋을 푸시한다", async () => {
    const fx = await fixture();
    await fx.setPreReceiveHook(['echo "Permission denied" >&2', "exit 1"]);
    const started = Date.now();
    const denied = await fx.push();
    assert.equal(denied.code, 1, denied.stdout);
    assert.ok(denied.stderr.includes("원격 'origin' 이 푸시를 거절했어요"), denied.stderr);
    assert.ok(denied.stderr.includes("git push origin main"), denied.stderr);
    assert.equal(count(denied.stderr, "Permission denied"), 1, `같은 오류가 여러 번 찍히면 안 돼요:\n${denied.stderr}`);
    assert.ok(!denied.stderr.includes("다시 시도해요"), denied.stderr);
    assert.ok(Date.now() - started < 2000, "재시도 대기(2초) 없이 끝나야 해요");
    assert.equal((await fx.remoteLog()).length, 1);
    assert.equal((await fx.localLog()).length, 2, "커밋은 로컬에 남아 있어야 해요");
    assert.equal(await fx.localStatus(), "");

    // 로그인 정보가 없는 경우(git 이 프롬프트를 못 띄움)는 키체인에 저장하라고 안내한다
    await fx.setPreReceiveHook(["echo \"fatal: could not read Username for 'https://github.com': terminal prompts disabled\" >&2", "exit 1"]);
    const noLogin = await fx.push();
    assert.equal(noLogin.code, 1, noLogin.stdout);
    assert.ok(noLogin.stdout.includes("푸시되지 않은 발행 커밋 1개"), noLogin.stdout);
    assert.ok(noLogin.stderr.includes("원격 'origin' 에 로그인할 수 없어서"), noLogin.stderr);
    assert.ok(noLogin.stderr.includes("키체인"), noLogin.stderr);
    assert.ok(noLogin.stderr.includes("git push origin main"), noLogin.stderr);
    assert.ok(!noLogin.stderr.includes("다시 시도해요"), noLogin.stderr);
    assert.equal((await fx.remoteLog()).length, 1);

    await fx.setPreReceiveHook(null);
    const retried = await fx.push();
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal((await fx.remoteLog()).length, 2);
  });

  test("커밋이 실패하면(pre-commit 훅 거절) 스테이징을 풀고 발행 파일을 원래대로 되돌린 뒤 멈춘다", async () => {
    const fx = await fixture();
    await fx.setPreCommitHook(['echo "hook says no" >&2', "exit 1"]);
    const failed = await fx.push();
    assert.equal(failed.code, 1, failed.stdout);
    assert.ok(failed.stderr.includes("커밋을 만들지 못했어요"), failed.stderr);
    assert.ok(failed.stderr.includes("hook says no"), failed.stderr);
    assert.ok(failed.stderr.includes("원래대로 되돌렸어요"), failed.stderr);
    assert.equal(await fx.localStatus(), "", "스테이징된 발행 파일이 남으면 안 돼요");
    assert.equal(await exists(join(fx.app, "public")), false, "이 실행이 만든 public/ 은 지워야 해요");
    assert.equal((await fx.remoteLog()).length, 1);

    await fx.setPreCommitHook(null);
    const retried = await fx.push();
    assert.equal(retried.code, 0, retried.stderr);
    assert.ok(!retried.stderr.includes("커밋되지 않은 발행 파일 변경을 먼저 되돌려요"), `앞 실행이 깨끗이 되돌렸어야 해요:\n${retried.stderr}`);
    assert.equal((await fx.remoteLog()).length, 2);

    // 이미 커밋된 발행 파일이 바뀌는 경우("M ")도 HEAD 내용으로 되돌리고, 원래 있던 public/ 은 그대로 둔다
    const before = await readText(join(fx.app, "public", "releases.json"));
    await writeData(fx.data, [...ITEMS, { id: "g1", category: "game" }], { ...META, count: 4 });
    await fx.setPreCommitHook(['echo "hook says no" >&2', "exit 1"]);
    const failedAgain = await fx.push();
    assert.equal(failedAgain.code, 1, failedAgain.stdout);
    assert.ok(failedAgain.stderr.includes("원래대로 되돌렸어요"), failedAgain.stderr);
    assert.equal(await fx.localStatus(), "");
    assert.equal(await readText(join(fx.app, "public", "releases.json")), before);
    assert.equal(await exists(join(fx.app, "public")), true);
    assert.equal((await fx.remoteLog()).length, 2);
  });

  test("커밋도 되돌리기도 실패하면(.git/index.lock) 되돌렸다고 하지 않고, 다음 실행이 먼저 되돌린다고 알린다", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    const before = await readText(join(fx.app, "public", "releases.json"));
    const more = [...ITEMS, { id: "g1", category: "game" }];
    await writeData(fx.data, more, { ...META, count: more.length });
    // 죽은 git 이 남긴 index.lock: `git add` 도, 되돌리는 `git checkout --` 도 같은 잠금에 막힌다
    const indexLock = join(fx.app, ".git", "index.lock");
    await writeFile(indexLock, "");

    const failed = await fx.push();
    assert.equal(failed.code, 1, failed.stdout);
    assert.ok(failed.stderr.includes("스테이징하지 못했어요"), failed.stderr);
    assert.ok(failed.stderr.includes("index.lock"), failed.stderr);
    assert.ok(failed.stderr.includes("되돌리지 못했어요"), failed.stderr);
    assert.ok(failed.stderr.includes("다음 실행에서 먼저 되돌려요"), failed.stderr);
    assert.ok(!failed.stderr.includes("원래대로 되돌렸어요"), `되돌리지 못했는데 되돌렸다고 하면 거짓이에요:\n${failed.stderr}`);
    const status = (await fx.localStatus()).split("\n").map((line) => line.trim()).sort(); // 첫 줄의 앞 공백은 trim 된다
    assert.deepEqual(status, ["M public/releases.json", "M public/releases.meta.json"], "되돌리지 못했으니 발행 파일은 바뀐 채 남아 있어야 해요");
    assert.notEqual(await readText(join(fx.app, "public", "releases.json")), before);
    assert.equal((await fx.remoteLog()).length, 2);
    assert.equal(await exists(join(fx.app, ".git", "trove-data-push.lock")), false);

    // 잠금이 치워지면 다음 실행이 약속대로 먼저 되돌린 뒤 새 발행물을 반영한다
    await rm(indexLock);
    const retried = await fx.push();
    assert.equal(retried.code, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.ok(retried.stderr.includes("커밋되지 않은 발행 파일 변경을 먼저 되돌려요"), retried.stderr);
    assert.equal(await fx.localStatus(), "");
    const log = await fx.remoteLog();
    assert.equal(log.length, 3, log.join("\n"));
    assert.ok(log[0].includes("(4건:"), log[0]);
  });

  test("--quiet 라도 커밋되지 않은 발행 파일을 되돌렸으면 '변경 없음' 한 줄로 줄이지 않고 그 경고를 남긴다", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    await writeFile(join(fx.app, "public", "releases.json"), "[]\n");

    const result = await fx.push(["--quiet"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stderr.includes("커밋되지 않은 발행 파일 변경을 먼저 되돌려요"), `되돌린 흔적이 로그에 남아야 해요:\n${result.stdout}`);
    assert.match(result.stdout.split("\n")[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/, result.stdout);
    assert.ok(result.stdout.includes("변경 없음"), result.stdout);
    assert.equal(await fx.localStatus(), "");
    assert.equal((await fx.remoteLog()).length, 2);

    // 경고가 없으면 여전히 한 줄만 남긴다
    const calm = await fx.push(["--quiet"]);
    assert.equal(calm.code, 0, calm.stderr);
    assert.equal(calm.stderr, "");
    assert.equal(calm.stdout.trim().split("\n").length, 1, calm.stdout);
  });

  test("발행 파일을 되돌린 뒤에 멈추면 '아무것도 바꾸지 않았어요' 대신 되돌린 사실을 말한다", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    const clean = await fx.push([], { TROVE_OPS_DATA_DIR: join(fx.tmp, "missing") });
    assert.equal(clean.code, 1, clean.stdout);
    assert.ok(clean.stderr.includes("읽지 못했어요"), clean.stderr);
    assert.ok(clean.stderr.includes("아무것도 바꾸지 않았어요"), clean.stderr);

    await writeFile(join(fx.app, "public", "releases.json"), "[]\n");
    const restored = await fx.push([], { TROVE_OPS_DATA_DIR: join(fx.tmp, "missing") });
    assert.equal(restored.code, 1, restored.stdout);
    assert.ok(restored.stderr.includes("먼저 되돌려요"), restored.stderr);
    assert.ok(restored.stderr.includes("되돌린 것 외에는 바꾸지 않았어요"), restored.stderr);
    assert.ok(!restored.stderr.includes("아무것도 바꾸지 않았어요"), `되돌린 뒤에 이렇게 말하면 거짓이에요:\n${restored.stderr}`);
    assert.equal(await fx.localStatus(), "");

    // 되돌린 뒤 로컬에 남의 미푸시 커밋이 걸려도 같다
    await writeFile(join(fx.app, "public", "releases.json"), "[]\n");
    await fx.git(["commit", "--quiet", "--allow-empty", "-m", "feat: 로컬 작업"]);
    const foreign = await fx.push();
    assert.equal(foreign.code, 1, foreign.stdout);
    assert.ok(foreign.stderr.includes("푸시되지 않은 커밋"), foreign.stderr);
    assert.ok(foreign.stderr.includes("되돌린 것 외에는 바꾸지 않았어요"), foreign.stderr);
    assert.ok(!foreign.stderr.includes("아무것도 바꾸지 않았어요"), foreign.stderr);
  });

  // --wait 는 `git remote get-url` 이 GitHub 주소일 때만 돈다. url.<bare>.insteadOf 는 get-url 이 펼쳐 버려 쓸 수 없으니 PATH 의 git 대용품으로 답하고,
  // GitHub API 는 `node --import` 로 globalThis.fetch 를 바꿔 흉내 낸다.
  test("--wait: GitHub API 가 403 을 돌려주면 경고 한 줄만 남기고 바로 끝낸다 (5분 동안 20초마다 되묻지 않는다)", async () => {
    const fx = await fixture();
    const env = await fx.githubRemoteShim();
    const stub = join(fx.tmp, "fetch-403.mjs");
    await writeFile(stub, 'globalThis.fetch = async () => new Response("{}", { status: 403 });\n');

    const started = Date.now();
    const result = await sh(process.execPath, ["--import", stub, PUSH_SCRIPT, "--wait"], { cwd: fx.app, env });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes("https://github.com/test/repo/commit/"), result.stdout);
    assert.ok(result.stdout.includes("배포 상태를 기다려요"), result.stdout);
    assert.equal(count(result.stderr, "조회할 수 없어요"), 1, result.stderr);
    assert.ok(result.stderr.includes("GitHub API 403"), result.stderr);
    assert.ok(!result.stderr.includes("읽지 못했어요"), result.stderr);
    assert.ok(!result.stdout.includes("배포가 끝나지 않았어요"), result.stdout);
    // 실행 전체(node 기동, git 스무 번, 실제 커밋·푸시)를 재는 것이라 느린 머신 여유를 둔다. 막으려는 것은 WAIT_INTERVAL_MS(20초) 대기 한 번이다.
    assert.ok(Date.now() - started < 10_000, "포기하는 응답이면 20초 대기 없이 끝나야 해요");
    assert.equal((await fx.remoteLog()).length, 2);
  });

  test("--wait: 배포 상태가 success 면 '배포가 끝났어요', failure 면 종료 코드 1 로 멈춘다 (푸시는 이미 된 뒤)", async () => {
    const fx = await fixture();
    const env = await fx.githubRemoteShim();
    const stubFor = async (state) => {
      const path = join(fx.tmp, `fetch-${state}.mjs`);
      await writeFile(
        path,
        [
          "globalThis.fetch = async (url) =>",
          "  new Response(",
          "    JSON.stringify(",
          '      String(url).includes("/statuses")',
          `        ? [{ state: ${JSON.stringify(state)} }]`,
          '        : [{ statuses_url: "https://api.github.com/repos/test/repo/deployments/1/statuses" }],',
          "    ),",
          "    { status: 200 },",
          "  );",
          "",
        ].join("\n"),
      );
      return path;
    };

    const success = await sh(process.execPath, ["--import", await stubFor("success"), PUSH_SCRIPT, "--wait"], { cwd: fx.app, env });
    assert.equal(success.code, 0, `${success.stdout}\n${success.stderr}`);
    assert.ok(success.stdout.includes("배포 상태: success"), success.stdout);
    assert.ok(success.stdout.includes("배포가 끝났어요"), success.stdout);
    assert.equal(success.stderr, "");

    await writeData(fx.data, [...ITEMS, { id: "m3", title: "앨범 셋", category: "music" }], { ...META, count: 4 });
    const failure = await sh(process.execPath, ["--import", await stubFor("failure"), PUSH_SCRIPT, "--wait"], { cwd: fx.app, env });
    assert.equal(failure.code, 1, failure.stdout);
    assert.ok(failure.stdout.includes("배포 상태: failure"), failure.stdout);
    assert.ok(failure.stderr.includes("배포가 실패했어요 (failure)"), failure.stderr);
    assert.equal((await fx.remoteLog()).length, 3, "푸시는 배포를 기다리기 전에 이미 끝나 있어야 해요");
  });
});

describe("push-releases: 푸시 못한 발행 커밋 뒤로 원격이 앞서 나간 경우", () => {
  const fixtures = [];
  after(() => Promise.all(fixtures.map((fx) => fx.cleanup())));
  async function fixture(options) {
    const fx = await makeFixture(options);
    fixtures.push(fx);
    return fx;
  }

  test("발행 커밋만 앞서 있으면 받아온 원격 위로 올려 푸시한다", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    // 푸시만 빠진 상태 + 그 사이 원격에 PR 이 머지된 상황
    await fx.git(["--git-dir", fx.bare, "update-ref", "refs/heads/main", await fx.git(["rev-parse", "HEAD~1"])]);
    await fx.advanceRemote("Merge pull request #3 from other/feature");
    assert.deepEqual(await fx.remoteLog(), ["Merge pull request #3 from other/feature", "init"]);

    const result = await fx.push(["--quiet"]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes("원격 위로 올려요"), result.stdout);
    const log = await fx.remoteLog();
    assert.equal(log.length, 3, log.join("\n"));
    assert.ok(log[0].startsWith("data: 발행 반영"), log[0]);
    assert.equal(log[1], "Merge pull request #3 from other/feature");
    assert.equal(await fx.localStatus(), "");
    assert.equal(await fx.git(["rev-parse", "HEAD"]), await fx.remoteHead());
    assert.ok(result.stdout.includes(await fx.remoteHead()), result.stdout);
  });

  test("손댄 다른 파일을 원격 커밋이 바꿨으면 rebase 하지 않고 그 파일 이름을 대며 멈춘다 (autostash 충돌 표식을 남기지 않는다)", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    // 푸시만 빠진 상태 + 원격에 src/note.txt 를 고친 커밋 + 같은 파일을 로컬에서 고치던 중
    await fx.git(["--git-dir", fx.bare, "update-ref", "refs/heads/main", await fx.git(["rev-parse", "HEAD~1"])]);
    await fx.pushFromOtherClone("docs: 메모 수정", (dir) => writeFile(join(dir, "src", "note.txt"), "다른 사람이 고친 내용\n"));
    await writeFile(join(fx.app, "src", "note.txt"), "내가 고치던 내용\n");
    const head = await fx.git(["rev-parse", "HEAD"]);

    // `git rebase --autostash` 는 stash 를 되돌리다 충돌해도 0 으로 끝나므로, 그 전에 멈춰야 한다
    const result = await fx.push();
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes("커밋하지 않은 수정"), result.stderr);
    assert.ok(result.stderr.includes("src/note.txt"), result.stderr);
    assert.ok(!result.stderr.includes("갈라져"), result.stderr);
    assert.equal(await readText(join(fx.app, "src", "note.txt")), "내가 고치던 내용\n", "충돌 표식이 들어가면 안 돼요");
    assert.equal(await fx.localStatus(), "M src/note.txt");
    assert.equal(await fx.git(["stash", "list"]), "", "autostash 가 남으면 안 돼요");
    assert.equal(await fx.git(["rev-parse", "HEAD"]), head, "rebase 하지 않았어야 해요");
    assert.equal((await fx.remoteLog()).length, 2);

    // 같은 상황을 dry-run 도 같은 메시지로 예측한다
    const dry = await fx.push(["--dry-run"]);
    assert.equal(dry.code, 1, dry.stdout);
    assert.ok(dry.stderr.includes("src/note.txt"), dry.stderr);
    assert.equal(await readText(join(fx.app, "src", "note.txt")), "내가 고치던 내용\n");

    // 그 수정을 치우면 다음 실행이 올려 푸시한다(같은 메시지가 영구 정체로 이어지지 않는다)
    await fx.git(["stash", "push", "--quiet", "--", "src/note.txt"]);
    const retried = await fx.push();
    assert.equal(retried.code, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal((await fx.remoteLog()).length, 3);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), await fx.remoteHead());
  });

  test("공백이 든 이름의 파일을 손댔을 때도(git status 가 따옴표로 감싸는 경로) rebase 전에 그 파일 이름을 대며 멈춘다", async () => {
    const fx = await fixture();
    await writeFile(join(fx.app, "src", "my note.txt"), "원본 내용\n");
    await fx.git(["add", "--", "src/my note.txt"]);
    await fx.git(["commit", "--quiet", "-m", "chore: 공백 이름 파일"]);
    await fx.git(["push", "--quiet", "origin", "main"]);
    assert.equal((await fx.push()).code, 0);
    // 푸시만 빠진 상태 + 원격에 그 파일을 고친 커밋 + 같은 파일을 로컬에서 고치던 중
    await fx.git(["--git-dir", fx.bare, "update-ref", "refs/heads/main", await fx.git(["rev-parse", "HEAD~1"])]);
    await fx.pushFromOtherClone("docs: 메모 수정", (dir) => writeFile(join(dir, "src", "my note.txt"), "다른 사람이 고친 내용\n"));
    await writeFile(join(fx.app, "src", "my note.txt"), "내가 고치던 내용\n");
    const head = await fx.git(["rev-parse", "HEAD"]);

    // 줄 단위 `git status` 는 "src/my note.txt" 처럼 따옴표로 감싸고 `git diff --name-only` 는 감싸지 않아, 그 둘을 맞춰 보면 겹침을 놓치고 autostash 충돌까지 간다
    const result = await fx.push();
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes("커밋하지 않은 수정"), result.stderr);
    assert.ok(result.stderr.includes("src/my note.txt"), result.stderr);
    assert.ok(!result.stderr.includes("stash 에 들어 있어요"), `rebase 전에 멈춰야지 autostash 안전망까지 가면 안 돼요:\n${result.stderr}`);
    assert.equal(await readText(join(fx.app, "src", "my note.txt")), "내가 고치던 내용\n", "손대던 내용이 그대로여야 해요");
    assert.equal(await fx.localStatus(), 'M "src/my note.txt"');
    assert.equal(await fx.git(["stash", "list"]), "", "autostash 가 남으면 안 돼요");
    assert.equal(await fx.git(["rev-parse", "HEAD"]), head, "rebase 하지 않았어야 해요");
    assert.equal((await fx.remoteLog()).length, 3);

    const dry = await fx.push(["--dry-run"]);
    assert.equal(dry.code, 1, dry.stdout);
    assert.ok(dry.stderr.includes("src/my note.txt"), dry.stderr);
    assert.equal(await readText(join(fx.app, "src", "my note.txt")), "내가 고치던 내용\n");

    await fx.git(["stash", "push", "--quiet", "--", "src/my note.txt"]);
    const retried = await fx.push();
    assert.equal(retried.code, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal((await fx.remoteLog()).length, 4);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), await fx.remoteHead());
  });

  test("남의 커밋이 섞여 있으면 갈라진 것으로 보고 멈춘다", async () => {
    const fx = await fixture();
    await fx.git(["commit", "--quiet", "--allow-empty", "-m", "feat: 로컬 작업"]);
    await fx.advanceRemote("Merge pull request #3 from other/feature");
    const head = await fx.git(["rev-parse", "HEAD"]);

    const result = await fx.push();
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes("갈라져 있어요"), result.stderr);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), head);
    assert.equal((await fx.remoteLog()).length, 2);
    assert.equal(await exists(join(fx.app, "public", "releases.json")), false);
  });

  test("원격 커밋과 겹치면(같은 파일을 다르게 바꿈) 되돌리고 사람에게 넘긴다", async () => {
    const fx = await fixture();
    assert.equal((await fx.push()).code, 0);
    await fx.git(["--git-dir", fx.bare, "update-ref", "refs/heads/main", await fx.git(["rev-parse", "HEAD~1"])]);
    await fx.pushFromOtherClone("data: 손으로 올린 발행물", async (dir) => {
      await mkdir(join(dir, "public"), { recursive: true });
      await writeFile(join(dir, "public", "releases.json"), "[]\n");
    });
    const head = await fx.git(["rev-parse", "HEAD"]);

    const result = await fx.push();
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stderr.includes("겹쳐서"), result.stderr);
    assert.ok(result.stderr.includes("git pull --rebase origin main"), result.stderr);
    assert.equal(await fx.git(["rev-parse", "HEAD"]), head, "실패한 rebase 는 되돌려야 해요");
    assert.equal(await fx.localStatus(), "", "진행 중인 rebase 가 남으면 안 돼요");
    assert.equal(await exists(join(fx.app, ".git", "rebase-merge")), false);
    assert.equal((await fx.remoteLog()).length, 2);
  });
});

describe("pull-releases", () => {
  test("CLI 는 발행물을 public/ 으로 복사하고 요약을 찍는다", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "trove-pull-"));
    try {
      const root = join(tmp, "app");
      const data = join(tmp, "data");
      await Promise.all([mkdir(root), mkdir(data)]);
      await writeData(data, ITEMS);
      const env = { ...process.env, TROVE_APP_ROOT: root, TROVE_OPS_DATA_DIR: data };

      const result = await sh(process.execPath, [PULL_SCRIPT], { cwd: tmp, env });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes("복사 완료: 3건"), result.stdout);
      assert.ok(result.stdout.includes("카테고리별: music 2 · concert 1"), result.stdout);
      assert.ok(result.stdout.includes("(발행 2026-10-15T15:17:28.580Z)"), result.stdout);
      assert.equal(await readText(join(root, "public", "releases.json")), await readText(join(data, "releases.json")));
      assert.equal(await readText(join(root, "public", "releases.meta.json")), await readText(join(data, "releases.meta.json")));

      await writeData(data, ITEMS, null);
      const noMeta = await sh(process.execPath, [PULL_SCRIPT], { cwd: tmp, env });
      assert.equal(noMeta.code, 0, noMeta.stderr);
      assert.ok(noMeta.stderr.includes("releases.meta.json 이 없거나"), noMeta.stderr);

      await writeFile(join(data, "releases.json"), '{"not":"a list"}');
      const notList = await sh(process.execPath, [PULL_SCRIPT], { cwd: tmp, env });
      assert.equal(notList.code, 1);
      assert.ok(notList.stderr.includes("목록이 아니에요"), notList.stderr);
      assert.ok(notList.stderr.includes("운영 콘솔"), notList.stderr);

      const missing = await sh(process.execPath, [PULL_SCRIPT], { cwd: tmp, env: { ...env, TROVE_OPS_DATA_DIR: join(tmp, "nope") } });
      assert.equal(missing.code, 1);
      assert.ok(missing.stderr.includes("TROVE_OPS_DATA_DIR"), missing.stderr);
      assert.ok(!missing.stderr.includes("    at "), missing.stderr);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("pullReleases 는 검증한 바이트를 그대로 쓴다 (복사하는 사이 운영 콘솔이 다시 써도)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "trove-race-"));
    try {
      const data = join(tmp, "data");
      const target = join(tmp, "public");
      await mkdir(data);
      const short = `${JSON.stringify(ITEMS)}\n`;
      const long = `${JSON.stringify([...ITEMS, ...Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, category: "game", title: "채움 ".repeat(20) }))])}\n`;
      await writeFile(join(data, "releases.json"), short);
      await writeFile(join(data, "releases.meta.json"), `${JSON.stringify(META)}\n`);

      let stop = false;
      const writer = (async () => {
        for (let i = 0; !stop; i += 1) await writeFile(join(data, "releases.json"), i % 2 ? short : long);
      })();
      try {
        let checked = 0;
        for (let i = 0; i < 60; i += 1) {
          let result;
          try {
            result = await pullReleases({ root: tmp, sourceDir: data, targetDir: target });
          } catch {
            continue; // 쓰다 만 파일을 읽었으면 복사하지 않는 게 맞다
          }
          const copied = JSON.parse(await readText(join(target, "releases.json")));
          assert.equal(copied.length, result.count, "public/ 에 쓴 내용은 검증·집계한 바로 그 내용이어야 해요");
          checked += 1;
        }
        assert.ok(checked > 0);
      } finally {
        stop = true;
        await writer;
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("순수 함수", () => {
  test("parseRemote 는 GitHub 주소만 읽는다", () => {
    assert.deepEqual(parseRemote("https://github.com/layerlayer/trove"), { owner: "layerlayer", repo: "trove" });
    assert.deepEqual(parseRemote("https://github.com/layerlayer/trove.git"), { owner: "layerlayer", repo: "trove" });
    assert.deepEqual(parseRemote("https://github.com/layerlayer/trove/"), { owner: "layerlayer", repo: "trove" });
    assert.deepEqual(parseRemote("git@github.com:layerlayer/trove.git"), { owner: "layerlayer", repo: "trove" });
    assert.deepEqual(parseRemote("git@github.com:layerlayer/trove"), { owner: "layerlayer", repo: "trove" });
    assert.deepEqual(parseRemote("ssh://git@github.com/layerlayer/trove.git"), { owner: "layerlayer", repo: "trove" });
    assert.equal(parseRemote("https://gitlab.com/layerlayer/trove.git"), null);
    assert.equal(parseRemote("/tmp/remote.git"), null);
    assert.equal(parseRemote(""), null);
    assert.equal(parseRemote(undefined), null);
  });

  test("isSshRemote / isHttpRemote 는 원격 종류를 알아본다", () => {
    assert.equal(isSshRemote("git@github.com:layerlayer/trove.git"), true);
    assert.equal(isSshRemote("ssh://git@github.com/layerlayer/trove.git"), true);
    assert.equal(isSshRemote("https://github.com/layerlayer/trove.git"), false);
    assert.equal(isSshRemote("/tmp/remote.git"), false);
    assert.equal(isHttpRemote("https://github.com/layerlayer/trove.git"), true);
    assert.equal(isHttpRemote("http://example.com/r.git"), true);
    assert.equal(isHttpRemote("git@github.com:layerlayer/trove.git"), false);
    assert.equal(isHttpRemote("/tmp/remote.git"), false);
  });

  test("buildCommitMessage 는 서울 시각과 건수를 담는다", () => {
    const now = new Date("2026-10-15T15:17:28.580Z"); // 서울은 다음 날 00:17
    assert.equal(
      buildCommitMessage({ count: 16, byCategory: { concert: 5, music: 11 }, now }),
      "data: 발행 반영 2026-10-16 00:17 (16건: music 11 · concert 5)",
    );
    assert.equal(buildCommitMessage({ count: 0, byCategory: {}, now }), "data: 발행 반영 2026-10-16 00:17 (0건)");
    assert.equal(
      buildCommitMessage({ count: 2, byCategory: { music: 1, game: 1 }, now: new Date("2026-01-01T03:04:00Z") }),
      "data: 발행 반영 2026-01-01 12:04 (2건: game 1 · music 1)",
    );
  });

  test("shouldRefuse 는 0건과 급감만 막는다", () => {
    assert.equal(shouldRefuse({ previousCount: 16, nextCount: 16 }), null);
    assert.equal(shouldRefuse({ previousCount: 0, nextCount: 3 }), null);
    assert.equal(shouldRefuse({ previousCount: 16, nextCount: 8 }), null, "정확히 절반은 허용");
    assert.match(shouldRefuse({ previousCount: 16, nextCount: 7 }), /절반.*운영 콘솔.*--allow-shrink/);
    assert.equal(shouldRefuse({ previousCount: 16, nextCount: 7, allowShrink: true }), null);
    assert.match(shouldRefuse({ previousCount: 16, nextCount: 0 }), /0건.*--allow-empty/);
    assert.match(shouldRefuse({ previousCount: 0, nextCount: 0 }), /0건/);
    assert.equal(shouldRefuse({ previousCount: 16, nextCount: 0, allowEmpty: true }), null, "--allow-empty 하나로 충분");
  });

  test("buildPlist 는 XML 을 이스케이프하고 필요한 키를 모두 담는다", () => {
    assert.equal(escapeXml(`a&b<c>"d'`), "a&amp;b&lt;c&gt;&quot;d&apos;");
    assert.equal(unescapeXml(escapeXml(`a&b<c>"d'`)), `a&b<c>"d'`);
    const plist = buildPlist({
      label: "com.trove.data-push",
      programArguments: ["/usr/local/bin/node", "/Users/seo/My <Apps> & Co/trove/scripts/push-releases.mjs", "--quiet"],
      workingDirectory: "/Users/seo/My <Apps> & Co/trove",
      startInterval: 600,
      logPath: "/Users/seo/Library/Logs/trove-data-push.log",
      environment: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/Users/seo", TROVE_OPS_DATA_DIR: "/Users/seo/data & more" },
    });
    assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(plist.includes("<string>/Users/seo/My &lt;Apps&gt; &amp; Co/trove/scripts/push-releases.mjs</string>"));
    assert.ok(plist.includes("<key>StartInterval</key>\n  <integer>600</integer>"));
    assert.ok(plist.includes("<key>RunAtLoad</key>\n  <true/>"));
    assert.ok(plist.includes("<key>TROVE_OPS_DATA_DIR</key>\n    <string>/Users/seo/data &amp; more</string>"));
    assert.ok(!plist.includes("<Apps>"), "이스케이프되지 않은 꺾쇠가 남으면 안 돼요");
    assert.equal(programFromPlist(plist), "/usr/local/bin/node");
    assert.throws(() => buildPlist({ label: "x", programArguments: [], workingDirectory: "/", startInterval: 0, logPath: "/l" }));

    const odd = buildPlist({
      label: "x",
      programArguments: ["/Users/seo/My <Apps> & Co/node", "s.mjs"],
      workingDirectory: "/",
      startInterval: 60,
      logPath: "/l",
    });
    assert.equal(programFromPlist(odd), "/Users/seo/My <Apps> & Co/node", "이스케이프를 되돌려 돌려줘야 해요");
    assert.equal(programFromPlist("<plist/>"), null);
  });

  test("agentEnvironment 는 설치하는 셸의 TROVE_* 변수를 에이전트 환경에 그대로 넣는다", () => {
    const environment = agentEnvironment({
      nodePath: "/opt/homebrew/opt/node/bin/node",
      home: "/Users/seo",
      env: {
        PATH: "/weird/shell/path",
        TROVE_OPS_DATA_DIR: "/Users/seo/data & more",
        TROVE_PUSH_REMOTE: " github ",
        TROVE_PUSH_BRANCH: "   ",
        TROVE_PUSH_INTERVAL: "300",
        TROVE_APP_ROOT: "/Users/seo/elsewhere",
      },
    });
    assert.deepEqual(environment, {
      PATH: "/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/seo",
      TROVE_OPS_DATA_DIR: "/Users/seo/data & more",
      TROVE_PUSH_REMOTE: "github",
    });
    const plist = buildPlist({
      label: "com.trove.data-push",
      programArguments: ["/opt/homebrew/opt/node/bin/node", "/Users/seo/trove/scripts/push-releases.mjs", "--quiet"],
      workingDirectory: "/Users/seo/trove",
      startInterval: 600,
      logPath: "/Users/seo/Library/Logs/trove-data-push.log",
      environment,
    });
    assert.ok(plist.includes("<key>TROVE_PUSH_REMOTE</key>\n    <string>github</string>"), plist);
    assert.ok(!plist.includes("TROVE_PUSH_BRANCH"), "빈 값은 넣지 않아요");
    assert.ok(!plist.includes("TROVE_APP_ROOT"), "에이전트가 읽지 않는 변수는 넣지 않아요");
  });

  test("stableNodePath 는 Homebrew Cellar 경로를 버전과 무관한 opt 경로로 바꾼다", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "trove-brew-")));
    try {
      const keg = join(tmp, "Cellar", "node", "24.1.0", "bin");
      const oldKeg = join(tmp, "Cellar", "node", "22.0.0", "bin");
      const lts = join(tmp, "Cellar", "node@22", "22.9.0", "bin");
      for (const dir of [keg, oldKeg, lts]) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "node"), "");
      }
      await mkdir(join(tmp, "opt"));
      await symlink(join("..", "Cellar", "node", "24.1.0"), join(tmp, "opt", "node"));
      await symlink(join("..", "Cellar", "node@22", "22.9.0"), join(tmp, "opt", "node@22"));

      assert.equal(await stableNodePath(join(keg, "node")), join(tmp, "opt", "node", "bin", "node"));
      assert.equal(await stableNodePath(join(lts, "node")), join(tmp, "opt", "node@22", "bin", "node"));
      assert.equal(await stableNodePath(join(oldKeg, "node")), join(oldKeg, "node"), "opt 링크가 다른 버전을 가리키면 그대로 둔다");
      assert.equal(await stableNodePath("/usr/local/bin/node"), "/usr/local/bin/node");
      assert.equal(await stableNodePath("/Users/seo/.nvm/versions/node/v24.1.0/bin/node"), "/Users/seo/.nvm/versions/node/v24.1.0/bin/node");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("protectedFolderOf 는 ~/Documents·Desktop·Downloads 안만 알아본다", () => {
    assert.equal(protectedFolderOf("/Users/seo/Documents/trove", "/Users/seo"), "/Users/seo/Documents");
    assert.equal(protectedFolderOf("/Users/seo/Desktop/a/b/trove", "/Users/seo"), "/Users/seo/Desktop");
    assert.equal(protectedFolderOf("/Users/seo/Downloads", "/Users/seo"), "/Users/seo/Downloads");
    assert.equal(protectedFolderOf("/Users/seo/Projects/trove", "/Users/seo"), null);
    assert.equal(protectedFolderOf("/Users/seo/Documents-old/trove", "/Users/seo"), null);
    assert.equal(protectedFolderOf("/Users/seo", "/Users/seo"), null);
    assert.equal(protectedFolderOf("/opt/trove", "/Users/seo"), null);
    assert.equal(protectedFolderOf("/Users/other/Documents/trove", "/Users/seo"), null);
  });

  test("parseLaunchctlPrint 는 실행 중 pid 와 마지막 종료 코드를 읽는다 ('(never exited)' 포함)", () => {
    const base = (tail) =>
      [
        "com.trove.data-push = {",
        "\tactive count = 1",
        "\tpath = /Users/seo/Library/LaunchAgents/com.trove.data-push.plist",
        "\ttype = LaunchAgent",
        "\tstate = running",
        "",
        "\tprogram = /opt/homebrew/opt/node/bin/node",
        "\targuments = {",
        "\t\t/opt/homebrew/opt/node/bin/node",
        "\t\t/Users/seo/trove/scripts/push-releases.mjs",
        "\t\t--quiet",
        "\t}",
        ...tail,
        "}",
      ].join("\n");
    assert.deepEqual(parseLaunchctlPrint(base(["\tpid = 48213", "\tlast exit code = (never exited)"])), {
      pid: 48213,
      lastExit: null,
      neverExited: true,
    });
    assert.deepEqual(parseLaunchctlPrint(base(["\tlast exit code = 0"])), { pid: null, lastExit: 0, neverExited: false });
    assert.deepEqual(parseLaunchctlPrint(base(["\tpid = 7", "\tlast exit code = 1"])), { pid: 7, lastExit: 1, neverExited: false });
    assert.deepEqual(parseLaunchctlPrint(base([])), { pid: null, lastExit: null, neverExited: false });
    assert.deepEqual(parseLaunchctlPrint("\tspawn type = daemon (3)\n\tcpid = 99\n"), { pid: null, lastExit: null, neverExited: false });
  });

  test("launchd 등록 스크립트는 macOS 가 아니면 거부한다", { skip: process.platform === "darwin" }, async () => {
    const result = await sh(process.execPath, [AGENT_SCRIPT, "status"], { cwd: tmpdir(), env: process.env });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("macOS"), result.stderr);
  });

  // launchctl 은 PATH 앞의 대용품으로, macOS 는 `--import` 로 process.platform 을 바꿔 흉내 낸다. 진짜 맥에서도 대용품이 앞서므로 같은 답이 나온다.
  test("data:push:status 는 네 가지 상태를 구분한다 (켜짐 / GUI 세션 없음 / plist 만 있고 내려감 / 등록 안 됨)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "trove-agent-"));
    try {
      const bin = join(tmp, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "launchctl"),
        [
          "#!/bin/sh",
          'if [ "$1" = "print" ]; then',
          '  case "$2" in',
          '    */com.trove.data-push) if [ "$JOB_OK" = 1 ]; then printf "x = {\\n\\tpid = 42\\n\\tlast exit code = 0\\n}\\n"; exit 0; fi; exit 113 ;;',
          '    gui/*) if [ "$DOMAIN_OK" = 1 ]; then exit 0; fi; exit 1 ;;',
          "  esac",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const darwin = join(tmp, "darwin.mjs");
      await writeFile(darwin, 'Object.defineProperty(process, "platform", { value: "darwin" });\n');
      const home = join(tmp, "home");
      const appRoot = join(tmp, "app");
      await mkdir(appRoot);
      const plistPath = join(home, "Library", "LaunchAgents", "com.trove.data-push.plist");
      const status = async ({ plist, jobOk, domainOk }) => {
        await rm(home, { recursive: true, force: true });
        await mkdir(dirname(plistPath), { recursive: true });
        if (plist) {
          await writeFile(
            plistPath,
            buildPlist({
              label: "com.trove.data-push",
              programArguments: [process.execPath, join(appRoot, "scripts", "push-releases.mjs"), "--quiet"],
              workingDirectory: appRoot,
              startInterval: 600,
              logPath: join(home, "Library", "Logs", "trove-data-push.log"),
              environment: {},
            }),
          );
        }
        const result = await sh(process.execPath, ["--import", darwin, AGENT_SCRIPT, "status"], {
          cwd: tmp,
          env: {
            ...process.env,
            HOME: home,
            TROVE_APP_ROOT: appRoot,
            PATH: `${bin}:${process.env.PATH}`,
            JOB_OK: jobOk ? "1" : "0",
            DOMAIN_OK: domainOk ? "1" : "0",
          },
        });
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        return result.stdout;
      };

      const loaded = await status({ plist: true, jobOk: true, domainOk: true });
      assert.ok(loaded.includes("설정 파일: 있음"), loaded);
      assert.ok(loaded.includes("launchd 등록: 켜져 있음"), loaded);
      assert.ok(loaded.includes("지금 실행 중 (pid 42)"), loaded);
      assert.ok(loaded.includes("마지막 실행 종료 코드: 0 (정상)"), loaded);
      assert.ok(!loaded.includes("data:push:install"), `켜져 있으면 다시 켜라고 하면 안 돼요:\n${loaded}`);

      const noGui = await status({ plist: true, jobOk: false, domainOk: false });
      assert.ok(noGui.includes("launchd 등록: 없음"), noGui);
      assert.ok(noGui.includes("로그인한 세션이 없어"), noGui);
      assert.ok(!noGui.includes("data:push:install"), `GUI 세션이 없을 때 install 을 권하면 또 같은 이유로 멈춰요:\n${noGui}`);

      const unloaded = await status({ plist: true, jobOk: false, domainOk: true });
      assert.ok(unloaded.includes("launchd 등록: 없음"), unloaded);
      assert.ok(unloaded.includes("올라와 있지 않아요"), unloaded);
      assert.ok(unloaded.includes("npm run data:push:install"), `plist 만 남고 내려간 경우에는 다시 켜는 법을 알려 줘야 해요:\n${unloaded}`);
      assert.ok(!unloaded.includes("로그인한 세션이 없어"), unloaded);

      const none = await status({ plist: false, jobOk: false, domainOk: true });
      assert.ok(none.includes("설정 파일: 없음"), none);
      assert.ok(none.includes("등록하려면: npm run data:push:install"), none);
      assert.ok(!none.includes("올라와 있지"), none);
      assert.ok(!none.includes("로그인한 세션이 없어"), none);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

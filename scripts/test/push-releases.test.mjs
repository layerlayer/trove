/**
 * scripts/push-releases.mjs · scripts/pull-releases.mjs · scripts/lib 의 테스트. 네트워크 없이 돈다.
 * 임시 폴더에 bare 원격 + 작업 저장소 + 가짜 발행물 폴더를 만들고, 스크립트를 실제 경로에서
 * TROVE_APP_ROOT=<작업 저장소> 로 실행한다(스크립트는 자기 위치가 아니라 그 폴더를 앱 루트로 본다).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildPlist, escapeXml } from "../lib/launchd.mjs";
import { buildCommitMessage, isSshRemote, parseRemote, shouldRefuse } from "../lib/releases.mjs";

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
  return {
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
    remoteFile: (path) => git(["--git-dir", bare, "show", `main:${path}`]),
    remoteCommitFiles: async (ref = "main") =>
      (await git(["--git-dir", bare, "diff-tree", "--no-commit-id", "--name-only", "-r", ref]))
        .split("\n")
        .filter(Boolean)
        .sort(),
    localStatus: () => git(["status", "--porcelain", "--untracked-files=all"]),
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
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

  test("(3) 발행물이 바뀌면 건수를 담은 두 번째 커밋을 만든다", async () => {
    const more = [...ITEMS, { id: "g1", category: "game" }, { id: "c2", category: "concert" }];
    await writeData(fx.data, more, { ...META, count: more.length });
    const result = await fx.push();
    assert.equal(result.code, 0, result.stderr);
    const log = await fx.remoteLog();
    assert.equal(log.length, 3);
    assert.ok(log[0].includes("(5건: concert 2 · music 2 · game 1)"), log[0]);
    assert.ok(result.stdout.includes("5건"), result.stdout);
  });

  test("(3b) 절반 넘게 줄면 거부하고 --allow-shrink 로 넘어간다", async () => {
    const before = await readText(join(fx.app, "public", "releases.json"));
    await writeData(fx.data, ITEMS.slice(0, 2), { ...META, count: 2 });

    const refused = await fx.push();
    assert.equal(refused.code, 1);
    assert.ok(refused.stderr.includes("5건에서 2건"), refused.stderr);
    assert.ok(refused.stderr.includes("--allow-shrink"), refused.stderr);
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

  test("(5) main 이 아닌 브랜치에서는 거부하고 아무것도 바꾸지 않는다", async () => {
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

  test("(6) --dry-run 은 원격도 로컬도 바꾸지 않는다", async () => {
    const fx = await fixture();
    const result = await fx.push(["--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes("[dry-run]"), result.stdout);
    assert.ok(result.stdout.includes("data: 발행 반영"), result.stdout);
    assert.ok(result.stdout.includes("public/releases.json"), result.stdout);
    assert.equal((await fx.remoteLog()).length, 1);
    assert.equal((await fx.git(["log", "--format=%s"])).split("\n").length, 1);
    assert.equal(await fx.localStatus(), "");
    assert.equal(await exists(join(fx.app, "public", "releases.json")), false);
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

  test("잠금: 진행 중인 잠금은 거부하고, 30분 넘은 잠금은 치운다", async () => {
    const fx = await fixture();
    const lockPath = join(fx.app, ".git", "trove-data-push.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 4242, time: new Date().toISOString() }));
    const busy = await fx.push();
    assert.equal(busy.code, 1);
    assert.ok(busy.stderr.includes("진행 중"), busy.stderr);
    assert.ok(busy.stderr.includes("4242"), busy.stderr);
    assert.equal((await fx.remoteLog()).length, 1);
    assert.equal(await exists(lockPath), true, "남의 잠금은 지우지 않아요");

    await writeFile(lockPath, JSON.stringify({ pid: 4242, time: new Date(Date.now() - 40 * 60 * 1000).toISOString() }));
    const stale = await fx.push();
    assert.equal(stale.code, 0, stale.stderr);
    assert.equal((await fx.remoteLog()).length, 2);
    assert.equal(await exists(lockPath), false);
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

  test("푸시 직전에 원격이 앞서 나가면(non-fast-forward) 받아와 올린 뒤 다시 푸시한다", async () => {
    const fx = await fixture();
    // 첫 푸시 때만 원격 main 에 다른 커밋을 끼워 넣고 거절하는 pre-receive 훅으로 "동시 푸시" 를 흉내 낸다.
    // 거절 뒤 재시도에서 non-fast-forward 가 나고, 스크립트가 받아와 rebase 한 뒤 푸시해야 한다.
    const hook = [
      "#!/bin/sh",
      'marker="$GIT_DIR/hook-fired"',
      'if [ ! -f "$marker" ]; then',
      '  touch "$marker"',
      '  export GIT_AUTHOR_NAME=Other GIT_AUTHOR_EMAIL=other@example.com GIT_COMMITTER_NAME=Other GIT_COMMITTER_EMAIL=other@example.com',
      "  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES # 훅 격리 밖에서 실제 ref 를 움직인다",
      '  tree=$(git rev-parse "refs/heads/main^{tree}")',
      '  commit=$(echo "feat: 다른 사람 작업" | git commit-tree "$tree" -p refs/heads/main)',
      '  git update-ref refs/heads/main "$commit"',
      '  echo "simulated concurrent push" >&2',
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n");
    await mkdir(join(fx.bare, "hooks"), { recursive: true });
    await writeFile(join(fx.bare, "hooks", "pre-receive"), hook, { mode: 0o755 });

    const result = await fx.push();
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes("1/3"), result.stderr);
    assert.ok(result.stdout.includes("먼저 받아온 뒤 다시 푸시"), result.stdout);
    const log = await fx.remoteLog();
    assert.equal(log.length, 3, log.join("\n"));
    assert.ok(log[0].startsWith("data: 발행 반영"), log[0]);
    assert.equal(log[1], "feat: 다른 사람 작업");
    assert.equal(await fx.localStatus(), "");
    assert.equal(await fx.git(["rev-parse", "HEAD"]), await fx.git(["--git-dir", fx.bare, "rev-parse", "main"]));
  });
});

describe("pull-releases CLI", () => {
  test("발행물을 public/ 으로 복사하고 요약을 찍는다", async () => {
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

  test("isSshRemote 는 git@ 와 ssh:// 를 알아본다", () => {
    assert.equal(isSshRemote("git@github.com:layerlayer/trove.git"), true);
    assert.equal(isSshRemote("ssh://git@github.com/layerlayer/trove.git"), true);
    assert.equal(isSshRemote("https://github.com/layerlayer/trove.git"), false);
    assert.equal(isSshRemote("/tmp/remote.git"), false);
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
    assert.match(shouldRefuse({ previousCount: 16, nextCount: 7 }), /절반.*--allow-shrink/);
    assert.equal(shouldRefuse({ previousCount: 16, nextCount: 7, allowShrink: true }), null);
    assert.match(shouldRefuse({ previousCount: 16, nextCount: 0 }), /0건.*--allow-empty/);
    assert.match(shouldRefuse({ previousCount: 0, nextCount: 0 }), /0건/);
    assert.equal(shouldRefuse({ previousCount: 16, nextCount: 0, allowEmpty: true }), null, "--allow-empty 하나로 충분");
  });

  test("buildPlist 는 XML 을 이스케이프하고 필요한 키를 모두 담는다", () => {
    assert.equal(escapeXml(`a&b<c>"d'`), "a&amp;b&lt;c&gt;&quot;d&apos;");
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
    assert.throws(() => buildPlist({ label: "x", programArguments: [], workingDirectory: "/", startInterval: 0, logPath: "/l" }));
  });

  test("launchd 등록 스크립트는 macOS 가 아니면 거부한다", { skip: process.platform === "darwin" }, async () => {
    const result = await sh(process.execPath, [AGENT_SCRIPT, "status"], { cwd: tmpdir(), env: process.env });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("macOS"), result.stderr);
  });
});

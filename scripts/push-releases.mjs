#!/usr/bin/env node
/**
 * 운영 콘솔 발행물을 public/ 에 반영하고, 그 두 파일만 커밋해 원격으로 푸시한다.
 * Vercel 이 main 을 자동 배포하므로 "콘솔에서 발행 → 배포" 가 사람 손 없이 이어진다.
 *
 *   npm run data:push                    # 한 번 실행
 *   npm run data:push -- --dry-run       # 무엇을 할지만 보여 준다. 커밋·푸시는 물론 로컬 브랜치·파일도 바꾸지 않는다(원격 상태만 읽어 온다)
 *   npm run data:push -- --wait          # 푸시 뒤 GitHub 공개 배포 API 로 Vercel 배포 상태를 최대 5분 기다린다
 *   npm run data:push -- --allow-empty   # 0건 발행도 반영한다
 *   npm run data:push -- --allow-shrink  # 건수가 절반 넘게 줄어도 반영한다
 *   npm run data:push -- --quiet         # 변경이 없을 때 한 줄만 찍는다. 그 외에는 시각 줄을 먼저 찍는다(launchd 주기 실행용)
 *
 * 환경 변수
 *   TROVE_OPS_DATA_DIR  발행물 폴더 (기본 <앱 폴더>/trove-ops/data)
 *   TROVE_PUSH_BRANCH   반영할 브랜치 (기본 main). 지금 체크아웃된 브랜치가 다르면 아무것도 하지 않는다
 *   TROVE_PUSH_REMOTE   푸시할 원격 (기본 origin)
 *   TROVE_APP_ROOT      앱 폴더를 강제로 지정 (테스트용. git 저장소의 루트여야 한다. 기본은 이 스크립트가 들어 있는 앱 폴더)
 *
 * 모든 경로는 앱 폴더 기준이라 launchd 의 WorkingDirectory 와 무관하게 동작한다.
 * 종료 코드: 0 = 반영했거나 변경 없음(--quiet 에서 다른 실행이 진행 중이라 건너뛴 경우 포함),
 *            1 = 무엇이든 막혀서 멈춤(이유를 한국어로 찍는다).
 */
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { access, open, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  appRoot,
  buildCommitMessage,
  formatPullSummary,
  formatSeoulTime,
  opsDataDir,
  parseRemote,
  pullReleases,
  shouldRefuse,
} from "./lib/releases.mjs";

const execFileAsync = promisify(execFile);

const DATA_PATHS = ["public/releases.json", "public/releases.meta.json"];
const COMMIT_PREFIX = "data: 발행 반영";
/** 이 스크립트가 만든 발행 커밋인지(제목 접두어로 판단). */
const isReleaseCommit = (commitInfo) => commitInfo.subject.startsWith(COMMIT_PREFIX);
const LOCK_STALE_MS = 30 * 60 * 1000;
const PUSH_BACKOFF_MS = [2000, 4000];
/** 원격이 앞서 있어 거절된 푸시: 받아와 그 위에 올리면 된다. */
const PUSH_BEHIND_RE = /non-fast-forward|fetch first/i;
/** git 이 로그인 정보를 찾지 못했거나(프롬프트 꺼짐) 로그인이 거절된 경우. 다시 시도해도 소용없다. */
const PUSH_AUTH_RE =
  /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)|returned error: 401/i;
/** 권한·브랜치 보호·훅 거절처럼 다시 시도해도 같은 결과인 거절. `returned error: 403` 은 해시에 섞인 403 과 구분하려고 앞말까지 본다. */
const PUSH_PERMANENT_RE = /Permission denied|hook declined|returned error: 403|protected branch/i;
const WAIT_TOTAL_MS = 5 * 60 * 1000;
const WAIT_INTERVAL_MS = 20 * 1000;
/** 기다려도 풀리지 않는 GitHub API 응답: 403/429 = 인증 없는 공개 API 한도(IP 당 시간당 60회), 404 = 비공개 저장소. */
const WAIT_GIVE_UP_STATUSES = [403, 404, 429];

/** 사람에게 보여 줄 이유를 담아 멈춘다(종료 코드 1). */
class Stop extends Error {}
/** --quiet(launchd) 에서 이번 실행만 건너뛴다(종료 코드 0, 한 줄만 남긴다). 다음 주기에 다시 돈다. */
class Skip extends Error {}
/** 응답이 2xx 가 아닐 때 상태 코드를 들고 던진다(waitForDeployment 가 영구 실패를 구분하는 데 쓴다). */
class HttpError extends Error {
  constructor(url, status) {
    super(`${url} 응답이 ${status} 이에요.`);
    this.status = status;
  }
}

// ---------- 옵션 ----------
const FLAGS = {
  "--dry-run": "dryRun",
  "--wait": "wait",
  "--allow-empty": "allowEmpty",
  "--allow-shrink": "allowShrink",
  "--quiet": "quiet",
};
const options = { dryRun: false, wait: false, allowEmpty: false, allowShrink: false, quiet: false };
for (const argument of process.argv.slice(2)) {
  const key = FLAGS[argument];
  if (!key) {
    console.error(`알 수 없는 옵션이에요: ${argument}\n쓸 수 있는 옵션: ${Object.keys(FLAGS).join(" ")}`);
    process.exit(1);
  }
  options[key] = true;
}

const root = appRoot();
const remote = process.env.TROVE_PUSH_REMOTE?.trim() || "origin";
const branch = process.env.TROVE_PUSH_BRANCH?.trim() || "main";
const publicDir = resolve(root, "public");

// ---------- 출력 ----------
// --quiet 에서는 "변경 없음" 으로 끝날 때 한 줄만 남기도록, 결론이 나기 전까지 출력을 모아 둔다.
const pending = [];
let buffering = options.quiet;
function say(line) {
  if (buffering) pending.push(["log", line]);
  else console.log(line);
}
function warn(line) {
  if (buffering) pending.push(["warn", line]);
  else console.warn(line);
}
/** 모아 둔 출력을 내보낸다. --quiet 에서만 의미가 있고, 그때는 어느 실행의 출력인지 알 수 있게 시각 줄을 먼저 찍는다(launchd 로그는 계속 덧붙여진다). */
function flush() {
  if (!buffering) return;
  buffering = false;
  console.log(`[${formatSeoulTime()}]`);
  for (const [level, line] of pending) (level === "warn" ? console.warn : console.log)(line);
  pending.length = 0;
}

// ---------- 잠금 ----------
let lockPath = null;
let lockHeld = false;

function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // 이미 지워졌다면 그만
  }
}

process.on("exit", releaseLock);
// 터미널이 닫혀 SIGHUP 을 받을 때도 잠금을 풀어야 한다. 기본 동작으로 죽으면 'exit' 이 돌지 않는다.
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };
for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    releaseLock();
    process.exit(code);
  });
}

/**
 * 잠금에 적힌 pid 의 상태. "dead" = 확실히 끝남(ESRCH), "alive" = 신호를 보낼 수 있는 살아 있는 프로세스,
 * "unknown" = pid 가 없거나 권한이 없어(EPERM) 알 수 없음. pid 0·음수는 프로세스 그룹을 뜻하므로 보지 않는다.
 */
function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (cause) {
    return cause?.code === "ESRCH" ? "dead" : "unknown";
  }
}

async function acquireLock(gitDir) {
  lockPath = resolve(gitDir, "trove-data-push.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, time: new Date().toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      lockHeld = true;
      return;
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
    }

    // 누가 들고 있는 잠금이다. 그 pid 가 이미 끝났으면(강제 종료·재부팅·터미널 닫힘) 치우고, pid 를 알 수 없으면 30분 넘게 묵은 것만 죽은 실행이 남긴 것으로 보고 치운다.
    // 살아 있는 실행의 잠금은 오래됐어도 치우지 않는다 — 치우면 두 실행이 같은 저장소를 동시에 만지고, 먼저 돌던 실행이 끝날 때 새 잠금까지 지운다.
    let info = {};
    try {
      info = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      // 내용이 깨졌으면 파일 시각으로 판단
    }
    const state = pidState(info?.pid);
    if (state === "dead") {
      warn(`끝난 실행(pid ${info.pid})이 남긴 잠금을 치웠어요: ${lockPath}`);
      await rm(lockPath, { force: true });
      continue;
    }
    let startedAt = Date.parse(info?.time ?? "");
    if (Number.isNaN(startedAt)) {
      try {
        startedAt = (await stat(lockPath)).mtimeMs;
      } catch (cause) {
        if (cause?.code === "ENOENT") continue; // 그 사이 풀렸다 — 다시 시도
        throw cause;
      }
    }
    const stale = Date.now() - startedAt >= LOCK_STALE_MS;
    if (stale && state !== "alive") {
      warn(`30분 넘게 남아 있던 잠금을 치웠어요: ${lockPath}`);
      await rm(lockPath, { force: true });
      continue;
    }
    const holder = `pid ${info?.pid ?? "?"}, ${formatSeoulTime(new Date(startedAt))} 시작${stale ? ", 30분 넘게 진행 중" : ""}`;
    // 주기 실행은 다음 주기에 다시 돌므로(예: 사람이 돌린 --wait 가 끝나길 기다리는 중) 실패로 치지 않는다.
    if (options.quiet) throw new Skip(`다른 발행 반영이 진행 중이라 건너뛰어요 (${holder}) (${formatSeoulTime()})`);
    throw new Stop(
      `다른 발행 반영이 진행 중이에요 (${holder}). 끝나길 기다렸다가 다시 실행해 주세요.\n` +
        `멈춘 게 확실하면 잠금 파일을 지우면 돼요: ${lockPath}`,
    );
  }
  throw new Stop(`잠금 파일을 만들지 못했어요: ${lockPath}`);
}

// ---------- 명령 실행 ----------
// 터미널이 아닐 때(launchd, 테스트)는 git 이 비밀번호를 물으며 멈추지 않고 바로 실패하게 한다.
const childEnv = process.stdin.isTTY ? process.env : { ...process.env, GIT_TERMINAL_PROMPT: "0" };

async function run(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: root,
      env: childEnv,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      throw new Stop(`${command} 명령을 찾지 못했어요. PATH 에 ${command} 이 있는지 확인해 주세요.`);
    }
    return {
      ok: false,
      stdout: typeof cause?.stdout === "string" ? cause.stdout : "",
      stderr: typeof cause?.stderr === "string" && cause.stderr ? cause.stderr : String(cause?.message ?? cause),
    };
  }
}

async function git(args, failMessage) {
  const result = await run("git", args);
  if (!result.ok) throw new Stop(`${failMessage}\n$ git ${args.join(" ")}\n${result.stderr.trim()}`);
  return result.stdout.trim();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------- 단계 ----------
async function preflight() {
  // 앱 폴더가 없으면 git 을 띄우는 단계에서 ENOENT 가 나서 run() 이 "git 명령을 찾지 못했어요" 로 잘못 안내한다. 먼저 폴더부터 확인한다.
  try {
    await stat(root);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
    throw new Stop(`앱 폴더가 없어요: ${root} (TROVE_APP_ROOT 를 확인해 주세요)`);
  }
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new Stop(`앱 폴더가 git 저장소가 아니에요: ${root}`);
  }
  // git status --porcelain 은 늘 저장소 루트 기준 경로를 찍는데 모든 git 명령은 cwd=root 로 돈다.
  // 앱 폴더가 저장소의 하위 폴더면(TROVE_APP_ROOT) 그 경로로 add/checkout 이 전부 어긋나니 미리 멈춘다.
  // --show-toplevel 은 심볼릭 링크를 푼 실제 경로라 root 도 같은 식으로 맞춰 비교한다.
  const toplevel = await git(["rev-parse", "--show-toplevel"], "저장소 루트를 찾지 못했어요.");
  if ((await realpath(root)) !== toplevel) {
    throw new Stop(
      `앱 폴더(${root})가 git 저장소의 루트(${toplevel})가 아니에요. 발행 반영은 앱 폴더가 저장소 루트일 때만 해요. 아무것도 바꾸지 않았어요.`,
    );
  }
  // 보통은 <root>/.git 이다. 워크트리처럼 .git 이 파일인 경우도 실제 폴더를 찾아 잠금을 둔다.
  const gitDir = resolve(root, await git(["rev-parse", "--git-dir"], "git 폴더를 찾지 못했어요."));

  const name = (await run("git", ["config", "--get", "user.name"])).stdout.trim();
  const email = (await run("git", ["config", "--get", "user.email"])).stdout.trim();
  if (!name || !email) {
    throw new Stop(
      "git 사용자 이름과 이메일이 없어서 커밋을 만들 수 없어요. 한 번만 설정해 주세요:\n" +
        '  git config --global user.name "이름"\n' +
        '  git config --global user.email "메일 주소"',
    );
  }

  const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], "현재 브랜치를 알 수 없어요.");
  if (current !== branch) {
    const where = current === "HEAD" ? "특정 커밋(detached HEAD)" : `'${current}' 브랜치`;
    throw new Stop(
      `지금 앱 폴더(${root})는 ${where}에 있어요. 발행 반영은 '${branch}' 브랜치에서만 해요. 아무것도 바꾸지 않았어요.\n` +
        `  git switch ${branch}   # 로 옮긴 뒤 다시 실행해 주세요`,
    );
  }

  await acquireLock(gitDir);
}

/** main() 이 발행 파일 두 개를 HEAD 상태로 되돌렸는지. 그 뒤에 멈추는 메시지는 "아무것도 바꾸지 않았어요" 라고 할 수 없다. */
let restoredStale = false;
const untouched = () =>
  restoredStale ? "발행 파일 두 개를 HEAD 상태로 되돌린 것 외에는 바꾸지 않았어요." : "아무것도 바꾸지 않았어요.";

function divergedStop(detail = "") {
  return new Stop(
    `로컬 '${branch}' 브랜치가 원격과 갈라져 있어요(원격에 없는 커밋이 있거나 충돌). 사람이 직접 확인해야 해요. ${untouched()}\n` +
      `  git status\n  git log --oneline ${remote}/${branch}..HEAD${detail ? `\n${detail}` : ""}`,
  );
}

/** 커밋하지 않은 로컬 수정(또는 추적 안 된 파일)을 원격의 새 커밋이 같은 파일에서 건드려 자동으로 맞출 수 없을 때. */
function uncommittedOverlapStop(files, detail = "") {
  return new Stop(
    `앱 폴더에 아직 커밋하지 않은 수정이 있고(${files.join(", ") || "git status 참고"}), 원격의 새 커밋이 같은 파일을 바꿔서 자동으로 맞출 수 없어요. ` +
      `${untouched()} 그 수정을 커밋하거나 치운(git stash) 뒤 다시 실행해 주세요.\n` +
      `  git status${detail ? `\n${detail}` : ""}`,
  );
}

/** a 가 b 의 조상(또는 같은 커밋)인지. 읽기만 한다. */
async function isAncestor(a, b) {
  return (await run("git", ["merge-base", "--is-ancestor", a, b])).ok;
}

/**
 * 변경·건수를 비교할 기준 커밋. 보통 HEAD.
 * dry-run 이 fast-forward 를 건너뛰었을 때만 FETCH_HEAD — 실제 실행이라면 그 커밋이 HEAD 가 돼 있을 테니, 예측도 거기 맞춰야 실제 실행과 같은 답이 나온다.
 */
let baseRef = "HEAD";

/**
 * git pull --ff-only 와 같다. 로컬이 갈라져 있으면 사람이 봐야 하므로 멈춘다.
 * 단, 지난 실행이 커밋만 하고 푸시하지 못한 발행 커밋 뒤로 원격이 앞서 나간 경우는 그 커밋들을 원격 위로 올린다.
 * dry-run 에서는 로컬 브랜치를 움직이지 않고 같은 판단만 해서 알려 준다.
 */
async function syncWithRemote() {
  const fetched = await run("git", ["fetch", "--quiet", remote, branch]);
  if (!fetched.ok) {
    throw new Stop(
      `원격 '${remote}' 의 '${branch}' 브랜치를 받아오지 못했어요. 네트워크나 git 로그인 상태를 확인해 주세요.\n${fetched.stderr.trim()}`,
    );
  }
  // 이미 최신이거나 로컬만 앞서 있으면 움직일 게 없다(앞선 커밋이 누구 것인지는 main() 이 가린다).
  if (await isAncestor("FETCH_HEAD", "HEAD")) return;

  const canFastForward = await isAncestor("HEAD", "FETCH_HEAD");
  if (options.dryRun) {
    if (canFastForward) {
      say(`[dry-run] 원격에 새 커밋이 있어요. 실제 실행이라면 로컬 '${branch}' 을 ${remote}/${branch} 으로 fast-forward 하지만, 지금은 움직이지 않았어요.`);
      await stopIfUncommittedOverlap(); // 실제 실행이라면 git 이 ff 를 거절했을 상황을 같은 메시지로 미리 알린다
      baseRef = "FETCH_HEAD"; // 아래 예측(변경·건수)은 fast-forward 된 뒤 기준으로 한다
      return;
    }
    const ahead = await unpushedCommits();
    if (ahead.length && ahead.every(isReleaseCommit)) {
      say(`[dry-run] 지난 실행이 푸시하지 못한 발행 커밋 ${ahead.length}개 뒤로 원격이 앞서 있어요. 실제 실행이라면 원격 위로 올리지만, 지금은 움직이지 않았어요.`);
      await stopIfUncommittedOverlap();
      return;
    }
    throw divergedStop();
  }

  if (canFastForward) {
    const merged = await run("git", ["merge", "--ff-only", "--quiet", "FETCH_HEAD"]);
    if (merged.ok) return;
    const stderr = merged.stderr.trim();
    // 갈라진 게 아니라, 커밋하지 않은 로컬 수정(또는 추적 안 된 파일)을 원격의 새 커밋이 덮어쓰게 되는 경우.
    // 발행 파일 두 개는 main() 이 미리 되돌리므로 여기 걸리는 것은 사람이 손댄 다른 파일이다.
    if (/would be overwritten by merge/i.test(stderr)) {
      const files = stderr
        .split("\n")
        .filter((line) => line.startsWith("\t"))
        .map((line) => line.trim());
      throw uncommittedOverlapStop(files, stderr);
    }
    throw divergedStop(stderr);
  }

  const ahead = await unpushedCommits();
  if (ahead.length && ahead.every(isReleaseCommit)) {
    say(`지난 실행이 푸시하지 못한 발행 커밋 ${ahead.length}개 뒤로 원격이 앞서 나가서, 받아온 원격 위로 올려요.`);
    await rebaseOntoFetched();
    return;
  }
  throw divergedStop();
}

/** 원격에 아직 없는 로컬 커밋들(최신 순). syncWithRemote() 가 받아 둔 FETCH_HEAD 기준. */
async function unpushedCommits() {
  const out = await git(["log", "--format=%H%x09%s", "FETCH_HEAD..HEAD"], "푸시되지 않은 커밋을 확인하지 못했어요.");
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [sha, ...rest] = line.split("\t");
    return { sha, subject: rest.join("\t") };
  });
}

/**
 * 기준 커밋(baseRef, 보통 HEAD)에 커밋된 발행 건수(= 지금 배포돼 있거나 곧 푸시될 것). 작업 폴더의 파일은 `npm run data:pull` 이나
 * 중간에 죽은 실행이 이미 덮어썼을 수 있어 급감 판단의 기준으로 쓰지 않는다. 커밋된 적이 없으면 0.
 */
async function committedCount() {
  const shown = await run("git", ["show", `${baseRef}:./${DATA_PATHS[0]}`]);
  if (!shown.ok) return 0;
  try {
    const items = JSON.parse(shown.stdout);
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 커밋하지 않은 변경(추적 안 된 파일 포함). pathspec 을 주면 그 파일들만. [{ status: "??" | " M" | "A " | ..., path }] */
async function changedPaths(pathspec = []) {
  // 첫 글자가 공백일 수 있어(" M path") git() 처럼 trim 하지 않고 줄 단위로 읽는다.
  const result = await run("git", ["status", "--porcelain", "--untracked-files=all", "--", ...pathspec]);
  if (!result.ok) throw new Stop(`변경 사항을 확인하지 못했어요.\n${result.stderr.trim()}`);
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

/** 두 발행 파일 중 실제로 달라진 것만(HEAD/index 기준). */
const changedDataPaths = () => changedPaths(DATA_PATHS);

/**
 * dry-run 이 fast-forward 를 건너뛴 경우: 복사한 발행 파일을 HEAD 가 아니라 원격 커밋(ref)과 비교한다.
 * 실제 실행이라면 fast-forward 뒤의 작업 폴더가 그 커밋과 같았을 테니, pullReleases 가 쓴 파일(written)만 다를 수 있다.
 * git status 는 index/HEAD 기준이라 쓸 수 없고, `git diff <ref>` 도 index 에 없는(추적 안 된) 파일은 보지 않아 blob 해시로 비교한다.
 * 읽기만 한다(`hash-object` 는 -w 없이는 아무것도 쓰지 않는다).
 */
async function changedDataPathsAgainst(ref, written) {
  const changes = [];
  for (const path of written) {
    const inRef = await run("git", ["rev-parse", "--verify", "--quiet", `${ref}:./${path}`]);
    const inTree = await git(["hash-object", "--", path], "발행 파일의 해시를 구하지 못했어요.");
    if (inRef.ok && inRef.stdout.trim() === inTree) continue;
    changes.push({ status: inRef.ok ? " M" : "??", path });
  }
  return changes;
}

/**
 * 커밋하지 않은 변경 가운데 받아 둔 FETCH_HEAD 의 새 커밋이 건드리는 파일.
 * 발행 파일 두 개는 보지 않는다 — main() 이 미리 되돌리므로(dry-run 은 그대로 두지만 실제 실행이라면 되돌렸을 것이므로) 여기 걸리는 것은 사람이 손댄 다른 파일이다.
 */
async function uncommittedOverlap() {
  const dirty = (await changedPaths()).map((change) => change.path).filter((path) => !DATA_PATHS.includes(path));
  if (!dirty.length) return [];
  const incoming = new Set(
    (await git(["diff", "--name-only", "HEAD...FETCH_HEAD"], "원격의 새 커밋이 바꾼 파일을 확인하지 못했어요.")).split("\n"),
  );
  return dirty.filter((path) => incoming.has(path));
}

/** 커밋하지 않은 수정이 원격의 새 커밋과 같은 파일이면 손대기 전에 멈춘다(ff-only 병합에서 git 이 거절하는 것과 같은 기준). */
async function stopIfUncommittedOverlap() {
  const overlap = await uncommittedOverlap();
  if (overlap.length) throw uncommittedOverlapStop(overlap);
}

/** 이 스크립트가 만든 public/ 이면(비어 있으면) 지운다. */
async function removePublicDirIfEmpty() {
  try {
    await rmdir(publicDir);
  } catch {
    // 비어 있지 않거나 없으면 그대로 둔다
  }
}

/**
 * 발행 파일을 HEAD 상태로 되돌린다: HEAD 에 있는 파일은 스테이징을 풀고 HEAD 내용으로, 새로 생긴 파일(추적 안 됨·새로 add 됨)은 지운다.
 * 두 발행 파일 외에는 손대지 않는다.
 */
async function restore(changes, publicExisted) {
  const tracked = changes.filter((change) => change.status !== "??");
  const staged = tracked.filter((change) => change.status[0] !== " ").map((change) => change.path);
  if (staged.length) await git(["reset", "--quiet", "--", ...staged], "발행 파일의 스테이징을 풀지 못했어요.");
  const inHead = tracked.filter((change) => change.status[0] !== "A").map((change) => change.path);
  const created = changes.filter((change) => change.status === "??" || change.status[0] === "A").map((change) => change.path);
  if (inHead.length) await git(["checkout", "--", ...inHead], "파일을 원래대로 되돌리지 못했어요.");
  for (const path of created) await rm(resolve(root, path), { force: true });
  if (!publicExisted) await removePublicDirIfEmpty();
}

/** dry-run 용: 두 발행 파일의 지금 바이트(없으면 null)를 기억해 둔다. */
async function snapshotDataFiles() {
  const snapshot = new Map();
  for (const path of DATA_PATHS) {
    try {
      snapshot.set(path, await readFile(resolve(root, path)));
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
      snapshot.set(path, null);
    }
  }
  return snapshot;
}

/** dry-run 용: 기억해 둔 바이트 그대로 되돌리고, 이 실행이 만든 public/ 이면 지운다. */
async function restoreSnapshot(snapshot, publicExisted) {
  for (const [path, bytes] of snapshot) {
    const absolute = resolve(root, path);
    if (bytes === null) await rm(absolute, { force: true });
    else await writeFile(absolute, bytes);
  }
  if (!publicExisted) await removePublicDirIfEmpty();
}

/** 두 파일만 커밋한다. 다른 스테이징·수정 사항은 그대로 남는다. */
async function commit(changes, message) {
  const paths = changes.map((change) => change.path);
  await git(["add", "--", ...paths], "발행 파일을 스테이징하지 못했어요.");
  await git(["commit", "--quiet", "-m", message, "--", ...paths], "커밋을 만들지 못했어요.");
  return git(["rev-parse", "HEAD"], "커밋 해시를 읽지 못했어요.");
}

/**
 * 받아 둔 FETCH_HEAD 위로 로컬 커밋을 올린다.
 * 로컬 발행 커밋이 있어 ff-only 로는 합쳐질 수 없으니 rebase(자동 stash)를 쓴다. 겹치면 되돌리고 멈춘다.
 */
async function rebaseOntoFetched() {
  // --autostash 는 stash 를 되돌려 놓다 충돌해도 성공(0)으로 끝나고, 충돌 표식이 든 파일과 stash 만 남긴다.
  // ff-only 경로와 같은 기준으로, 커밋하지 않은 수정이 원격의 새 커밋과 같은 파일이면 손대기 전에 멈춘다.
  await stopIfUncommittedOverlap();
  const rebased = await run("git", ["rebase", "--quiet", "--autostash", "FETCH_HEAD"]);
  if (!rebased.ok) {
    await run("git", ["rebase", "--abort"]);
    throw new Stop(
      "원격 변경과 겹쳐서 자동으로 합치지 못했어요. 커밋은 로컬에 있어요. 사람이 확인해 주세요:\n" +
        `  git pull --rebase ${remote} ${branch}\n${rebased.stderr.trim()}`,
    );
  }
  // 위 검사를 빠져나간 경우의 안전망. 수정은 stash 에 그대로 있으니 작업 폴더만 HEAD 로 되돌리고 사람에게 넘긴다.
  if (/autostash resulted in conflicts/i.test(rebased.stderr)) {
    await run("git", ["reset", "--quiet", "--hard", "HEAD"]);
    throw new Stop(
      "원격 변경과 커밋하지 않은 수정이 겹쳐서 자동으로 맞추지 못했어요. 그 수정은 git stash 에 들어 있어요(git stash pop 으로 꺼내 충돌을 풀어 주세요). " +
        "발행 커밋은 로컬에 있고, 다음 실행에서 푸시해요.\n" +
        `  git stash list\n${rebased.stderr.trim()}`,
    );
  }
}

/** 푸시가 non-fast-forward 로 거절되면 원격을 다시 받아와 그 위에 올린다. */
async function rebaseOntoRemote() {
  const fetched = await run("git", ["fetch", "--quiet", remote, branch]);
  if (!fetched.ok) {
    throw new Stop(`원격을 다시 받아오지 못했어요. 커밋은 로컬에 있고, 다음 실행에서 다시 푸시해요.\n${fetched.stderr.trim()}`);
  }
  await rebaseOntoFetched();
}

/**
 * 푸시한다. 원격이 앞서 있으면 받아와 올린 뒤 다시 시도하고(시도 횟수가 남는 동안 몇 번이든),
 * 로그인·권한처럼 다시 해도 같은 거절은 바로 멈추며, 그 밖의(네트워크성) 실패만 잠깐 쉬었다 다시 한다.
 * 성공하면 실제로 올라간 커밋 해시를 돌려준다 — rebase 뒤에는 처음 만든 커밋과 다르다.
 */
async function push() {
  const maxAttempts = PUSH_BACKOFF_MS.length + 1;
  let stderr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await run("git", ["push", "--quiet", remote, `HEAD:${branch}`]);
    if (result.ok) return git(["rev-parse", "HEAD"], "푸시한 커밋 해시를 읽지 못했어요.");
    stderr = result.stderr.trim();
    if (PUSH_AUTH_RE.test(stderr)) {
      throw new Stop(
        `원격 '${remote}' 에 로그인할 수 없어서 푸시하지 못했어요 (저장된 git 로그인 정보가 없거나 만료됐어요). ` +
          "커밋은 로컬에 만들어졌고, 로그인이 되면 다음 실행에서 다시 푸시해요.\n" +
          `  맥 터미널에서 앱 폴더로 가 \`git push ${remote} ${branch}\` 를 한 번 직접 실행해 로그인을 키체인에 저장해 주세요.\n` +
          '  자세한 방법은 README "발행 자동 반영" 의 전제 조건을 보세요.\n' +
          stderr,
      );
    }
    if (PUSH_PERMANENT_RE.test(stderr)) {
      throw new Stop(
        `원격 '${remote}' 이 푸시를 거절했어요. 권한·브랜치 보호·훅 문제라 다시 시도해도 같아요. ` +
          "커밋은 로컬에 만들어졌고, 원인을 고치면 다음 실행에서 다시 푸시해요.\n" +
          `  맥 터미널에서 앱 폴더로 가 \`git push ${remote} ${branch}\` 를 직접 실행해 보면 자세한 이유를 볼 수 있어요(로그인 문제면 그때 키체인에 저장돼요).\n` +
          stderr,
      );
    }
    if (attempt === maxAttempts) break;
    if (PUSH_BEHIND_RE.test(stderr)) {
      say("원격에 새 커밋이 있어 먼저 받아온 뒤 다시 푸시해요.");
      await rebaseOntoRemote();
    } else {
      const delay = PUSH_BACKOFF_MS[attempt - 1];
      warn(`푸시에 실패했어요 (${attempt}/${maxAttempts}). ${delay / 1000}초 뒤 다시 시도해요.\n${stderr}`);
      await sleep(delay);
    }
  }
  throw new Stop(`푸시에 ${maxAttempts}번 실패했어요. 커밋은 로컬에 만들어졌고, 다음 실행에서 다시 푸시해요.\n${stderr}`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "trove-data-push", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new HttpError(url, response.status);
  return response.json();
}

/** GitHub 공개 배포 API 로 Vercel 배포 상태를 지켜본다(인증 없음, IP 당 시간당 60회). */
async function waitForDeployment({ owner, repo }, sha) {
  const deadline = Date.now() + WAIT_TOTAL_MS;
  const deploymentsUrl = `https://api.github.com/repos/${owner}/${repo}/deployments?sha=${sha}`;
  say(`배포 상태를 기다려요 (최대 ${WAIT_TOTAL_MS / 60_000}분, ${WAIT_INTERVAL_MS / 1000}초마다 확인).`);
  let lastState = null;
  let announcedMissing = false;
  for (;;) {
    try {
      const deployments = await fetchJson(deploymentsUrl);
      const statusesUrl = Array.isArray(deployments) ? deployments[0]?.statuses_url : undefined;
      if (typeof statusesUrl === "string") {
        const statuses = await fetchJson(statusesUrl);
        const state = Array.isArray(statuses) ? statuses[0]?.state : undefined;
        if (state && state !== lastState) {
          lastState = state;
          say(`  배포 상태: ${state}`);
        }
        if (state === "success") {
          say("배포가 끝났어요. 사이트에 새 발행물이 올라갔어요.");
          return;
        }
        if (state === "failure" || state === "error") {
          throw new Stop(`배포가 실패했어요 (${state}). Vercel 대시보드에서 빌드 로그를 확인해 주세요.`);
        }
      } else if (!announcedMissing) {
        announcedMissing = true;
        say("  아직 이 커밋의 배포가 등록되지 않았어요. 계속 기다려요.");
      }
    } catch (cause) {
      if (cause instanceof Stop) throw cause;
      // 기다려도 풀리지 않는 응답이면 20초마다 같은 경고를 남기는 대신 한 줄만 남기고 그만둔다.
      if (cause instanceof HttpError && WAIT_GIVE_UP_STATUSES.includes(cause.status)) {
        warn(
          `배포 상태를 조회할 수 없어요 (GitHub API ${cause.status}: 저장소가 비공개이거나 공개 API 한도를 넘었어요). ` +
            "푸시는 됐으니 Vercel 대시보드에서 확인해 주세요.",
        );
        return;
      }
      warn(`배포 상태를 읽지 못했어요: ${cause instanceof Error ? cause.message : cause}`);
    }
    if (Date.now() + WAIT_INTERVAL_MS > deadline) break;
    await sleep(WAIT_INTERVAL_MS);
  }
  say(
    `${WAIT_TOTAL_MS / 60_000}분 안에 배포가 끝나지 않았어요 (마지막 상태: ${lastState ?? "없음"}). ` +
      "푸시는 됐으니 Vercel 대시보드에서 진행 상황을 확인해 주세요.",
  );
}

async function report(sha) {
  const url = (await run("git", ["remote", "get-url", remote])).stdout.trim();
  const github = parseRemote(url);
  say(`커밋 ${sha} 을 ${remote}/${branch} 에 푸시했어요.`);
  if (!github) {
    say(`원격이 GitHub 가 아니라서 커밋 주소와 배포 확인은 건너뛰어요 (${url || remote}).`);
    return;
  }
  say(`  https://github.com/${github.owner}/${github.repo}/commit/${sha}`);
  say(`Vercel 이 ${branch} 브랜치를 자동으로 배포해요. 보통 1~2분 뒤 사이트에 반영돼요.`);
  if (options.wait) await waitForDeployment(github, sha);
}

/** 발행물을 public/ 에 복사하고, 필요하면 커밋·푸시한다. dry-run 이면 무엇을 할지만 보여 준다. */
async function publish({ ahead, previousCount, publicExisted }) {
  let pulled;
  try {
    pulled = await pullReleases({ root, sourceDir: opsDataDir(root), targetDir: publicDir });
  } catch (cause) {
    // 발행물이 없거나 깨진 것은 예상 범위의 멈춤이다. 스택 대신 이유와 할 일만 보여 준다.
    throw new Stop(
      `${cause instanceof Error ? cause.message : cause} ${untouched()}\n` +
        "폴더가 다른 곳이면 TROVE_OPS_DATA_DIR=/path npm run data:push:install 로 에이전트를 다시 등록해 주세요.",
    );
  }
  // dry-run 이 fast-forward 를 건너뛰었으면 HEAD 가 아니라 원격 커밋 기준으로 본다(실제 실행과 같은 답을 내기 위해).
  const changes =
    baseRef === "HEAD"
      ? await changedDataPaths()
      : await changedDataPathsAgainst(
          baseRef,
          [pulled.targetItems, pulled.targetMeta].filter(Boolean).map((path) => relative(root, path)),
        );

  if (changes.length === 0 && ahead.length === 0) {
    // --quiet 라도 이번 실행이 경고를 남겼으면(예: 커밋되지 않은 발행 파일을 되돌림) 한 줄로 줄이지 않고 모아 둔 출력을 전부 남긴다.
    if (options.quiet && !pending.some(([level]) => level === "warn")) {
      pending.length = 0;
      buffering = false;
      console.log(`변경 없음 (${formatSeoulTime()})`);
      return;
    }
    flush();
    for (const warning of pulled.warnings) warn(warning);
    say(formatPullSummary(pulled));
    say("변경 없음: public/ 의 발행물이 이미 최신이에요.");
    return;
  }

  flush();
  for (const warning of pulled.warnings) warn(warning);
  say(formatPullSummary(pulled));

  let sha;
  if (changes.length === 0) {
    say(`발행물은 그대로지만 아직 푸시되지 않은 발행 커밋 ${ahead.length}개가 있어 푸시해요.`);
    sha = ahead[0].sha;
  } else {
    const reason = shouldRefuse({
      previousCount,
      nextCount: pulled.count,
      allowEmpty: options.allowEmpty,
      allowShrink: options.allowShrink,
    });
    if (reason) {
      if (!options.dryRun) await restore(changes, publicExisted); // dry-run 은 main() 이 스냅샷으로 되돌린다
      throw new Stop(`${reason}\npublic/ 의 발행 파일은 원래대로 되돌렸어요.`);
    }
    const message = buildCommitMessage({ count: pulled.count, byCategory: pulled.byCategory });
    if (options.dryRun) {
      say(`[dry-run] 커밋할 파일: ${changes.map((change) => change.path).join(", ")}`);
      say(`[dry-run] 커밋 메시지: ${message}`);
      say(`[dry-run] 푸시: git push ${remote} HEAD:${branch}`);
      say("[dry-run] 실제로는 커밋·푸시하지 않았고, public/ 의 발행 파일도 원래대로 되돌려요.");
      return;
    }
    try {
      sha = await commit(changes, message);
    } catch (cause) {
      // `git add` 가 이미 지나갔을 수 있어, add 전에 읽어 둔 changes 가 아니라 지금 상태를 다시 읽어 되돌린다
      // (add 전 상태로는 스테이징이 풀리지 않고, " M" 은 checkout 이 인덱스의 새 내용을 다시 쓴다).
      try {
        await restore(await changedDataPaths(), publicExisted);
      } catch {
        // 되돌리기까지 실패하면 다음 실행의 stale 정리("커밋되지 않은 발행 파일 변경을 먼저 되돌려요")에 맡긴다
      }
      throw cause instanceof Stop ? new Stop(`${cause.message}\npublic/ 의 발행 파일은 원래대로 되돌렸어요.`) : cause;
    }
    say(`커밋 ${sha.slice(0, 7)}: ${message}`);
  }

  if (options.dryRun) {
    say(`[dry-run] 푸시하지 않았어요: git push ${remote} HEAD:${branch}`);
    return;
  }
  // rebase 를 거치면 처음 만든 커밋과 해시가 달라지므로, 실제로 올라간 해시로 알리고 기다린다.
  await report(await push());
}

async function main() {
  if (options.dryRun) say("[dry-run] 커밋·푸시는 하지 않고 무엇을 할지만 보여 줘요. 로컬 브랜치와 파일도 바꾸지 않아요.");
  await preflight();

  // 지난 실행이 복사 뒤 커밋 전에 죽었거나 손으로 data:pull 을 돌렸으면 발행 파일이 수정된 채 남아 있다.
  // 그대로 두면 원격 커밋이 같은 파일을 건드릴 때 ff 병합이 막히고 급감 판단도 흐려지므로, 곧 덮어쓸 이 두 파일만 먼저 되돌린다.
  const stale = await changedDataPaths();
  if (stale.length) {
    const names = stale.map((change) => change.path).join(", ");
    if (options.dryRun) {
      warn(`[dry-run] 커밋되지 않은 발행 파일 변경이 있어요(${names}). 실제 실행이라면 먼저 되돌리지만, 지금은 그대로 둬요.`);
    } else {
      warn(`커밋되지 않은 발행 파일 변경을 먼저 되돌려요: ${names}`);
      await restore(stale, true);
      restoredStale = true;
    }
  }
  await syncWithRemote();
  say(options.dryRun ? `[dry-run] ${remote}/${branch} 을 받아왔어요.` : `${remote}/${branch} 과 맞췄어요.`);

  const ahead = await unpushedCommits();
  const foreign = ahead.filter((commitInfo) => !isReleaseCommit(commitInfo));
  if (foreign.length) {
    throw new Stop(
      `로컬 '${branch}' 에 아직 푸시되지 않은 커밋이 ${ahead.length}개 있는데, 이 스크립트가 만든 발행 커밋이 아니에요. ` +
        `사람이 직접 푸시하거나 정리한 뒤에 다시 실행해 주세요. ${untouched()}\n` +
        foreign.map((commitInfo) => `  ${commitInfo.sha.slice(0, 7)} ${commitInfo.subject}`).join("\n"),
    );
  }

  const previousCount = await committedCount();
  const publicExisted = await exists(publicDir);
  if (!options.dryRun) {
    await publish({ ahead, previousCount, publicExisted });
    return;
  }
  // dry-run: 복사까지는 해 보되, 끝나면 두 발행 파일을 손대기 전 바이트 그대로 되돌린다(새로 만든 public/ 도 지운다).
  const snapshot = await snapshotDataFiles();
  try {
    await publish({ ahead, previousCount, publicExisted });
  } finally {
    await restoreSnapshot(snapshot, publicExisted);
  }
}

try {
  await main();
} catch (cause) {
  if (cause instanceof Skip) {
    pending.length = 0;
    buffering = false;
    console.log(cause.message);
  } else {
    flush();
    if (cause instanceof Stop) console.error(cause.message);
    else console.error(`예상치 못한 오류로 멈췄어요.\n${cause?.stack ?? cause}`);
    process.exitCode = 1;
  }
} finally {
  releaseLock();
}

#!/usr/bin/env node
/**
 * 운영 콘솔 발행물을 public/ 에 반영하고, 그 두 파일만 커밋해 원격으로 푸시한다.
 * Vercel 이 main 을 자동 배포하므로 "콘솔에서 발행 → 배포" 가 사람 손 없이 이어진다.
 *
 *   npm run data:push                    # 한 번 실행
 *   npm run data:push -- --dry-run       # 커밋·푸시는 하지 않고 무엇을 할지만 보여 준다
 *   npm run data:push -- --wait          # 푸시 뒤 GitHub 배포(Vercel) 상태를 최대 5분 기다린다
 *   npm run data:push -- --allow-empty   # 0건 발행도 반영한다
 *   npm run data:push -- --allow-shrink  # 건수가 절반 넘게 줄어도 반영한다
 *   npm run data:push -- --quiet         # 변경이 없을 때 한 줄만 찍는다(launchd 주기 실행용)
 *
 * 환경 변수
 *   TROVE_OPS_DATA_DIR  발행물 폴더 (기본 <앱 폴더>/trove-ops/data)
 *   TROVE_PUSH_BRANCH   반영할 브랜치 (기본 main). 지금 체크아웃된 브랜치가 다르면 아무것도 하지 않는다
 *   TROVE_PUSH_REMOTE   푸시할 원격 (기본 origin)
 *   TROVE_APP_ROOT      앱 폴더를 강제로 지정 (테스트용. 기본은 이 스크립트가 들어 있는 앱 폴더)
 *
 * 모든 경로는 앱 폴더 기준이라 launchd 의 WorkingDirectory 와 무관하게 동작한다.
 * 종료 코드: 0 = 반영했거나 변경 없음, 1 = 무엇이든 막혀서 멈춤(이유를 한국어로 찍는다).
 */
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { access, open, readFile, rm, rmdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
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
const LOCK_STALE_MS = 30 * 60 * 1000;
const PUSH_BACKOFF_MS = [2000, 4000];
const WAIT_TOTAL_MS = 5 * 60 * 1000;
const WAIT_INTERVAL_MS = 20 * 1000;

/** 사람에게 보여 줄 이유를 담아 멈춘다(종료 코드 1). */
class Stop extends Error {}

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
function flush() {
  buffering = false;
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
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    releaseLock();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
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

    // 누가 들고 있는 잠금이다. 30분 넘게 묵은 것은 죽은 실행이 남긴 것으로 보고 치운다.
    let info = {};
    try {
      info = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      // 내용이 깨졌으면 파일 시각으로 판단
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
    if (Date.now() - startedAt >= LOCK_STALE_MS) {
      warn(`30분 넘게 남아 있던 잠금을 치웠어요: ${lockPath}`);
      await rm(lockPath, { force: true });
      continue;
    }
    throw new Stop(
      `다른 발행 반영이 진행 중이에요 (pid ${info?.pid ?? "?"}, ${info?.time ?? new Date(startedAt).toISOString()} 시작). ` +
        `끝나길 기다렸다가 다시 실행해 주세요.\n멈춘 게 확실하면 잠금 파일을 지우면 돼요: ${lockPath}`,
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
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new Stop(`앱 폴더가 git 저장소가 아니에요: ${root}`);
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

/** git pull --ff-only 와 같다. 로컬이 갈라져 있으면 사람이 봐야 하므로 멈춘다. */
async function syncWithRemote() {
  const fetched = await run("git", ["fetch", "--quiet", remote, branch]);
  if (!fetched.ok) {
    throw new Stop(
      `원격 '${remote}' 의 '${branch}' 브랜치를 받아오지 못했어요. 네트워크나 git 로그인 상태를 확인해 주세요.\n${fetched.stderr.trim()}`,
    );
  }
  const merged = await run("git", ["merge", "--ff-only", "--quiet", "FETCH_HEAD"]);
  if (!merged.ok) {
    throw new Stop(
      `로컬 '${branch}' 브랜치가 원격과 갈라져 있어요(원격에 없는 커밋이 있거나 충돌). 사람이 직접 확인해야 해요. 아무것도 바꾸지 않았어요.\n` +
        `  git status\n  git log --oneline ${remote}/${branch}..HEAD\n${merged.stderr.trim()}`,
    );
  }
}

/** 원격에 아직 없는 로컬 커밋들(최신 순). */
async function unpushedCommits() {
  const out = await git(["log", "--format=%H%x09%s", "FETCH_HEAD..HEAD"], "푸시되지 않은 커밋을 확인하지 못했어요.");
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [sha, ...rest] = line.split("\t");
    return { sha, subject: rest.join("\t") };
  });
}

async function currentCount() {
  try {
    const items = JSON.parse(await readFile(resolve(root, DATA_PATHS[0]), "utf8"));
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

/** 두 발행 파일 중 실제로 달라진 것만. [{ status: "??" | " M" | ..., path }] */
async function changedDataPaths() {
  // 첫 글자가 공백일 수 있어(" M path") trim 하지 않고 줄 단위로 읽는다.
  const result = await run("git", ["status", "--porcelain", "--untracked-files=all", "--", ...DATA_PATHS]);
  if (!result.ok) throw new Stop(`변경 사항을 확인하지 못했어요.\n${result.stderr.trim()}`);
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

/** 복사 전 상태로 되돌린다: 추적 중인 파일은 checkout, 새로 생긴 파일은 지운다. */
async function restore(changes, publicExisted) {
  const tracked = changes.filter((change) => change.status !== "??").map((change) => change.path);
  const untracked = changes.filter((change) => change.status === "??").map((change) => change.path);
  if (tracked.length) await git(["checkout", "--", ...tracked], "파일을 원래대로 되돌리지 못했어요.");
  for (const path of untracked) await rm(resolve(root, path), { force: true });
  if (!publicExisted) {
    try {
      await rmdir(publicDir);
    } catch {
      // 비어 있지 않으면 그대로 둔다
    }
  }
}

/** 두 파일만 커밋한다. 다른 스테이징·수정 사항은 그대로 남는다. */
async function commit(changes, message) {
  const paths = changes.map((change) => change.path);
  await git(["add", "--", ...paths], "발행 파일을 스테이징하지 못했어요.");
  await git(["commit", "--quiet", "-m", message, "--", ...paths], "커밋을 만들지 못했어요.");
  return git(["rev-parse", "HEAD"], "커밋 해시를 읽지 못했어요.");
}

/**
 * 푸시가 non-fast-forward 로 거절되면 원격을 받아와 그 위에 올린다.
 * 방금 만든 로컬 커밋이 있어 ff-only 로는 합쳐질 수 없으니 rebase(자동 stash)를 쓴다. 겹치면 되돌리고 멈춘다.
 */
async function rebaseOntoRemote() {
  const fetched = await run("git", ["fetch", "--quiet", remote, branch]);
  if (!fetched.ok) {
    throw new Stop(`원격을 다시 받아오지 못했어요. 커밋은 로컬에 있고, 다음 실행에서 다시 푸시해요.\n${fetched.stderr.trim()}`);
  }
  const rebased = await run("git", ["rebase", "--quiet", "--autostash", "FETCH_HEAD"]);
  if (!rebased.ok) {
    await run("git", ["rebase", "--abort"]);
    throw new Stop(
      "원격 변경과 겹쳐서 자동으로 합치지 못했어요. 커밋은 로컬에 있어요. 사람이 확인해 주세요:\n" +
        `  git pull --rebase ${remote} ${branch}\n${rebased.stderr.trim()}`,
    );
  }
}

async function push() {
  const maxAttempts = PUSH_BACKOFF_MS.length + 1;
  let recovered = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await run("git", ["push", "--quiet", remote, `HEAD:${branch}`]);
    if (result.ok) return;
    const stderr = result.stderr.trim();
    if (!recovered && /non-fast-forward|fetch first/i.test(stderr)) {
      recovered = true;
      say("원격에 새 커밋이 있어 먼저 받아온 뒤 다시 푸시해요.");
      await rebaseOntoRemote();
      continue;
    }
    if (attempt < maxAttempts) {
      const delay = PUSH_BACKOFF_MS[attempt - 1];
      warn(`푸시에 실패했어요 (${attempt}/${maxAttempts}). ${delay / 1000}초 뒤 다시 시도해요.\n${stderr}`);
      await sleep(delay);
    } else {
      throw new Stop(
        `푸시에 ${maxAttempts}번 실패했어요. 커밋은 로컬에 만들어졌고, 다음 실행에서 다시 푸시해요.\n${stderr}`,
      );
    }
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "trove-data-push", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url} 응답이 ${response.status} 이에요.`);
  return response.json();
}

/** GitHub 공개 배포 API 로 Vercel 배포 상태를 지켜본다(인증 없음). */
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

async function main() {
  if (options.dryRun) say("[dry-run] 커밋·푸시는 하지 않고 무엇을 할지만 보여 줘요.");
  await preflight();
  await syncWithRemote();
  say(`${remote}/${branch} 과 맞췄어요.`);

  const ahead = await unpushedCommits();
  const foreign = ahead.filter((commitInfo) => !commitInfo.subject.startsWith(COMMIT_PREFIX));
  if (foreign.length) {
    throw new Stop(
      `로컬 '${branch}' 에 아직 푸시되지 않은 커밋이 ${ahead.length}개 있는데, 이 스크립트가 만든 발행 커밋이 아니에요. ` +
        "사람이 직접 푸시하거나 정리한 뒤에 다시 실행해 주세요. 아무것도 바꾸지 않았어요.\n" +
        foreign.map((commitInfo) => `  ${commitInfo.sha.slice(0, 7)} ${commitInfo.subject}`).join("\n"),
    );
  }

  const previousCount = await currentCount();
  const publicExisted = await exists(publicDir);
  const pulled = await pullReleases({ root, sourceDir: opsDataDir(root), targetDir: publicDir });
  const changes = await changedDataPaths();

  if (changes.length === 0 && ahead.length === 0) {
    if (options.quiet) {
      pending.length = 0;
      buffering = false;
      console.log(`변경 없음 (${formatSeoulTime()})`);
    } else {
      for (const warning of pulled.warnings) warn(warning);
      say(formatPullSummary(pulled));
      say("변경 없음: public/ 의 발행물이 이미 최신이에요.");
    }
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
      await restore(changes, publicExisted);
      throw new Stop(`${reason}\npublic/ 의 발행 파일은 원래대로 되돌렸어요.`);
    }
    const message = buildCommitMessage({ count: pulled.count, byCategory: pulled.byCategory });
    if (options.dryRun) {
      say(`[dry-run] 커밋할 파일: ${changes.map((change) => change.path).join(", ")}`);
      say(`[dry-run] 커밋 메시지: ${message}`);
      say(`[dry-run] 푸시: git push ${remote} HEAD:${branch}`);
      await restore(changes, publicExisted);
      say("[dry-run] 실제로는 커밋·푸시하지 않았고, public/ 의 발행 파일도 원래대로 되돌렸어요.");
      return;
    }
    sha = await commit(changes, message);
    say(`커밋 ${sha.slice(0, 7)}: ${message}`);
  }

  if (options.dryRun) {
    say(`[dry-run] 푸시하지 않았어요: git push ${remote} HEAD:${branch}`);
    return;
  }
  await push();
  await report(sha);
}

try {
  await main();
} catch (cause) {
  flush();
  if (cause instanceof Stop) console.error(cause.message);
  else console.error(`예상치 못한 오류로 멈췄어요.\n${cause?.stack ?? cause}`);
  process.exitCode = 1;
} finally {
  releaseLock();
}

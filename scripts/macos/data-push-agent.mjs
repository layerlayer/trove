#!/usr/bin/env node
/**
 * 맥(launchd)에 "발행 자동 반영" 을 등록·해제·확인한다. macOS 전용.
 *   npm run data:push:install     # ~/Library/LaunchAgents/com.trove.data-push.plist 를 쓰고 바로 켠다
 *   npm run data:push:uninstall   # 끄고 plist 를 지운다
 *   npm run data:push:status      # 등록 여부와 최근 로그 5줄
 *
 * 등록된 작업은 주기마다(기본 600초 = 10분, 로그인 직후에도 한 번) `node scripts/push-releases.mjs --quiet` 를 돌린다.
 * 로그인한 사용자 세션(launchd gui/<uid>) 안에서만 돌므로, 맥 화면에 로그인돼 있고 맥이 깨어 있어야 한다.
 *   TROVE_PUSH_INTERVAL=300 npm run data:push:install   # 주기를 초 단위로 바꾼다(최소 60)
 *   TROVE_OPS_DATA_DIR=/path npm run data:push:install  # 설치하는 셸에 있으면 에이전트 환경에도 넣는다
 *   TROVE_PUSH_REMOTE=github TROVE_PUSH_BRANCH=main npm run data:push:install  # 푸시할 원격·브랜치도 같은 방식으로 넣는다
 * 로그는 ~/Library/Logs/trove-data-push.log 에 계속 덧붙는다.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  agentEnvironment,
  buildPlist,
  parseLaunchctlPrint,
  programFromPlist,
  protectedFolderOf,
  stableNodePath,
} from "../lib/launchd.mjs";
import { appRoot, isHttpRemote, isSshRemote, parseRemote } from "../lib/releases.mjs";

const execFileAsync = promisify(execFile);

const LABEL = "com.trove.data-push";
const DEFAULT_INTERVAL = 600;
const MIN_INTERVAL = 60;
const BOOTSTRAP_RETRIES = 5; // bootout 직후에는 이전 프로세스가 아직 내려가는 중일 수 있어 잠깐 재시도한다
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class Stop extends Error {}

function usage() {
  return (
    "쓰는 법: node scripts/macos/data-push-agent.mjs <install|uninstall|status>\n" +
    "  npm run data:push:install / data:push:uninstall / data:push:status"
  );
}

async function run(command, args, { env, input } = {}) {
  const pendingRun = execFileAsync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env });
  if (input !== undefined) pendingRun.child.stdin.end(input);
  try {
    const { stdout, stderr } = await pendingRun;
    return { ok: true, stdout, stderr };
  } catch (cause) {
    return {
      ok: false,
      stdout: typeof cause?.stdout === "string" ? cause.stdout : "",
      stderr: typeof cause?.stderr === "string" && cause.stderr ? cause.stderr : String(cause?.message ?? cause),
    };
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

function readInterval() {
  const raw = process.env.TROVE_PUSH_INTERVAL?.trim();
  if (!raw) return DEFAULT_INTERVAL;
  if (!/^\d+$/.test(raw)) throw new Stop(`TROVE_PUSH_INTERVAL 은 초 단위 정수여야 해요: ${raw}`);
  const value = Number.parseInt(raw, 10);
  if (value < MIN_INTERVAL) {
    console.warn(`TROVE_PUSH_INTERVAL=${value} 는 너무 잦아서 최소값 ${MIN_INTERVAL}초로 올렸어요.`);
    return MIN_INTERVAL;
  }
  return value;
}

/** 앱 폴더가 macOS 보호 폴더(~/Documents 등) 안이면 launchd 가 띄운 node 는 따로 허용을 받아야 한다고 알려 준다. */
function warnIfProtectedFolder(root, home) {
  const folder = protectedFolderOf(root, home);
  if (!folder) return;
  console.warn(
    `주의: 앱 폴더가 macOS 보호 폴더 안에 있어요 (${folder}).\n` +
      '  첫 자동 실행 때 "node"이(가) 이 폴더에 접근하려 한다는 창이 뜨면 꼭 "허용"을 눌러 주세요(터미널에서 직접 실행할 때는 뜨지 않아요).\n' +
      "  거부했거나 node 를 업데이트한 뒤 로그에 EPERM 이 보이면: 시스템 설정 > 개인정보 보호 및 보안 > 파일 및 폴더 에서 node 를 다시 허용하거나,\n" +
      "  앱 폴더를 보호 폴더 밖(예: ~/Projects)으로 옮기고 npm run data:push:install 을 다시 실행해 주세요.",
  );
}

/**
 * launchd 밑에서는 git 이 터미널에 묻지 못한다(토큰, ssh 키 암호, 호스트 키 확인). 그 조건 그대로 원격 인증을 미리 해 본다.
 * HTTPS 는 자격 증명 도우미(키체인)가 로그인 정보를 내주는지(네트워크 없이), ssh 는 BatchMode 로 실제 접속되는지 본다.
 * 로컬 경로 같은 다른 종류의 원격은 확인할 게 없다.
 */
async function checkRemoteAuth(root, environment) {
  const remote = process.env.TROVE_PUSH_REMOTE?.trim() || "origin";
  const url = (await run("git", ["-C", root, "remote", "get-url", remote])).stdout.trim();
  if (!url) return;
  const ssh = isSshRemote(url);
  if (!ssh && !isHttpRemote(url)) return;

  // 에이전트와 같은 PATH 로, 묻는 창(askpass)은 빼고 돌린다 — launchd 환경에는 없다.
  const { GIT_ASKPASS, SSH_ASKPASS, ...inherited } = process.env;
  const env = { ...inherited, PATH: environment.PATH, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" };
  const probe = ssh
    ? await run("git", ["-C", root, "ls-remote", "--exit-code", remote, "HEAD"], { env })
    : await run("git", ["-C", root, "credential", "fill"], { env, input: `url=${url}\n\n` }); // stdout 에 로그인 정보가 오므로 절대 찍지 않는다
  if (probe.ok) {
    console.log(`launchd 환경에서 '${remote}' 인증 확인됨 (${url}).`);
    return;
  }

  const github = parseRemote(url);
  const httpsUrl = github ? `https://github.com/${github.owner}/${github.repo}.git` : "https://github.com/<owner>/<repo>.git";
  const remedy = ssh
    ? "  키에 암호가 있으면 키체인에 넣어 두세요: ssh-add --apple-use-keychain ~/.ssh/<키>  (+ ~/.ssh/config 에 UseKeychain yes)\n" +
      "    (지금 확인은 터미널의 ssh-agent 를 같이 쓰므로, 재시작 뒤에도 유지되려면 꼭 --apple-use-keychain 으로 넣어야 해요)\n" +
      "  'Host key verification failed' 면: ssh-keyscan github.com >> ~/.ssh/known_hosts\n" +
      "  가장 안정적인 건 HTTPS 원격 + macOS 키체인이에요:\n" +
      `    git -C "${root}" remote set-url ${remote} ${httpsUrl}\n` +
      "    git config --global credential.helper osxkeychain"
    : "  터미널에서 한 번 로그인하면 키체인에 저장돼요 (git config --global credential.helper osxkeychain 뒤):\n" +
      `    git -C "${root}" push --dry-run ${remote} HEAD`;
  console.warn(
    `주의: launchd 환경(비밀번호를 물을 수 없음)에서 '${remote}' (${url}) 인증에 실패했어요. 자동 푸시도 같은 이유로 실패해요.\n` +
      `  ${probe.stderr.trim().split("\n").join("\n  ")}\n${remedy}`,
  );
}

async function main() {
  const command = process.argv[2];
  if (!["install", "uninstall", "status"].includes(command)) throw new Stop(usage());
  if (process.platform !== "darwin") {
    throw new Stop(`이 명령은 macOS 에서만 써요 (launchd 를 사용해요). 지금 운영체제는 ${process.platform} 이에요.`);
  }

  const root = appRoot();
  const uid = process.getuid();
  const home = homedir();
  const plistPath = resolve(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const logPath = resolve(home, "Library", "Logs", "trove-data-push.log");
  const domain = `gui/${uid}`;
  const pushScript = resolve(root, "scripts", "push-releases.mjs");
  const nodePath = await stableNodePath(process.execPath);
  const environment = agentEnvironment({ nodePath, home });

  if (command === "install") {
    if (!(await exists(pushScript))) throw new Stop(`앱 폴더에 발행 반영 스크립트가 없어요: ${pushScript}`);
    const interval = readInterval();

    const plist = buildPlist({
      label: LABEL,
      programArguments: [nodePath, pushScript, "--quiet"],
      workingDirectory: root,
      startInterval: interval,
      logPath,
      environment,
    });
    await mkdir(dirname(plistPath), { recursive: true });
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(plistPath, plist, "utf8");

    await run("launchctl", ["bootout", `${domain}/${LABEL}`]); // 이미 등록돼 있었으면 내리고, 아니면 무시(파일 없이도 라벨로 찾는다)
    await run("launchctl", ["enable", `${domain}/${LABEL}`]); // 로그인 항목에서 꺼 두었거나 disable 된 기록이 있으면 다시 켠다(없으면 아무 일도 안 함)
    // bootout 은 실행 중인 프로세스가 끝나기 전에 돌아오므로, 그 사이의 bootstrap 은 "37: Operation already in progress"(또는 "5: Input/output error") 로 실패할 수 있다.
    let loaded;
    for (let attempt = 1; ; attempt += 1) {
      loaded = await run("launchctl", ["bootstrap", domain, plistPath]);
      if (loaded.ok || attempt >= BOOTSTRAP_RETRIES || !/Input\/output error|already in progress/i.test(loaded.stderr)) break;
      await sleep(1000);
    }
    if (!loaded.ok) {
      const hasGuiSession = (await run("launchctl", ["print", domain])).ok;
      const hint = hasGuiSession
        ? ""
        : "\n이 계정으로 맥 화면에 로그인한 세션(GUI)이 없어요 (ssh 로 접속 중인가요?).\n" +
          "  자동 반영은 로그인한 사용자 세션 안에서만 돌아요. 맥 화면에 로그인한 뒤 그 터미널에서 다시 실행해 주세요.\n" +
          `  (설정 파일은 남겨 두었으니 다음 화면 로그인 때 자동으로 켜지기도 해요: ${plistPath})`;
      throw new Stop(`launchd 에 등록하지 못했어요.\n$ launchctl bootstrap ${domain} ${plistPath}\n${loaded.stderr.trim()}${hint}`);
    }

    console.log(
      [
        "발행 자동 반영을 등록했어요. 운영 콘솔에서 발행하면 주기마다 확인해 커밋·푸시하고, Vercel 이 이어서 배포해요.",
        `  설정 파일: ${plistPath}`,
        `  주기: ${interval}초(${Math.round(interval / 60)}분)마다, 로그인 직후에도 한 번 — 화면 로그인이 되어 있고 맥이 깨어 있는 동안만 돌아요`,
        `  앱 폴더: ${root}`,
        `  node: ${nodePath}`,
        `  로그: ${logPath}`,
        "잘 돌고 있는지 보려면:",
        "  npm run data:push:status",
        `  launchctl print ${domain}/${LABEL}`,
        `  tail -n 20 "${logPath}"`,
        "멈추려면: npm run data:push:uninstall",
      ].join("\n"),
    );
    warnIfProtectedFolder(root, home);
    await checkRemoteAuth(root, environment);
    return;
  }

  if (command === "uninstall") {
    const unloaded = await run("launchctl", ["bootout", `${domain}/${LABEL}`]); // 라벨로 내리므로 plist 를 손으로 지웠어도 끈다
    const hadPlist = await exists(plistPath);
    await rm(plistPath, { force: true });
    if (!hadPlist && !unloaded.ok) {
      console.log(`등록된 발행 자동 반영이 없어요 (${plistPath}).`);
      return;
    }
    console.log(
      `발행 자동 반영을 해제했어요. ${hadPlist ? "설정 파일을 지웠어요" : "설정 파일은 이미 없었어요"}: ${plistPath}\n로그는 그대로 두었어요: ${logPath}`,
    );
    return;
  }

  // status
  const hasPlist = await exists(plistPath);
  const printed = await run("launchctl", ["print", `${domain}/${LABEL}`]);
  const lines = [
    `설정 파일: ${hasPlist ? "있음" : "없음"} (${plistPath})`,
    `launchd 등록: ${printed.ok ? "켜져 있음" : "없음"} (launchctl print ${domain}/${LABEL})`,
  ];
  if (printed.ok) {
    const { pid, lastExit, neverExited } = parseLaunchctlPrint(printed.stdout);
    if (pid !== null) lines.push(`지금 실행 중 (pid ${pid})`);
    if (neverExited) lines.push("마지막 실행 결과: 아직 끝난 실행이 없어요");
    else if (lastExit !== null) lines.push(`마지막 실행 종료 코드: ${lastExit}${lastExit === 0 ? " (정상)" : " (로그를 확인해 주세요)"}`);
  } else if (hasPlist && !(await run("launchctl", ["print", domain])).ok) {
    lines.push("맥 화면에 로그인한 세션이 없어 확인할 수 없어요 (ssh 로 접속 중?). 로그인한 터미널에서 다시 확인해 주세요.");
  }
  if (hasPlist) {
    const program = programFromPlist(await readFile(plistPath, "utf8"));
    if (program && !(await exists(program))) {
      lines.push(`노드 경로가 없어요 (${program}). Node 를 올리거나 옮겼으면 npm run data:push:install 을 다시 실행해 주세요.`);
    }
  }
  if (await exists(logPath)) {
    const log = (await readFile(logPath, "utf8")).split("\n").filter((line) => line.trim() !== "");
    const tail = log.slice(-5);
    lines.push(`최근 로그 ${tail.length}줄 (${logPath}):`);
    lines.push(...(tail.length ? tail.map((line) => `  ${line}`) : ["  (비어 있음)"]));
  } else {
    lines.push(`로그 파일이 아직 없어요: ${logPath}`);
  }
  if (!hasPlist && !printed.ok) lines.push("등록하려면: npm run data:push:install");
  console.log(lines.join("\n"));
  warnIfProtectedFolder(root, home);
  await checkRemoteAuth(root, environment);
}

try {
  await main();
} catch (cause) {
  if (cause instanceof Stop) console.error(cause.message);
  else console.error(`예상치 못한 오류로 멈췄어요.\n${cause?.stack ?? cause}`);
  process.exitCode = 1;
}

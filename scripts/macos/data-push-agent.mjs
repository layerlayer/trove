#!/usr/bin/env node
/**
 * 맥(launchd)에 "발행 자동 반영" 을 등록·해제·확인한다. macOS 전용.
 *   npm run data:push:install     # ~/Library/LaunchAgents/com.trove.data-push.plist 를 쓰고 바로 켠다
 *   npm run data:push:uninstall   # 끄고 plist 를 지운다
 *   npm run data:push:status      # 등록 여부와 최근 로그 5줄
 *
 * 등록된 작업은 주기마다(기본 600초 = 10분, 로그인 직후에도 한 번) `node scripts/push-releases.mjs --quiet` 를 돌린다.
 *   TROVE_PUSH_INTERVAL=300 npm run data:push:install   # 주기를 초 단위로 바꾼다(최소 60)
 *   TROVE_OPS_DATA_DIR=/path npm run data:push:install  # 설치하는 셸에 있으면 에이전트 환경에도 넣는다
 * 로그는 ~/Library/Logs/trove-data-push.log 에 계속 덧붙는다.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { buildPlist } from "../lib/launchd.mjs";
import { appRoot, isSshRemote } from "../lib/releases.mjs";

const execFileAsync = promisify(execFile);

const LABEL = "com.trove.data-push";
const DEFAULT_INTERVAL = 600;
const MIN_INTERVAL = 60;

class Stop extends Error {}

function usage() {
  return (
    "쓰는 법: node scripts/macos/data-push-agent.mjs <install|uninstall|status>\n" +
    "  npm run data:push:install / data:push:uninstall / data:push:status"
  );
}

async function run(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
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

/** 원격이 ssh 방식이면 launchd 밑에서는 ssh 에이전트가 없을 수 있다고 한 번 알려 준다. */
async function warnIfSshRemote(root) {
  const remote = process.env.TROVE_PUSH_REMOTE?.trim() || "origin";
  const result = await execFileAsync("git", ["-C", root, "remote", "get-url", remote], { encoding: "utf8" }).catch(() => null);
  const url = result?.stdout.trim();
  if (!url || !isSshRemote(url)) return;
  console.warn(
    `주의: 원격 '${remote}' 주소가 ssh 방식이에요 (${url}).\n` +
      "  launchd 로 자동 실행될 때는 ssh 에이전트가 없어서 푸시가 실패할 수 있어요.\n" +
      "  HTTPS 원격 + macOS 키체인 자격 증명 도우미가 안정적이에요:\n" +
      `    git -C "${root}" remote set-url ${remote} https://github.com/<owner>/<repo>.git\n` +
      "    git config --global credential.helper osxkeychain",
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

  if (command === "install") {
    if (!(await exists(pushScript))) throw new Stop(`앱 폴더에 발행 반영 스크립트가 없어요: ${pushScript}`);
    const interval = readInterval();
    const environment = {
      PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
    };
    if (process.env.TROVE_OPS_DATA_DIR?.trim()) environment.TROVE_OPS_DATA_DIR = process.env.TROVE_OPS_DATA_DIR.trim();

    const plist = buildPlist({
      label: LABEL,
      programArguments: [process.execPath, pushScript, "--quiet"],
      workingDirectory: root,
      startInterval: interval,
      logPath,
      environment,
    });
    await mkdir(dirname(plistPath), { recursive: true });
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(plistPath, plist, "utf8");

    await run("launchctl", ["bootout", domain, plistPath]); // 이미 등록돼 있었으면 내리고, 아니면 무시
    const loaded = await run("launchctl", ["bootstrap", domain, plistPath]);
    if (!loaded.ok) {
      throw new Stop(`launchd 에 등록하지 못했어요.\n$ launchctl bootstrap ${domain} ${plistPath}\n${loaded.stderr.trim()}`);
    }

    console.log(
      [
        "발행 자동 반영을 등록했어요. 콘솔에서 발행하면 주기마다 확인해 커밋·푸시하고, Vercel 이 이어서 배포해요.",
        `  설정 파일: ${plistPath}`,
        `  주기: ${interval}초(${Math.round(interval / 60)}분)마다, 로그인 직후에도 한 번`,
        `  앱 폴더: ${root}`,
        `  로그: ${logPath}`,
        "잘 돌고 있는지 보려면:",
        "  npm run data:push:status",
        `  launchctl print ${domain}/${LABEL}`,
        `  tail -n 20 "${logPath}"`,
        "멈추려면: npm run data:push:uninstall",
      ].join("\n"),
    );
    await warnIfSshRemote(root);
    return;
  }

  if (command === "uninstall") {
    const unloaded = await run("launchctl", ["bootout", domain, plistPath]);
    const hadPlist = await exists(plistPath);
    await rm(plistPath, { force: true });
    if (!hadPlist && !unloaded.ok) {
      console.log(`등록된 발행 자동 반영이 없어요 (${plistPath}).`);
      return;
    }
    console.log(`발행 자동 반영을 해제했어요. 설정 파일을 지웠어요: ${plistPath}\n로그는 그대로 두었어요: ${logPath}`);
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
    const lastExit = /last exit code = (\S+)/.exec(printed.stdout)?.[1];
    if (lastExit) lines.push(`마지막 실행 종료 코드: ${lastExit}${lastExit === "0" ? " (정상)" : " (로그를 확인해 주세요)"}`);
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
  await warnIfSshRemote(root);
}

try {
  await main();
} catch (cause) {
  if (cause instanceof Stop) console.error(cause.message);
  else console.error(`예상치 못한 오류로 멈췄어요.\n${cause?.stack ?? cause}`);
  process.exitCode = 1;
}

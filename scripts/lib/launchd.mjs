/**
 * macOS launchd 에이전트를 위한 순수 함수. scripts/macos/data-push-agent.mjs 가 쓰고,
 * macOS 가 없어도 scripts/test/ 에서 검증할 수 있게 launchctl 호출과 분리해 둔다.
 * 경로에 특수문자가 있어도 깨지지 않도록 plist 의 XML 텍스트는 모두 이스케이프한다.
 */
import { realpath as fsRealpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const XML_UNESCAPES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

export function unescapeXml(value) {
  return String(value).replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_UNESCAPES[entity]);
}

/**
 * @param {object} spec
 * @param {string} spec.label                 launchd Label (예: com.trove.data-push)
 * @param {string[]} spec.programArguments    실행 파일과 인자
 * @param {string} spec.workingDirectory
 * @param {number} spec.startInterval         초 단위 주기
 * @param {string} spec.logPath               stdout/stderr 를 모두 이 파일에 덧붙인다
 * @param {Record<string, string>} spec.environment
 */
export function buildPlist({ label, programArguments, workingDirectory, startInterval, logPath, environment = {} }) {
  if (!Number.isInteger(startInterval) || startInterval <= 0) {
    throw new Error(`startInterval 은 양의 정수(초)여야 해요: ${startInterval}`);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArguments.map((argument) => `    <string>${escapeXml(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(workingDirectory)}</string>`,
    "  <key>StartInterval</key>",
    `  <integer>${startInterval}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(environment).flatMap(([key, value]) => [
      `    <key>${escapeXml(key)}</key>`,
      `    <string>${escapeXml(value)}</string>`,
    ]),
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

/** buildPlist 가 쓴 plist 에서 ProgramArguments 첫 항목(실행 파일)을 꺼낸다. 없으면 null. */
export function programFromPlist(plist) {
  const first = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(String(plist))?.[1];
  return first == null ? null : unescapeXml(first);
}

/** 에이전트가 쓸 PATH. node 가 있는 폴더를 맨 앞에 두고, Homebrew·기본 경로를 잇는다(launchd 의 PATH 는 /usr/bin:/bin 뿐이다). */
export function agentPath(nodePath) {
  return `${dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
}

/** push-releases.mjs 가 읽는 변수 중, 설치하는 셸에 있으면 에이전트 환경에도 그대로 넣는 것들. */
export const FORWARDED_ENV = ["TROVE_OPS_DATA_DIR", "TROVE_PUSH_REMOTE", "TROVE_PUSH_BRANCH"];

/** plist 의 EnvironmentVariables. 비어 있거나 공백뿐인 값은 넣지 않는다. */
export function agentEnvironment({ nodePath, home, env = process.env }) {
  const environment = { PATH: agentPath(nodePath), HOME: home };
  for (const key of FORWARDED_ENV) {
    const value = env[key]?.trim();
    if (value) environment[key] = value;
  }
  return environment;
}

/**
 * launchd 에 적을 node 실행 파일. process.execPath 는 심볼릭 링크를 푼 실제 경로라 Homebrew 에서는
 * /opt/homebrew/Cellar/node/<버전>/bin/node 가 되는데, `brew upgrade node` 가 옛 버전 폴더를 지우면
 * launchd 가 더는 실행하지 못한다(로그에도 아무것도 남지 않는다). 버전이 바뀌어도 그대로인
 * /opt/homebrew/opt/node/bin/node 가 같은 파일을 가리키면 그쪽을 쓰고, 아니면 execPath 를 그대로 쓴다.
 * (PATH 전체를 뒤지지는 않는다: fnm 은 셸마다 생겼다 지워지는 경로를 앞에 두기 때문이다.)
 */
export async function stableNodePath(execPath, { realpath = fsRealpath } = {}) {
  const keg = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!keg) return execPath;
  const candidate = `${keg[1]}/opt/${keg[2]}/bin/node`;
  const [real, candidateReal] = await Promise.all([
    realpath(execPath).catch(() => execPath),
    realpath(candidate).catch(() => null),
  ]);
  return candidateReal === real ? candidate : execPath;
}

/** macOS 가 따로 허용을 받는 사용자 폴더. launchd 가 띄운 node 는 터미널 권한을 물려받지 못한다. */
export const PROTECTED_FOLDERS = ["Documents", "Desktop", "Downloads"];

/** root 가 보호 폴더 안이면 그 폴더(예: /Users/seo/Documents)를, 아니면 null 을 돌려준다. */
export function protectedFolderOf(root, home) {
  const rel = relative(home, root);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const first = rel.split(sep)[0];
  return PROTECTED_FOLDERS.includes(first) ? resolve(home, first) : null;
}

/**
 * `launchctl print gui/<uid>/<label>` 출력에서 상태를 읽는다.
 *   pid         실행 중이면 그 pid, 아니면 null ("pid = N" 줄은 돌고 있을 때만 있다)
 *   lastExit    마지막 종료 코드(숫자), 아직 없거나 모르면 null
 *   neverExited "last exit code = (never exited)" 였는지(설치 직후 첫 실행이 아직 끝나지 않음)
 */
export function parseLaunchctlPrint(stdout) {
  const text = String(stdout ?? "");
  const pid = /^\s*pid = (\d+)\s*$/m.exec(text)?.[1];
  const exit = /last exit code = (\d+|\(never exited\))/.exec(text)?.[1];
  return {
    pid: pid === undefined ? null : Number(pid),
    lastExit: exit === undefined || exit.startsWith("(") ? null : Number(exit),
    neverExited: exit === "(never exited)",
  };
}

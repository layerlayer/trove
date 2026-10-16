/**
 * macOS launchd 에이전트 plist 를 만든다. scripts/macos/data-push-agent.mjs 가 쓰고,
 * 경로에 특수문자가 있어도 깨지지 않도록 XML 텍스트는 모두 이스케이프한다.
 */

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
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

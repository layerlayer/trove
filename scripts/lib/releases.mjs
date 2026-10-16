/**
 * 발행물(releases.json / releases.meta.json)을 다루는 공용 함수.
 * scripts/pull-releases.mjs 와 scripts/push-releases.mjs 가 함께 쓰고,
 * 순수 함수들은 scripts/test/ 에서 네트워크 없이 검증한다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 앱 폴더(package.json 이 있는 곳). 스크립트 위치 기준이라 어디서 실행해도 같다.
 * TROVE_APP_ROOT 를 주면 그 폴더를 대신 쓴다 — 테스트처럼 다른 체크아웃을 겨냥할 때만 쓰는 값이고,
 * pull/push 스크립트 모두 이 함수로 루트를 정한다.
 */
export function appRoot() {
  const override = process.env.TROVE_APP_ROOT?.trim();
  if (override) return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 운영 콘솔 발행물 폴더. 기본은 <앱 폴더>/trove-ops/data, TROVE_OPS_DATA_DIR 로 바꿀 수 있다. */
export function opsDataDir(root) {
  return resolve(root, process.env.TROVE_OPS_DATA_DIR ?? "trove-ops/data");
}

/**
 * JSON 파일을 한 번만 읽어 { raw, value } 로 돌려준다.
 * 복사할 때는 raw 를 그대로 써야 검증한 내용과 public/ 에 들어가는 내용이 같다
 * (경로를 다시 읽으면 그 사이 운영 콘솔이 고쳐 쓴 파일이 들어갈 수 있다). Buffer 로 읽어 바이트도 그대로 둔다.
 */
export async function readJsonFile(path) {
  const raw = await readFile(path);
  return { raw, value: JSON.parse(raw.toString("utf8")) };
}

/** 카테고리별 건수. 등장 순서를 지킨다(복사 결과 출력에 그대로 쓴다). */
export function countByCategory(items) {
  const byCategory = {};
  for (const item of items) {
    const key = item?.category ?? "?";
    byCategory[key] = (byCategory[key] ?? 0) + 1;
  }
  return byCategory;
}

const NEXT_ACTION = "운영 콘솔에서 먼저 발행했는지, 발행물 폴더 위치(TROVE_OPS_DATA_DIR)가 맞는지 확인해 주세요. 아무것도 바꾸지 않았어요.";

/**
 * 발행물을 targetDir 로 복사한다.
 * releases.json 을 읽지 못하거나 목록이 아니면 던진다(앱이 깨진 데이터를 싣지 않게). 던지는 메시지에는 다음 할 일이 들어 있다.
 * releases.meta.json 은 있으면 함께 복사하고, 없으면 warnings 에 한 줄 남기고 건너뛴다.
 * 각 파일은 한 번만 읽어 검증한 뒤 그 바이트를 그대로 쓴다.
 */
export async function pullReleases({
  root = appRoot(),
  sourceDir = opsDataDir(root),
  targetDir = resolve(root, "public"),
} = {}) {
  const itemsPath = resolve(sourceDir, "releases.json");
  const metaPath = resolve(sourceDir, "releases.meta.json");
  const warnings = [];

  let items;
  let itemsRaw;
  try {
    ({ raw: itemsRaw, value: items } = await readJsonFile(itemsPath));
  } catch (cause) {
    throw new Error(
      `releases.json 을 읽지 못했어요: ${itemsPath}\n${cause instanceof Error ? cause.message : cause}\n${NEXT_ACTION}`,
    );
  }
  if (!Array.isArray(items)) {
    throw new Error(`releases.json 이 목록이 아니에요: ${itemsPath}\n운영 콘솔에서 다시 발행해 주세요. 아무것도 바꾸지 않았어요.`);
  }

  await mkdir(targetDir, { recursive: true });
  const targetItems = resolve(targetDir, "releases.json");
  await writeFile(targetItems, itemsRaw);

  const targetMeta = resolve(targetDir, "releases.meta.json");
  let publishedAt = null;
  let metaCopied = false;
  try {
    const { raw: metaRaw, value: meta } = await readJsonFile(metaPath);
    await writeFile(targetMeta, metaRaw);
    metaCopied = true;
    publishedAt = typeof meta?.publishedAt === "string" ? meta.publishedAt : null;
  } catch {
    warnings.push("releases.meta.json 이 없거나 읽히지 않아 건너뛰었어요.");
  }

  return {
    count: items.length,
    byCategory: countByCategory(items),
    publishedAt,
    targetItems,
    targetMeta: metaCopied ? targetMeta : null,
    warnings,
  };
}

export function formatByCategory(byCategory) {
  return Object.entries(byCategory)
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ");
}

/** `npm run data:pull` 이 찍는 두 줄 요약. */
export function formatPullSummary({ count, byCategory, publishedAt, targetItems }) {
  return (
    `복사 완료: ${count}건 → ${targetItems}` +
    (publishedAt ? ` (발행 ${publishedAt})` : "") +
    `\n카테고리별: ${formatByCategory(byCategory) || "-"}`
  );
}

/**
 * GitHub 원격 주소에서 { owner, repo } 를 뽑는다. GitHub 가 아니면 null.
 *   https://github.com/o/r(.git) · git@github.com:o/r(.git) · ssh://git@github.com/o/r(.git)
 */
export function parseRemote(url) {
  if (typeof url !== "string") return null;
  const match =
    /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** ssh 방식 원격인지(git@… 또는 ssh://). launchd 인증 확인에서 ssh(BatchMode) 검사를 고를 때 쓴다. */
export function isSshRemote(url) {
  return typeof url === "string" && /^(?:ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(url.trim());
}

/** http(s) 방식 원격인지. launchd 인증 확인에서 자격 증명 도우미(키체인) 검사를 고를 때 쓴다. */
export function isHttpRemote(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

const SEOUL_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 서울 시각을 "YYYY-MM-DD HH:mm" 로. */
export function formatSeoulTime(date = new Date()) {
  const parts = Object.fromEntries(SEOUL_TIME.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 커밋 메시지: "data: 발행 반영 2026-10-16 10:24 (16건: music 11 · concert 5)". 카테고리는 많은 순. */
export function buildCommitMessage({ count, byCategory = {}, now = new Date() }) {
  const categories = Object.entries(byCategory)
    .sort(([keyA, countA], [keyB, countB]) => countB - countA || keyA.localeCompare(keyB))
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ");
  return `data: 발행 반영 ${formatSeoulTime(now)} (${count}건${categories ? `: ${categories}` : ""})`;
}

/**
 * 배포하면 안 될 것 같은 변화는 막는다. 막아야 하면 이유(와 넘어가는 옵션)를, 괜찮으면 null 을 돌려준다.
 * 0건은 --allow-empty 하나로 넘어간다(0건이면 줄어든 것도 당연하니 --allow-shrink 를 따로 요구하지 않는다).
 */
export function shouldRefuse({ previousCount = 0, nextCount, allowEmpty = false, allowShrink = false }) {
  if (nextCount === 0) {
    if (allowEmpty) return null;
    return (
      "발행물이 0건이에요. 빈 목록을 배포하면 앱에 아무 일정도 보이지 않아요. " +
      "정말 의도한 것이면 --allow-empty 를 붙여 다시 실행해 주세요."
    );
  }
  if (previousCount > 0 && nextCount < previousCount / 2 && !allowShrink) {
    return (
      `발행 건수가 ${previousCount}건에서 ${nextCount}건으로 절반 넘게 줄었어요. 발행이 잘못된 게 아닌지 운영 콘솔을 확인해 주세요. ` +
      "의도한 변경이면 --allow-shrink 를 붙여 다시 실행해 주세요."
    );
  }
  return null;
}

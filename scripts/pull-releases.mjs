#!/usr/bin/env node
/**
 * 운영 콘솔(trove-ops)이 발행한 releases.json / releases.meta.json 을 앱의 public/ 로 복사한다.
 *   npm run data:pull                      # <앱 폴더>/trove-ops/data 에서
 *   TROVE_OPS_DATA_DIR=/path/to/data npm run data:pull
 * 경로는 이 스크립트가 있는 앱 폴더 기준이라 어디서 실행해도 같은 곳에 쓴다.
 * JSON 으로 읽히지 않는 파일은 복사하지 않는다(앱이 깨진 데이터를 싣지 않게).
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(root, process.env.TROVE_OPS_DATA_DIR ?? "trove-ops/data");
const targetDir = resolve(root, "public");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const itemsPath = resolve(sourceDir, "releases.json");
const metaPath = resolve(sourceDir, "releases.meta.json");

let items;
try {
  items = await readJson(itemsPath);
} catch (cause) {
  console.error(`releases.json 을 읽지 못했어요: ${itemsPath}\n${cause instanceof Error ? cause.message : cause}`);
  process.exit(1);
}
if (!Array.isArray(items)) {
  console.error(`releases.json 이 목록이 아니에요: ${itemsPath}`);
  process.exit(1);
}

await mkdir(targetDir, { recursive: true });
const targetItems = resolve(targetDir, "releases.json");
await copyFile(itemsPath, targetItems);

let publishedAt = null;
try {
  const meta = await readJson(metaPath);
  await copyFile(metaPath, resolve(targetDir, "releases.meta.json"));
  publishedAt = typeof meta?.publishedAt === "string" ? meta.publishedAt : null;
} catch {
  console.warn("releases.meta.json 이 없거나 읽히지 않아 건너뛰었어요.");
}

const byCategory = {};
for (const item of items) {
  const key = item?.category ?? "?";
  byCategory[key] = (byCategory[key] ?? 0) + 1;
}
console.log(
  `복사 완료: ${items.length}건 → ${targetItems}` +
    (publishedAt ? ` (발행 ${publishedAt})` : "") +
    `\n카테고리별: ${Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}`,
);

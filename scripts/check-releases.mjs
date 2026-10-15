#!/usr/bin/env node
/**
 * 빌드 전 확인: 발행 파일(public/releases.json)이 없거나 목록이 아니면 빌드를 멈춘다.
 * 다른 주소의 발행물을 읽도록 VITE_RELEASES_URL 을 준 경우는 건너뛴다.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.VITE_RELEASES_URL?.trim()) process.exit(0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(root, "public", "releases.json");
try {
  const items = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(items)) throw new Error("목록(JSON 배열)이 아니에요.");
  console.log(`발행 파일 확인: ${items.length}건 (${path})`);
} catch (cause) {
  console.error(
    `public/releases.json 을 읽지 못해 빌드를 멈춰요: ${cause instanceof Error ? cause.message : cause}\n` +
      "운영 콘솔 발행물을 먼저 가져오세요: npm run data:pull",
  );
  process.exit(1);
}

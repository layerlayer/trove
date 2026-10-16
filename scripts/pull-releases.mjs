#!/usr/bin/env node
/**
 * 운영 콘솔(trove-ops)이 발행한 releases.json / releases.meta.json 을 앱의 public/ 로 복사한다.
 *   npm run data:pull                      # <앱 폴더>/trove-ops/data 에서
 *   TROVE_OPS_DATA_DIR=/path/to/data npm run data:pull
 * 경로는 이 스크립트가 있는 앱 폴더 기준이라 어디서 실행해도 같은 곳에 쓴다(TROVE_APP_ROOT 로 바꿀 수 있다).
 * JSON 으로 읽히지 않는 파일은 복사하지 않는다(앱이 깨진 데이터를 싣지 않게).
 * 복사 로직은 scripts/lib/releases.mjs 에 있고, 복사한 뒤 커밋·푸시까지 하려면 npm run data:push 를 쓴다.
 */
import { resolve } from "node:path";
import { appRoot, formatPullSummary, opsDataDir, pullReleases } from "./lib/releases.mjs";

const root = appRoot();

let result;
try {
  result = await pullReleases({ root, sourceDir: opsDataDir(root), targetDir: resolve(root, "public") });
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
for (const warning of result.warnings) console.warn(warning);
console.log(formatPullSummary(result));

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const LIVE_FILES = new Set(["/releases.json", "/releases.meta.json"]);

/**
 * 개발 서버 전용: 운영 콘솔이 발행한 파일을 public/ 에 복사하지 않고 바로 읽어 준다.
 * 콘솔에서 '발행' → 브라우저 새로고침이면 끝. 파일이 없으면 public/ 의 사본으로 넘어간다.
 * 배포 빌드는 여전히 `npm run data:pull` 로 복사해 커밋한 public/releases.json 을 쓴다.
 */
function liveReleases(): Plugin {
  const dataDir = resolve(process.env.TROVE_OPS_DATA_DIR ?? "trove-ops/data");
  return {
    name: "trove-live-releases",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (!LIVE_FILES.has(path)) return next();
        const file = resolve(dataDir, path.slice(1));
        if (!existsSync(file)) return next();
        try {
          const body = readFileSync(file, "utf8");
          JSON.parse(body); // 쓰는 도중인 반쪽 파일은 내보내지 않는다
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(body);
        } catch {
          next();
        }
      });
      server.config.logger.info(`[trove] 개발 서버는 ${dataDir} 의 발행물을 바로 읽어요 (없으면 public/ 사본).`);
    },
  };
}

export default defineConfig({
  plugins: [react(), liveReleases()],
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
});

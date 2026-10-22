/**
 * `npm run test:db` 이 쓰는 일회용 PostgreSQL. 임시 폴더에 클러스터를 만들고(유닉스 소켓만, TCP 없음) 시험이 끝나면 지운다.
 *
 * PostgreSQL 15 이상의 initdb·pg_ctl·psql 이 필요해요. 찾는 순서:
 *   PG_BIN 환경 변수(주면 거기만) → PATH 의 pg_config --bindir → PATH → /usr/lib/postgresql/<버전>/bin →
 *   Homebrew(/opt/homebrew/opt/postgresql@<버전>/bin, /usr/local/opt/…) → Postgres.app
 * 못 찾으면 시험을 건너뛰고 이유를 알려 줘요(실패로 치지 않아요).
 *
 * root 로 돌리면 initdb 가 거절하므로, 그때는 PG_RUN_AS(기본 postgres) 사용자로 서버를 띄워요.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { chown, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const MIN_MAJOR = 15;
const TOOLS = ["initdb", "pg_ctl", "psql"];

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function majorVersion(bin) {
  const out = spawnSync(join(bin, "pg_ctl"), ["--version"], { encoding: "utf8" });
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(out.stdout ?? "");
  return match ? Number(match[1]) : null;
}

function versionedDirs(base, pattern) {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))
    .map((entry) => join(base, entry.name, "bin"));
}

function candidateDirs() {
  const dirs = [];
  const pgConfig = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (pgConfig.status === 0 && pgConfig.stdout.trim()) dirs.push(pgConfig.stdout.trim());
  dirs.push(...(process.env.PATH ?? "").split(delimiter).filter(Boolean));
  dirs.push(...versionedDirs("/usr/lib/postgresql", /^(\d+)$/));
  dirs.push(...versionedDirs("/opt/homebrew/opt", /^postgresql@(\d+)$/));
  dirs.push(...versionedDirs("/usr/local/opt", /^postgresql@(\d+)$/));
  dirs.push("/Applications/Postgres.app/Contents/Versions/latest/bin");
  return [...new Set(dirs)];
}

/** { bin, major } 또는 { skip: "이유" }. PG_BIN 을 주면 그 폴더만 본다 */
export function findPostgres() {
  const tooOld = [];
  const pinned = process.env.PG_BIN;
  if (pinned && !TOOLS.every((tool) => isExecutable(join(pinned, tool)))) {
    return { skip: `PG_BIN(${pinned})에 initdb·pg_ctl·psql 이 없어 DB 시험을 건너뛰어요.` };
  }
  for (const dir of pinned ? [pinned] : candidateDirs()) {
    if (!TOOLS.every((tool) => isExecutable(join(dir, tool)))) continue;
    const major = majorVersion(dir);
    if (major !== null && major >= MIN_MAJOR) return { bin: dir, major };
    tooOld.push(`${dir} (${major ?? "?"})`);
  }
  if (tooOld.length > 0) {
    return { skip: `PostgreSQL ${MIN_MAJOR} 이상이 필요해요. 찾은 것: ${tooOld.join(", ")}. PG_BIN=<bin 폴더> 로 지정할 수 있어요.` };
  }
  return {
    skip:
      "PostgreSQL(initdb·pg_ctl·psql)을 찾지 못해 DB 시험을 건너뛰어요. 맥이면 `brew install postgresql@16` 뒤 다시 실행하거나, " +
      "PG_BIN=<initdb 가 있는 폴더> npm run test:db 로 위치를 알려 주세요.",
  };
}

function run(command, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

function runAsUser() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  const name = process.env.PG_RUN_AS || "postgres";
  const id = spawnSync("id", ["-u", name], { encoding: "utf8" });
  const gid = spawnSync("id", ["-g", name], { encoding: "utf8" });
  if (id.status !== 0) throw new Error(`root 로 실행 중이라 다른 사용자로 PostgreSQL 을 띄워야 해요. PG_RUN_AS=<사용자> 를 지정하세요(${name} 없음).`);
  return { name, uid: Number(id.stdout.trim()), gid: Number(gid.stdout.trim()) };
}

/**
 * 클러스터를 띄우고 돌려준다.
 * - sql(db, text, { vars }) → { code, stdout, stderr } (ON_ERROR_STOP, -At: 결과만 한 줄씩)
 * - createDatabase(name), stop()
 */
export async function startPostgres({ bin }) {
  const runAs = runAsUser();
  const base = process.env.PG_TEST_DIR || (runAs ? "/tmp" : tmpdir());
  const dir = await mkdtemp(join(base, "trove-db-"));
  if (runAs) await chown(dir, runAs.uid, runAs.gid);
  const data = join(dir, "data");
  const port = String(54_000 + Math.floor(Math.random() * 900));
  const asServerUser = (tool, args) =>
    runAs ? ["runuser", ["-u", runAs.name, "--", join(bin, tool), ...args]] : [join(bin, tool), args];

  const init = await run(...asServerUser("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--no-sync", "-E", "UTF8", "--locale=C"]));
  if (init.code !== 0) throw new Error(`initdb 실패:\n${init.stderr || init.stdout}`);
  const options = `-k ${dir} -p ${port} -c listen_addresses= -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c timezone=UTC`;
  const start = await run(...asServerUser("pg_ctl", ["-D", data, "-l", join(dir, "server.log"), "-w", "-t", "30", "-o", options, "start"]));
  if (start.code !== 0) throw new Error(`pg_ctl start 실패:\n${start.stderr || start.stdout}`);

  const psqlArgs = (db, vars) => [
    "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    ...Object.entries(vars ?? {}).flatMap(([key, value]) => ["-v", `${key}=${value}`]),
    "-h", dir, "-p", port, "-U", "postgres", "-d", db, "-f", "-",
  ];
  const env = { ...process.env, PGTZ: "UTC", PGOPTIONS: "-c client_min_messages=warning", PGCLIENTENCODING: "UTF8" };

  return {
    bin,
    sql(db, text, { vars } = {}) {
      return run(join(bin, "psql"), psqlArgs(db, vars), { input: text, env });
    },
    async createDatabase(name) {
      const result = await run(join(bin, "psql"), psqlArgs("postgres"), { input: `create database "${name}";`, env });
      if (result.code !== 0) throw new Error(result.stderr);
    },
    async stop() {
      await run(...asServerUser("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

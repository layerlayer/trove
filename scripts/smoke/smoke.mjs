#!/usr/bin/env node
/**
 * 서버 연결 스모크 시험(`npm run smoke`). Vercel 빌드에는 들어가지 않는다. 실제 Supabase 에는 접속하지 않는다.
 *
 *  (a) 환경 변수 없이 빌드 → 앱이 뜨고 홈이 그려지며, 같은 사이트 말고는 아무 데도 요청하지 않는다(Supabase 코드도 안 읽음)
 *  (b) VITE_SUPABASE_URL 을 가짜 Supabase(scripts/smoke/mock-supabase.mjs)로 두고 빌드 →
 *      새로고침·여러 탭에서도 익명 가입은 한 번, 기록은 공통 필드와 함께 묶음으로 도착, 예전 로컬 기록은 한 번만 이관,
 *      500 이면 재시도 큐에 남았다가 나중에 도착, 탭을 닫을 때 keepalive 로 도착, 초기화하면 delete_my_data 를 부르고 새 익명 계정,
 *      두 탭이 서버 500 중에 같은 순간 숨겨져 같은 재시도 큐를 함께 써도 기록을 잃지 않고, 다른 탭이 보낸 기록을 다시 보내지 않음
 *  (c) 같은 설정의 개발 서버(React StrictMode 로 effect 가 두 번 도는 상태)에서도 익명 가입은 한 번
 *
 * Playwright 가 필요해요(이 저장소의 의존성은 아니에요). `npm i -g playwright && npx playwright install chromium` 처럼
 * 전역으로 깔려 있으면 찾아 쓰고, PLAYWRIGHT_MODULE=<playwright 패키지 폴더> 로 위치를 줄 수도 있어요.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockSupabase } from "./mock-supabase.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEY = "sb_publishable_smoke_test_key";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const QUEUE_KEY = "trove-events-queue-v1";
const AUTH_KEY = "trove-auth-v1";

const results = [];
function pass(name) {
  results.push(name);
  console.log(`  ✔ ${name}`);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    // 전역 설치를 찾는다
  }
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  if (npmRoot.status === 0) candidates.push(join(npmRoot.stdout.trim(), "playwright"));
  for (const path of (process.env.NODE_PATH ?? "").split(":").filter(Boolean)) candidates.push(join(path, "playwright"));
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return require(candidate);
    } catch {
      // 다음 후보
    }
  }
  return null;
}

function run(command, args, { env, cwd = appRoot } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise(output) : reject(new Error(`${command} ${args.join(" ")} 실패(${code}):\n${output}`))));
  });
}

function baseEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("VITE_SUPABASE_") || name === "VERCEL_GIT_COMMIT_SHA") delete env[name];
  }
  return env;
}

const viteBin = join(appRoot, "node_modules", "vite", "bin", "vite.js");

async function build(outDir, extraEnv) {
  await run(process.execPath, [viteBin, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"], { env: { ...baseEnv(), ...extraEnv } });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

/** dist 폴더를 Vercel 처럼(없는 경로는 index.html) 내준다 */
async function serveStatic(dir) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = join(dir, path);
    try {
      if (!file.startsWith(dir) || !(await stat(file)).isFile()) throw new Error("fallback");
    } catch {
      file = join(dir, "index.html");
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function waitFor(check, { timeout = 15_000, interval = 100, message = "조건" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`${message}: ${timeout}ms 안에 되지 않았어요`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

const ONBOARDED_STATE = {
  onboardingComplete: true,
  interests: [],
  favorites: [],
  alerts: {},
  notificationsSeenAt: null,
  notificationsSeenIds: [],
  user: null,
  settings: { defaultAlerts: ["D-1", "D-Day"], weeklyDigest: true, notificationPermission: "default" },
};

const LEGACY_EVENTS = [
  { name: "home_view", at: "2026-10-01T01:00:00.000Z" },
  { name: "discover_search", at: "2026-10-01T01:01:00.000Z", properties: { query: "예전 검색" } },
  { name: "add_to_trove", at: "2026-10-01T01:02:00.000Z", properties: { item_id: "x", surface: "home" } },
];

/** 처음 열 때만: 온보딩을 마친 상태 + (원하면) 예전 버전이 남긴 로컬 기록 */
async function newContext(browser, { legacy = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  await context.addInitScript(
    ({ state, legacyEvents }) => {
      if (!localStorage.getItem("smoke-seeded")) {
        localStorage.setItem("smoke-seeded", "1");
        localStorage.setItem("trove-demo-state-v3", JSON.stringify(state));
        if (legacyEvents) localStorage.setItem("trove-analytics-v1", JSON.stringify(legacyEvents));
      }
    },
    { state: ONBOARDED_STATE, legacyEvents: legacy ? LEGACY_EVENTS : null },
  );
  return context;
}

function watchRequests(context) {
  const urls = [];
  context.on("request", (request) => urls.push(request.url()));
  return urls;
}

async function openHome(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${url}/home`);
  await page.waitForSelector(".feed", { timeout: 15_000 });
  return { page, errors };
}

async function supabaseChunk(distDir) {
  for (const name of await readdir(join(distDir, "assets"))) {
    if (name.endsWith(".js") && (await readFile(join(distDir, "assets", name), "utf8")).includes("GoTrueClient")) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------

async function localOnly(chromium, work) {
  console.log("\n(a) 로컬 전용 모드(환경 변수 없음)");
  const dist = join(work, "dist-local");
  await build(dist, {});
  const site = await serveStatic(dist);
  const browser = await chromium.launch();
  try {
    const chunk = await supabaseChunk(dist);
    assert.ok(chunk, "Supabase 코드는 따로 떨어진 파일이어야 해요");
    const context = await newContext(browser);
    const urls = watchRequests(context);
    const { page, errors } = await openHome(context, site.url);
    pass("앱이 뜨고 홈 피드가 그려진다");
    await page.click(".category-strip [role=tab] >> nth=1");
    await page.waitForTimeout(4_000); // 3초 묶음 시간이 지나도
    const origin = new URL(site.url).origin;
    const foreign = urls.filter((u) => !u.startsWith("data:") && new URL(u).origin !== origin);
    assert.deepEqual(foreign, [], "다른 출처로 간 요청");
    pass(`요청 ${urls.length}개가 모두 같은 사이트(다른 호스트 0개)`);
    assert.ok(!urls.some((u) => u.includes(chunk)), "Supabase 파일을 내려받으면 안 돼요");
    pass("Supabase 코드 파일을 내려받지 않는다");
    const log = JSON.parse((await page.evaluate(() => localStorage.getItem("trove-analytics-v1"))) ?? "[]");
    assert.deepEqual(log.map((e) => e.name).slice(0, 3), ["app_open", "home_view", "category_selected"]);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), QUEUE_KEY), null);
    pass("사용 기록은 예전처럼 이 기기의 trove-analytics-v1 에만(app_open·home_view·category_selected)");
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await site.close();
  }
}

function eventsOf(mock, userId) {
  return mock.state.events.filter((e) => e.user_id === userId);
}

/** 이관된 예전 기록을 뺀, 이번에 생긴 기록 */
function liveEventsOf(mock, userId) {
  return eventsOf(mock, userId).filter((e) => e.properties.migrated !== true);
}

async function serverMode(chromium, work, mock) {
  console.log("\n(b) 서버 모드(가짜 Supabase)");
  const dist = join(work, "dist-server");
  await build(dist, { VITE_SUPABASE_URL: mock.url, VITE_SUPABASE_PUBLISHABLE_KEY: KEY, VERCEL_GIT_COMMIT_SHA: COMMIT });
  const site = await serveStatic(dist);
  const browser = await chromium.launch();
  const allowed = new Set([new URL(site.url).origin, new URL(mock.url).origin]);
  try {
    // --- 첫 방문: 익명 가입 한 번, 묶음 전송, 공통 필드, 예전 기록 이관
    const context = await newContext(browser, { legacy: true });
    const urls = watchRequests(context);
    const first = await openHome(context, site.url);
    await waitFor(() => mock.state.events.length >= 5, { message: "첫 기록 5개(이관 3 + app_open + home_view)" });
    assert.equal(mock.state.signups.length, 1);
    const user1 = mock.state.signups[0].id;
    pass("첫 방문에 익명 가입 1번, 세션이 생긴 뒤 기록 도착");

    const sent = eventsOf(mock, user1);
    const open = sent.find((e) => e.name === "app_open" && !e.properties.migrated);
    const home = sent.find((e) => e.name === "home_view" && !e.properties.migrated);
    assert.ok(open && home);
    for (const row of [open, home]) {
      assert.match(row.client_event_id, /^[0-9a-f-]{36}$/);
      assert.match(row.device_id, /^[0-9a-f-]{36}$/);
      assert.match(row.session_id, /^[0-9a-f-]{36}$/);
      assert.equal(row.path, "/home");
      assert.equal(row.display_mode, "browser");
      assert.equal(row.app_version, COMMIT.slice(0, 7));
      assert.equal(row.os, "other");
      assert.equal(row.browser, "chrome");
      assert.equal(row.in_app, null);
      assert.ok(!Number.isNaN(Date.parse(row.client_at)));
    }
    assert.equal(open.properties.display_mode, "browser");
    assert.equal(open.device_id, home.device_id);
    assert.equal(open.session_id, home.session_id);
    pass("공통 필드: device_id·session_id·path·display_mode·app_version(커밋 7자리)·os·browser·in_app·client_at, user_id 는 안 보냄");

    const firstBatch = mock.state.eventRequests.find((r) => r.status === 201);
    assert.ok(firstBatch.count >= 2, `첫 요청에 ${firstBatch.count}개`);
    assert.ok(mock.state.eventRequests.filter((r) => r.status === 201).length < sent.length);
    pass(`묶어서 보낸다(첫 요청 ${firstBatch.count}개, 요청 ${mock.state.eventRequests.length}번에 기록 ${sent.length}개)`);

    const migrated = sent.filter((e) => e.properties.migrated === true);
    assert.deepEqual(migrated.map((e) => e.name), LEGACY_EVENTS.map((e) => e.name));
    assert.deepEqual(migrated.map((e) => e.client_at), LEGACY_EVENTS.map((e) => e.at));
    assert.equal(await first.page.evaluate(() => localStorage.getItem("trove-analytics-v1")), null);
    pass("예전 로컬 기록 3개를 migrated = true 로 한 번 올리고 로컬 키를 지운다");

    // --- 새로고침 두 번 + 같은 브라우저에 탭 하나 더: 가입은 그대로 1번, 이관도 다시 안 함
    await first.page.reload();
    await first.page.waitForSelector(".feed");
    await first.page.reload();
    await first.page.waitForSelector(".feed");
    const second = await openHome(context, site.url);
    await waitFor(() => eventsOf(mock, user1).filter((e) => e.name === "app_open").length >= 4, { message: "app_open 4개" });
    assert.equal(mock.state.signups.length, 1);
    assert.equal(eventsOf(mock, user1).filter((e) => e.properties.migrated).length, 3);
    pass("새로고침 2번 + 탭 하나 더: 익명 가입은 여전히 1번, 이관도 한 번만");
    await second.page.close();

    // --- 500 이면 재시도 큐에 남았다가 나중에 도착 (검색어는 100자로)
    mock.state.failEvents = true;
    const failedBefore = mock.state.eventRequests.filter((r) => r.status === 500).length;
    const page = first.page;
    await page.goto(`${site.url}/discover`);
    const query = "가나다라마바사아자차".repeat(15);
    await page.fill('input[placeholder="영화, 게임, 아티스트 검색"]', query);
    const readQueue = async () => JSON.parse((await page.evaluate((k) => localStorage.getItem(k), QUEUE_KEY)) ?? "[]");
    // 검색 450ms 뒤 기록 → 3초 뒤 보내기 시도(500) → 재시도 큐에 남는다
    await waitFor(async () => (await readQueue()).some((e) => e.name === "discover_search"), { message: "재시도 큐에 discover_search" });
    const failedAt = mock.state.eventRequests.length;
    await waitFor(() => mock.state.eventRequests.slice(failedAt - 1).some((r) => r.status === 500) && mock.state.eventRequests.filter((r) => r.status === 500).length > failedBefore, { message: "500 응답" });
    assert.ok(!liveEventsOf(mock, user1).some((e) => e.name === "discover_search"), "500 동안에는 들어가지 않았다");
    const queued = await readQueue();
    pass(`500 을 받으면 기록이 localStorage 재시도 큐에 남는다(${queued.length}개)`);
    mock.state.failEvents = false;
    const search = await waitFor(() => liveEventsOf(mock, user1).find((e) => e.name === "discover_search"), { timeout: 30_000, message: "재시도 뒤 도착" });
    assert.equal(Array.from(search.properties.query).length, 100);
    assert.equal(search.path, "/discover");
    await waitFor(async () => (await page.evaluate((k) => localStorage.getItem(k), QUEUE_KEY)) === null, { message: "큐 비우기" });
    pass("서버가 돌아오면 다시 보내 도착하고 큐가 빈다. 검색어는 앞 100자만");

    // --- 탭을 닫을 때(pagehide): 3초를 기다리지 않고 keepalive 로 보낸다
    const closing = await openHome(context, site.url);
    await waitFor(() => liveEventsOf(mock, user1).filter((e) => e.name === "home_view").length >= 5, { message: "새 탭 home_view" });
    await closing.page.waitForTimeout(3_500);
    const before = eventsOf(mock, user1).filter((e) => e.name === "category_selected").length;
    await closing.page.click(".category-strip [role=tab] >> nth=2");
    await closing.page.close({ runBeforeUnload: true });
    await waitFor(() => eventsOf(mock, user1).filter((e) => e.name === "category_selected").length > before, { timeout: 5_000, message: "닫힌 탭의 기록" });
    pass("탭을 닫는 순간의 기록도 keepalive 요청으로 도착한다");

    // --- MVP 데이터 초기화: delete_my_data → 로그아웃 → 다음 기록 때 새 익명 계정
    const deviceBefore = eventsOf(mock, user1).at(-1).device_id;
    await page.goto(`${site.url}/profile`);
    await page.getByRole("button", { name: /MVP 데이터 초기화/ }).click();
    await page.getByRole("button", { name: "모두 초기화" }).click();
    await waitFor(() => mock.state.rpcCalls.length === 1, { message: "delete_my_data 호출" });
    assert.deepEqual(mock.state.rpcCalls[0], { name: "delete_my_data", userId: user1 });
    await waitFor(() => mock.state.logouts.length === 1, { message: "로그아웃" });
    assert.equal(eventsOf(mock, user1).length, 0, "가짜 서버에서 옛 계정 기록이 지워졌다");
    await waitFor(async () => (await page.evaluate((k) => localStorage.getItem(k), AUTH_KEY)) === null, { message: "세션 지움" });
    pass("초기화: delete_my_data 를 옛 계정으로 부르고 로그아웃한다(가짜 서버의 옛 기록 0개)");
    await page.goto(`${site.url}/home`);
    await page.waitForSelector(".feed");
    await waitFor(() => mock.state.signups.length === 2, { message: "새 익명 가입" });
    const user2 = mock.state.signups[1].id;
    const fresh = await waitFor(() => eventsOf(mock, user2).find((e) => e.name === "app_open"), { message: "새 계정 기록" });
    assert.notEqual(user2, user1);
    assert.notEqual(fresh.device_id, deviceBefore, "기기 id 도 새로");
    assert.equal(eventsOf(mock, user1).length, 0, "옛 계정으로는 더 가지 않는다");
    pass("초기화 뒤 다음 기록 때 새 익명 계정 하나를 만들고 그쪽으로 보낸다(기기 id 도 새로)");

    // --- 처음 보는 브라우저에서 탭 두 개를 동시에 열어도 가입은 한 번
    const twin = await newContext(browser);
    const twinUrls = watchRequests(twin);
    const signupsBefore = mock.state.signups.length;
    const twinTabs = (await Promise.all([openHome(twin, site.url), openHome(twin, site.url)])).map((tab) => tab.page);
    await waitFor(() => mock.state.signups.length > signupsBefore, { message: "가입" });
    await new Promise((r) => setTimeout(r, 4_000));
    assert.equal(mock.state.signups.length, signupsBefore + 1);
    const twinUser = mock.state.signups.at(-1).id;
    await waitFor(() => eventsOf(mock, twinUser).filter((e) => e.name === "app_open").length === 2, { message: "두 탭의 app_open" });
    pass("새 브라우저에서 두 탭을 동시에 열어도 익명 가입은 1번(두 탭 기록이 같은 계정으로)");

    // --- 두 탭이 같은 순간 숨겨지며(서버 500) 같은 재시도 큐를 함께 써도, 서버가 돌아오면 두 탭 기록이 모두 한 번씩 도착
    mock.state.failEvents = true;
    const rounds = 12;
    for (let i = 0; i < rounds; i += 1) {
      await Promise.all(twinTabs.map((tab) => tab.click(`.category-strip [role=tab] >> nth=${1 + (i % 3)}`)));
      await Promise.all(twinTabs.map((tab) => tab.evaluate(() => window.dispatchEvent(new Event("pagehide")))));
      await new Promise((r) => setTimeout(r, 150));
    }
    mock.state.failEvents = false;
    const requestsBefore = mock.state.eventRequests.length;
    await Promise.all(twinTabs.map((tab) => tab.evaluate(() => window.dispatchEvent(new Event("online")))));
    const selected = () => eventsOf(mock, twinUser).filter((e) => e.name === "category_selected");
    await waitFor(() => selected().length >= rounds * 2, { timeout: 30_000, message: `두 탭의 category_selected ${rounds * 2}개(지금 ${selected().length}개)` });
    await waitFor(async () => (await twinTabs[0].evaluate((k) => localStorage.getItem(k), QUEUE_KEY)) === null, { message: "두 탭 큐 비우기" });
    assert.equal(selected().length, rounds * 2);
    assert.equal(new Set(selected().map((e) => e.client_event_id)).size, rounds * 2);
    pass(`두 탭이 서버 500 중에 동시에 숨겨져도 기록을 잃지 않는다(${rounds * 2}개 모두 한 번씩 도착)`);
    // 한 탭이 두 탭 몫을 보내면, 다른 탭은 그 행을 다시 보내지 않는다(예전에는 409 → 반씩 나눠 2N-1 번, 409 가 20번 넘게)
    await new Promise((r) => setTimeout(r, 3_000));
    const afterOnline = mock.state.eventRequests.slice(requestsBefore).filter((r) => r.userId === twinUser);
    const duplicates = afterOnline.filter((r) => r.status === 409);
    const shape = JSON.stringify(afterOnline.map((r) => [r.status, r.count]));
    assert.ok(duplicates.length <= 2, `이미 들어간 기록을 다시 보낸 요청 ${duplicates.length}번: ${shape}`);
    pass(`그때 다른 탭이 이미 보낸 기록은 다시 보내지 않는다(온라인 복귀 뒤 요청 ${afterOnline.length}번, 409 ${duplicates.length}번)`);

    const foreign = [...urls, ...twinUrls].filter((u) => !u.startsWith("data:") && !allowed.has(new URL(u).origin));
    assert.deepEqual(foreign, []);
    assert.deepEqual(mock.state.unknown, [], "흉내 내지 않은 엔드포인트 호출");
    pass("앱 사이트와 Supabase 말고는 요청하지 않고, 쓰는 엔드포인트는 signup·events·rpc/delete_my_data·logout 뿐");
    assert.deepEqual([...first.errors], []);
    await twin.close();
    await context.close();
  } finally {
    await browser.close();
    await site.close();
  }
}

async function devStrictMode(chromium, mock) {
  console.log("\n(c) 개발 서버(StrictMode)");
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: appRoot,
    env: { ...baseEnv(), VITE_SUPABASE_URL: mock.url, VITE_SUPABASE_PUBLISHABLE_KEY: KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    await waitFor(async () => (await fetch(url).catch(() => null))?.ok, { timeout: 30_000, message: `개발 서버 시작\n${output}` });
    const context = await newContext(browser);
    const before = mock.state.signups.length;
    const { page } = await openHome(context, url);
    await waitFor(() => mock.state.signups.length > before, { message: "가입" });
    const user = mock.state.signups.at(-1).id;
    await waitFor(() => eventsOf(mock, user).some((e) => e.name === "home_view"), { message: "home_view" });
    await page.reload();
    await page.waitForSelector(".feed");
    await new Promise((r) => setTimeout(r, 4_000));
    assert.equal(mock.state.signups.length, before + 1);
    const opens = eventsOf(mock, user).filter((e) => e.name === "app_open").length;
    assert.equal(opens, 2, "app_open 은 페이지를 열 때마다 한 번(StrictMode 에서도)");
    pass(`StrictMode 개발 서버 + 새로고침: 익명 가입 1번, app_open 은 페이지 로드당 1번(home_view ${eventsOf(mock, user).filter((e) => e.name === "home_view").length}개는 StrictMode 이중 effect)`);
    await context.close();
  } finally {
    await browser.close();
    child.kill("SIGTERM");
  }
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.log("Playwright 를 찾지 못했어요. `npm i -g playwright` 뒤 `npx playwright install chromium` 을 하거나 PLAYWRIGHT_MODULE 로 위치를 알려 주세요.");
    process.exit(2);
  }
  const work = await mkdtemp(join(tmpdir(), "trove-smoke-"));
  const mock = await startMockSupabase({ key: KEY });
  try {
    await localOnly(playwright.chromium, work);
    await serverMode(playwright.chromium, work, mock);
    await devStrictMode(playwright.chromium, mock);
    console.log(`\n스모크 통과: ${results.length}개 확인`);
  } finally {
    await mock.close();
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n스모크 실패: ${error?.stack ?? error}`);
  process.exit(1);
});

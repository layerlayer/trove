/**
 * src/lib/analytics-core.ts 시험(사용 기록 큐·묶어 보내기·재시도·세션·브라우저 요약·이관·초기화 흐름).
 * Node 의 타입 지우기로 .ts 를 그대로 불러온다(Node 22.18+ / 24). DOM·Vite·네트워크 없이 돈다:
 * 타이머는 가짜 시계, 보내기는 가짜 서버(같은 client_event_id 는 409, 계정별로 모음)로 바꿔 끼운다.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BATCH_MAX,
  capQueue,
  classifyResponse,
  createAnalytics,
  createEventPipeline,
  createMemoryStore,
  createRow,
  DEVICE_KEY,
  displayModeOf,
  FLUSH_DEBOUNCE_MS,
  FLUSH_MAX_WAIT_MS,
  KEEPALIVE_MAX_BYTES,
  LEGACY_KEY,
  migrationFlagKey,
  nextSession,
  QUEUE_KEY,
  QUEUE_MAX,
  readQueue,
  RESET_PENDING_KEY,
  resolveServerConfig,
  sanitizeProperties,
  SENT_KEY,
  SESSION_IDLE_MS,
  summarizeBrowser,
  tokenSubject,
  truncateChars,
  UNCONFIRMED_KEY,
  uuidFromBytes,
  writeQueue,
} from "../../src/lib/analytics-core.ts";

// ---------------------------------------------------------------------------
// 도우미

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakeClock(start = Date.parse("2026-10-22T00:00:00Z")) {
  let now = start;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    timers: {
      set(callback, ms) {
        seq += 1;
        pending.set(seq, { at: now + ms, callback });
        return seq;
      },
      clear(id) {
        pending.delete(id);
      },
    },
    /** ms 만큼 시간을 보내며 그 사이 타이머를 순서대로 실행한다 */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
    delays: () => [...pending.values()].map((entry) => entry.at - now).sort((a, b) => a - b),
  };
}

let counter = 0;
function id() {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function row(name = "home_view", extra = {}) {
  return createRow(name, extra.properties ?? {}, {
    now: extra.now ?? Date.parse("2026-10-22T00:00:00Z"),
    clientEventId: extra.clientEventId ?? id(),
    deviceId: "device-1",
    sessionId: "session-1",
    path: "/home",
    displayMode: "browser",
    appVersion: "abc1234",
    client: { os: "ios", browser: "safari", in_app: null },
  });
}

/** 서명 없는 가짜 JWT(sub 만 읽는다) */
function jwt(sub) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, role: "authenticated" })}.sig`;
}

/** navigator.locks 처럼 한 번에 하나씩(여러 탭이 함께 쓰는 잠금) */
function serialLock() {
  let chain = Promise.resolve();
  return (task) => {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  };
}

/** 가짜 Supabase events 표: 토큰별(=계정별)로 모으고, 같은 client_event_id 는 409 */
function fakeServer() {
  const server = {
    status: 201,
    code: null,
    calls: [],
    byToken: new Map(),
    rejectNames: new Set(),
    async post(rows, token, keepalive) {
      server.calls.push({ count: rows.length, token, keepalive, ids: rows.map((r) => r.client_event_id) });
      if (server.status !== 201) return { status: server.status, code: server.code };
      if (rows.some((r) => server.rejectNames.has(r.name))) return { status: 400, code: "23514" };
      const stored = server.byToken.get(token) ?? [];
      if (rows.some((r) => stored.some((s) => s.client_event_id === r.client_event_id))) return { status: 409, code: "23505" };
      stored.push(...rows);
      server.byToken.set(token, stored);
      return { status: 201 };
    },
    received(token = "token-1") {
      return server.byToken.get(token) ?? [];
    },
  };
  return server;
}

function pipelineWith(overrides = {}) {
  const clock = fakeClock();
  const store = createMemoryStore();
  const server = fakeServer();
  let token = "token-1";
  let held = false;
  const pipeline = createEventPipeline({
    store,
    timers: clock.timers,
    getToken: async () => token,
    peekToken: () => token,
    post: (...args) => server.post(...args),
    isHeld: () => held,
    ...overrides,
  });
  return {
    clock,
    store,
    server,
    pipeline,
    setToken: (value) => (token = value),
    setHeld: (value) => (held = value),
  };
}

/**
 * 한 브라우저의 탭들이 함께 쓰는 localStorage 흉내(Chromium 처럼). 탭(view)마다 캐시를 따로 두고, 다른 탭의 쓰기는
 * deliver() 를 불러야 보인다. 브라우저 쪽 값은 도착한 순서대로 마지막 쓰기가 이기고, 아직 보내지 않은 자기 쓰기가 있는
 * 키에는 다른 탭의 앞선 쓰기를 덮어씌우지 않는다. 그래서 시간에 기대지 않고 "옛 캐시로 덮어쓰기"를 그대로 만든다.
 */
function sharedStorage() {
  const backend = new Map();
  const views = [];
  let pending = [];
  function view() {
    const cache = new Map(backend);
    const self = {
      cache,
      getItem: (key) => cache.get(key) ?? null,
      setItem(key, value) {
        cache.set(key, String(value));
        pending.push({ from: self, key, value: String(value) });
      },
      removeItem(key) {
        cache.delete(key);
        pending.push({ from: self, key, value: null });
      },
    };
    views.push(self);
    return self;
  }
  function deliver() {
    const batch = pending;
    pending = [];
    batch.forEach(({ from, key, value }, index) => {
      if (value === null) backend.delete(key);
      else backend.set(key, value);
      for (const other of views) {
        if (other === from || batch.slice(index + 1).some((later) => later.from === other && later.key === key)) continue;
        if (value === null) other.cache.delete(key);
        else other.cache.set(key, value);
      }
    });
  }
  /** 브라우저 쪽에 실제로 남은 큐(새 탭이 보는 값) */
  const stored = () => readQueue({ getItem: (key) => backend.get(key) ?? null, setItem() {}, removeItem() {} });
  return { view, deliver, stored };
}

// ---------------------------------------------------------------------------

describe("큐", () => {
  test("500개를 넘으면 오래된 것부터 버린다", () => {
    assert.deepEqual(capQueue([1, 2, 3, 4], 3), [2, 3, 4]);
    const store = createMemoryStore();
    const rows = Array.from({ length: QUEUE_MAX + 10 }, () => row());
    writeQueue(store, rows);
    const kept = readQueue(store);
    assert.equal(kept.length, QUEUE_MAX);
    assert.equal(kept[0].client_event_id, rows[10].client_event_id);
    assert.equal(kept.at(-1).client_event_id, rows.at(-1).client_event_id);
  });

  test("깨진 저장값은 빈 큐로 읽고, 비우면 키를 지운다", () => {
    const store = createMemoryStore();
    store.setItem(QUEUE_KEY, "{not json");
    assert.deepEqual(readQueue(store), []);
    store.setItem(QUEUE_KEY, JSON.stringify([{ nope: true }, row()]));
    assert.equal(readQueue(store).length, 1);
    writeQueue(store, []);
    assert.equal(store.getItem(QUEUE_KEY), null);
  });
});

describe("묶어 보내기", () => {
  test("기록 직후에는 보내지 않고, 마지막 기록 3초 뒤 한 요청으로 보낸다", async () => {
    const { clock, server, pipeline } = pipelineWith();
    pipeline.enqueue(row("app_open"));
    pipeline.enqueue(row("home_view"));
    await clock.advance(FLUSH_DEBOUNCE_MS - 1);
    assert.equal(server.calls.length, 0);
    await clock.advance(1);
    assert.deepEqual(server.calls.map((call) => [call.count, call.keepalive]), [[2, false]]);
    assert.deepEqual(server.received().map((r) => r.name), ["app_open", "home_view"]);
    assert.equal(pipeline.pendingCount(), 0);
  });

  test("기록이 계속 이어져도 첫 기록 뒤 15초 안에는 보낸다", async () => {
    const { clock, server, pipeline } = pipelineWith();
    for (let elapsed = 0; elapsed < FLUSH_MAX_WAIT_MS; elapsed += 2_000) {
      pipeline.enqueue(row());
      await clock.advance(2_000);
      if (elapsed + 2_000 < FLUSH_MAX_WAIT_MS) assert.equal(server.calls.length, 0, `${elapsed + 2_000}ms 에는 아직`);
    }
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0].count, 8);
  });

  test("100개가 모이면 기다리지 않고 바로 보낸다", async () => {
    const { server, pipeline } = pipelineWith();
    for (let i = 0; i < BATCH_MAX; i += 1) pipeline.enqueue(row());
    await settle();
    assert.deepEqual(server.calls.map((call) => call.count), [BATCH_MAX]);
  });

  test("밀린 250개는 100·100·50 으로 나눠 보낸다", async () => {
    const { store, server, pipeline } = pipelineWith();
    writeQueue(store, Array.from({ length: 250 }, () => row()));
    await pipeline.flush();
    assert.deepEqual(server.calls.map((call) => call.count), [100, 100, 50]);
    assert.equal(server.received().length, 250);
  });
});

describe("세션이 없을 때 · 실패했을 때", () => {
  test("세션(토큰)이 생길 때까지 저장 큐에서 기다렸다가 보낸다", async () => {
    const { clock, store, server, pipeline, setToken } = pipelineWith();
    setToken(null);
    pipeline.enqueue(row("app_open"));
    await clock.advance(FLUSH_DEBOUNCE_MS);
    assert.equal(server.calls.length, 0);
    assert.equal(readQueue(store).length, 1, "보내기 전에 localStorage 큐로 옮겨 둔다");
    setToken("token-1");
    await clock.advance(5_000); // 첫 재시도
    assert.equal(server.received().length, 1);
    assert.equal(store.getItem(QUEUE_KEY), null);
  });

  test("500 이 오면 저장 큐에 남기고 5초·15초… 뒤 다시 보내 결국 도착한다", async () => {
    const { clock, store, server, pipeline } = pipelineWith();
    server.status = 500;
    pipeline.enqueue(row("item_view"));
    await clock.advance(FLUSH_DEBOUNCE_MS);
    assert.equal(server.calls.length, 1);
    assert.equal(readQueue(store).length, 1);
    assert.deepEqual(clock.delays(), [5_000]);
    await clock.advance(5_000);
    assert.equal(server.calls.length, 2);
    assert.deepEqual(clock.delays(), [15_000]);
    server.status = 201;
    await clock.advance(15_000);
    assert.deepEqual(server.received().map((r) => r.name), ["item_view"]);
    assert.equal(readQueue(store).length, 0);
  });

  test("계속 실패하면 저장 큐는 500개에서 멈추고 오래된 것부터 버린다", async () => {
    const { store, server, pipeline } = pipelineWith();
    server.status = 503;
    const rows = Array.from({ length: 620 }, (_, i) => row("feed_more", { properties: { i } }));
    for (const r of rows) pipeline.enqueue(r);
    await settle();
    await pipeline.flush();
    const kept = readQueue(store);
    assert.equal(kept.length, QUEUE_MAX);
    assert.equal(kept[0].properties.i, 120);
    assert.equal(kept.at(-1).properties.i, 619);
  });

  test("이미 들어간 기록(409)은 반으로 나눠 다시 보내 중복만 버린다", async () => {
    const { store, server, pipeline } = pipelineWith();
    const already = row("app_open");
    await server.post([already], "token-1", false);
    server.calls.length = 0;
    writeQueue(store, [row("home_view"), already, row("item_view"), row("feed_more")]);
    await pipeline.flush();
    assert.deepEqual(server.received().map((r) => r.name).sort(), ["app_open", "feed_more", "home_view", "item_view"]);
    assert.equal(server.received().length, 4, "app_open 이 두 번 들어가지 않는다");
    assert.equal(readQueue(store).length, 0);
  });

  test("409 라도 23503(대시보드에서 지운 계정의 토큰)이면 버리지 않고 나중에 다시 보낸다", async () => {
    const { clock, store, server, pipeline, setToken } = pipelineWith();
    server.status = 409;
    server.code = "23503";
    writeQueue(store, [row("home_view"), row("item_view"), row("feed_more")]);
    await pipeline.flush();
    assert.equal(server.calls.length, 1, "나눠 보내지 않는다");
    assert.equal(readQueue(store).length, 3, "버리지 않는다");
    server.status = 201;
    server.code = null;
    setToken("token-2"); // 토큰이 끝나고 새 익명 계정
    await clock.advance(5_000);
    assert.deepEqual(server.received("token-2").map((r) => r.name), ["home_view", "item_view", "feed_more"]);
    assert.equal(readQueue(store).length, 0);
  });

  test("DB 제한에 걸리는 행(400·23514)만 버리고 나머지는 보낸다", async () => {
    const { store, server, pipeline } = pipelineWith();
    server.rejectNames.add("bad_event");
    writeQueue(store, [row("home_view"), row("bad_event"), row("item_view")]);
    await pipeline.flush();
    assert.deepEqual(server.received().map((r) => r.name), ["home_view", "item_view"]);
    assert.equal(readQueue(store).length, 0);
  });

  test("표가 없거나 스키마가 다르면(404, 400 PGRST…) 버리지 않고 기다린다", () => {
    assert.equal(classifyResponse(201), "ok");
    assert.equal(classifyResponse(409, "23505"), "duplicate");
    assert.equal(classifyResponse(409), "duplicate", "코드 없는 409 도 중복");
    assert.equal(classifyResponse(409, "23503"), "retry", "지운 계정의 토큰(외래 키)은 중복이 아니다");
    assert.equal(classifyResponse(400, "23514"), "reject");
    assert.equal(classifyResponse(400, "22001"), "reject");
    assert.equal(classifyResponse(413), "reject");
    for (const [status, code] of [[0], [400, "PGRST204"], [401, "PGRST301"], [403, "42501"], [404, "PGRST205"], [429], [500], [503]]) {
      assert.equal(classifyResponse(status, code), "retry", `${status} ${code ?? ""}`);
    }
  });
});

describe("화면이 숨겨지거나 닫힐 때", () => {
  test("기다리지 않고 keepalive 요청으로 바로 보내고, 그 전에 저장 큐에 옮겨 둔다", async () => {
    const { store, server, pipeline } = pipelineWith();
    pipeline.enqueue(row("item_view"));
    pipeline.flushOnHide();
    assert.equal(server.calls.length, 1, "같은 틱 안에서 보낸다");
    assert.equal(server.calls[0].keepalive, true);
    assert.equal(readQueue(store).length, 1, "응답 전까지는 큐에 남아 있다(페이지가 죽어도 다음에 보낸다)");
    await settle();
    assert.equal(readQueue(store).length, 0);
    assert.equal(server.received().length, 1);
  });

  test("손에 든 토큰이 없으면 보내지 않고 저장만 한다", () => {
    const { store, server, pipeline } = pipelineWith({ peekToken: () => null });
    pipeline.enqueue(row());
    pipeline.flushOnHide();
    assert.equal(server.calls.length, 0);
    assert.equal(readQueue(store).length, 1);
  });

  test("keepalive 몸통은 60KB 를 넘지 않는다", () => {
    const { store, server, pipeline } = pipelineWith();
    const heavy = Array.from({ length: 80 }, () => row("discover_search", { properties: { a: "가".repeat(200), b: "나".repeat(200) } }));
    writeQueue(store, heavy);
    pipeline.flushOnHide();
    assert.equal(server.calls.length, 1);
    const sent = server.calls[0].count;
    assert.ok(sent < heavy.length, `${sent}개만`);
    const bytes = Buffer.byteLength(JSON.stringify(heavy.slice(0, sent)));
    assert.ok(bytes <= KEEPALIVE_MAX_BYTES, `${bytes} bytes`);
  });

  test("keepalive 응답 전에 페이지가 닫혀도, 다음 시작은 그 행을 새 기록과 섞지 않고 따로 보내 409 가 번지지 않는다", async () => {
    const store = createMemoryStore();
    const server = fakeServer();
    // 첫 페이지: keepalive 는 서버에 닿지만 응답을 받기 전에 페이지가 닫힌다(.then 이 돌지 않음)
    const first = createEventPipeline({
      store,
      timers: fakeClock().timers,
      getToken: async () => "token-1",
      peekToken: () => "token-1",
      post: (rows, token, keepalive) => {
        void server.post(rows, token, keepalive);
        return new Promise(() => {});
      },
      isHeld: () => false,
    });
    first.enqueue(row("tab_a"));
    first.enqueue(row("tab_b"));
    first.flushOnHide();
    await settle();
    assert.equal(server.received().length, 2);
    assert.equal(readQueue(store).length, 2, "결과를 모르니 큐에 남는다");
    assert.equal(JSON.parse(store.getItem(UNCONFIRMED_KEY)).length, 2);

    // 다음 시작: 같은 저장소로 새 파이프라인
    server.calls.length = 0;
    const next = createEventPipeline({
      store,
      timers: fakeClock().timers,
      getToken: async () => "token-1",
      peekToken: () => "token-1",
      post: (...args) => server.post(...args),
      isHeld: () => false,
    });
    next.enqueue(row("app_open"));
    next.flushOnHide(); // 이 keepalive 는 결과 모르는 행을 싣지 않아 통째로 409 가 되지 않는다
    await settle();
    assert.deepEqual(server.calls.map((call) => [call.count, call.keepalive]), [[1, true]]);
    next.enqueue(row("home_view"));
    await next.flush();
    // 새 기록 1개 → 결과 모르는 2개 묶음(409) → 한 행씩(각각 409)
    assert.deepEqual(server.calls.map((call) => [call.count, call.keepalive]), [[1, true], [1, false], [2, false], [1, false], [1, false]]);
    assert.deepEqual(server.received().map((r) => r.name), ["tab_a", "tab_b", "app_open", "home_view"], "두 번 들어가지 않는다");
    assert.equal(readQueue(store).length, 0);
    assert.equal(store.getItem(UNCONFIRMED_KEY), null);
  });

  test("두 탭이 같은 순간 숨겨지며(서버 500) 옛 캐시로 서로의 큐를 덮어써도, 서버가 돌아오면 두 탭 기록이 모두 한 번씩 도착한다", async () => {
    const storage = sharedStorage();
    const server = fakeServer();
    server.status = 500;
    const tab = () =>
      createEventPipeline({
        store: storage.view(),
        timers: fakeClock().timers,
        getToken: async () => "token-1",
        peekToken: () => "token-1",
        post: (...args) => server.post(...args),
        isHeld: () => false,
      });
    const a = tab();
    const b = tab();
    a.enqueue(row("tab_a_1"));
    a.enqueue(row("tab_a_2"));
    b.enqueue(row("tab_b_1"));
    a.flushOnHide(); // 두 탭 모두 서로의 쓰기를 아직 못 본 채 큐를 쓴다
    b.flushOnHide();
    await settle();
    storage.deliver();
    assert.deepEqual(storage.stored().map((r) => r.name), ["tab_b_1"], "나중에 도착한 쓰기가 앞 탭의 행을 덮었다");

    server.status = 201;
    server.calls.length = 0;
    await a.flush();
    storage.deliver();
    await b.flush();
    storage.deliver();
    assert.deepEqual(server.received().map((r) => r.name).sort(), ["tab_a_1", "tab_a_2", "tab_b_1"], "덮어써진 탭이 제 몫을 되살려 보낸다");
    assert.deepEqual(server.calls.map((call) => call.count), [1, 2], "되살린 두 행은 따로 한 묶음, b 는 a 가 보낸 제 행을 다시 보내지 않는다");
    assert.deepEqual(storage.stored(), []);
    assert.equal(a.pendingCount() + b.pendingCount(), 0);
  });

  test("새 브라우저에서 두 탭이 함께 시작해 한 탭이 옛 캐시로 큐를 지워도, 다른 탭의 첫 기록을 잃지 않는다", async () => {
    const storage = sharedStorage();
    const server = fakeServer();
    let chain = Promise.resolve();
    // navigator.locks 처럼 한 번에 한 탭. 잠금을 넘겨받을 즈음엔 앞 탭의 쓰기가 전해져 있다
    const withLock = (task) => {
      const run = chain.then(() => {
        storage.deliver();
        return task();
      });
      chain = run.catch(() => {});
      return run;
    };
    const tab = () =>
      createEventPipeline({
        store: storage.view(),
        timers: fakeClock().timers,
        getToken: async () => "token-1",
        peekToken: () => "token-1",
        post: (...args) => server.post(...args),
        isHeld: () => false,
        withLock,
      });
    const a = tab();
    const b = tab();
    a.enqueue(row("app_open_a"));
    a.enqueue(row("home_view_a"));
    b.enqueue(row("app_open_b"));
    b.enqueue(row("home_view_b"));
    await Promise.all([a.flush(), b.flush()]);
    storage.deliver();
    assert.deepEqual(server.received().map((r) => r.name).sort(), ["app_open_a", "app_open_b", "home_view_a", "home_view_b"]);
    assert.deepEqual(storage.stored(), []);
  });

  test("다른 탭에서 초기화하면, 이 탭이 들고 있던 초기화 전 기록은 큐에 되살리지도 보내지도 않는다", async () => {
    const storage = sharedStorage();
    const server = fakeServer();
    server.status = 500;
    let now = Date.parse("2026-10-22T00:00:00Z");
    const tab = () =>
      createEventPipeline({
        store: storage.view(),
        timers: fakeClock().timers,
        getToken: async () => "token-1",
        peekToken: () => "token-1",
        post: (...args) => server.post(...args),
        isHeld: () => false,
        now: () => now,
      });
    const a = tab();
    const b = tab();
    a.enqueue(row("before_reset", { now }));
    await a.flush(); // 500: 큐에 남고 a 가 들고 있다
    storage.deliver();
    now += 1_000;
    b.clear(); // 다른 탭에서 MVP 데이터 초기화
    storage.deliver();
    server.status = 201;
    a.enqueue(row("after_reset", { now }));
    await a.flush();
    storage.deliver();
    assert.deepEqual(server.received().map((r) => r.name), ["after_reset"]);
    assert.deepEqual(storage.stored(), []);
  });

  test("keepalive 로 실어 보낸 행은 응답 전에 일반 flush 가 또 싣지 않는다", async () => {
    let release;
    const server = fakeServer();
    const { store, pipeline } = pipelineWith({
      post: (rows, token, keepalive) =>
        keepalive ? new Promise((resolve) => (release = () => resolve(server.post(rows, token, keepalive)))) : server.post(rows, token, keepalive),
    });
    pipeline.enqueue(row("a_one"));
    pipeline.flushOnHide();
    await pipeline.flush();
    assert.equal(server.calls.length, 0);
    release();
    await settle();
    assert.equal(server.received().length, 1);
    assert.equal(readQueue(store).length, 0);
  });
});

describe("여러 탭: 다른 탭이 이미 보낸 행", () => {
  function tabOn(store, server, extra = {}) {
    return createEventPipeline({
      store,
      timers: fakeClock().timers,
      getToken: async () => "token-1",
      peekToken: () => "token-1",
      post: (...args) => server.post(...args),
      isHeld: () => false,
      ...extra,
    });
  }

  test("오프라인에서 두 탭이 쌓은 기록을 온라인 복귀 때 함께 보내도, 다른 탭이 보낸 행을 다시 보내지 않는다(요청 2번)", async () => {
    const store = createMemoryStore();
    const server = fakeServer();
    server.status = 0; // 오프라인
    const withLock = serialLock();
    const a = tabOn(store, server, { withLock });
    const b = tabOn(store, server, { withLock });
    for (let i = 0; i < 100; i += 1) b.enqueue(row(`tab_b_${i}`)); // 100개째에 바로 보내려다 실패
    await settle();
    await b.idle();
    for (let i = 0; i < 5; i += 1) a.enqueue(row(`tab_a_${i}`));
    await a.flush();
    assert.equal(readQueue(store).length, 105);

    server.status = 201;
    server.calls.length = 0;
    await Promise.all([a.flush(), b.flush()]); // 두 탭 모두 online 이벤트
    await settle();
    assert.deepEqual(server.calls.map((call) => call.count), [100, 5], "먼저 잠금을 쥔 탭이 두 탭 몫을 다 보내고, 다른 탭은 하나도 다시 보내지 않는다");
    assert.equal(new Set(server.received().map((r) => r.client_event_id)).size, 105);
    assert.equal(server.received().length, 105);
    assert.equal(a.pendingCount() + b.pendingCount(), 0);
  });

  test("잠금이 없어도: 숨겨진 탭의 기록을 다른 탭이 보내면, 그 탭은 돌아와서 다시 보내지 않는다", async () => {
    const store = createMemoryStore();
    const server = fakeServer();
    server.status = 500;
    const a = tabOn(store, server);
    const b = tabOn(store, server);
    for (let i = 0; i < 40; i += 1) b.enqueue(row(`tab_b_${i}`));
    b.flushOnHide(); // 500
    await settle();
    server.status = 201;
    server.calls.length = 0;
    a.enqueue(row("tab_a_1"));
    a.enqueue(row("tab_a_2"));
    await a.flush();
    assert.deepEqual(server.calls.map((call) => call.count), [42]);
    await b.flush(); // b 가 다시 보인다
    assert.equal(server.calls.length, 1, "b 는 이미 들어간 제 행을 다시 보내지 않는다");
    assert.equal(server.received().length, 42);
    assert.equal(b.pendingCount(), 0);
  });

  test("다른 탭이 보낸 표시까지 지워져 제 행을 되살려도, 새 기록과 섞지 않고 409 면 한 행씩 보내 반씩 나누는 일이 번지지 않는다", async () => {
    const store = createMemoryStore();
    const server = fakeServer();
    server.status = 500;
    const a = tabOn(store, server);
    const b = tabOn(store, server);
    ["tab_b_1", "tab_b_2", "tab_b_3"].forEach((name) => b.enqueue(row(name)));
    await b.flush(); // 500
    server.status = 201;
    await a.flush(); // a 가 b 의 세 행을 보낸다
    assert.equal(server.received().length, 3);
    store.removeItem(SENT_KEY); // 다른 탭의 옛 캐시 쓰기가 보낸 표시를 덮었다고 치자
    server.calls.length = 0;
    b.enqueue(row("tab_b_new"));
    await b.flush();
    // 새 기록 1개, 되살린 3개 묶음(409), 그 3개를 한 행씩. 예전처럼 네 행을 한 묶음에 실으면 409 → 반씩 나눠 7번
    assert.deepEqual(server.calls.map((call) => call.count), [1, 3, 1, 1, 1]);
    assert.deepEqual(server.received().map((r) => r.name), ["tab_b_1", "tab_b_2", "tab_b_3", "tab_b_new"]);
    assert.equal(b.pendingCount(), 0);
    assert.equal(store.getItem(UNCONFIRMED_KEY), null);
  });

  test("계정이 바뀐 뒤에는 큐에서 빠진 제 행을 되살리지 않는다(다른 탭이 옛 계정으로 보냈을 수 있다)", async () => {
    assert.equal(tokenSubject(jwt("user-1")), "user-1");
    assert.equal(tokenSubject("token-1"), null);
    assert.equal(tokenSubject("a.%%%.c"), null);
    const store = createMemoryStore();
    const server = fakeServer();
    server.status = 500;
    const user1 = jwt("user-1");
    const user2 = jwt("user-2");
    let token = user1;
    const getToken = async () => token;
    const peekToken = () => token;
    const a = tabOn(store, server, { getToken, peekToken });
    const b = tabOn(store, server, { getToken, peekToken });
    ["tab_b_1", "tab_b_2"].forEach((name) => b.enqueue(row(name)));
    await b.flush(); // user-1 로 보내려다 500
    server.status = 201;
    await a.flush(); // a 가 user-1 로 보낸다
    assert.equal(server.received(user1).length, 2);
    store.removeItem(SENT_KEY);
    token = user2; // 세션을 잃어 새 익명 계정
    server.calls.length = 0;
    b.enqueue(row("after_switch"));
    await b.flush();
    assert.deepEqual(server.received(user2).map((r) => r.name), ["after_switch"], "옛 계정으로 들어간 행이 새 계정에 또 들어가지 않는다");
    assert.deepEqual(server.calls.map((call) => call.count), [1]);
    assert.equal(b.pendingCount(), 0);
  });
});

describe("세션 id · 공통 필드", () => {
  test("30분 넘게 조용하면 새 세션, 그 안이면 같은 세션", () => {
    const first = nextSession(null, 1_000, () => "s1");
    assert.deepEqual(first, { id: "s1", lastAt: 1_000 });
    const same = nextSession(first, 1_000 + SESSION_IDLE_MS - 1, () => "s2");
    assert.equal(same.id, "s1");
    const rotated = nextSession(same, same.lastAt + SESSION_IDLE_MS, () => "s3");
    assert.equal(rotated.id, "s3");
  });

  test("브라우저 요약: OS·브라우저 계열·앱 안 브라우저만", () => {
    const cases = [
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", 5, ["ios", "safari", null]],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", 5, ["ios", "safari", null]],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15", 5, ["ios", "safari", null]],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15", 0, ["mac", "safari", null]],
      ["Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", 5, ["android", "chrome", null]],
      ["Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36", 5, ["android", "samsung", null]],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 25.8.0", 5, ["ios", "safari", "kakaotalk"]],
      ["Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36 KAKAOTALK/25.8.0 (INAPP)", 5, ["android", "chrome", "kakaotalk"]],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0", 5, ["ios", "safari", "instagram"]],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.10.1)", 5, ["ios", "safari", "naver"]],
      ["Mozilla/5.0 (Linux; Android 14; SM-S921N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36", 5, ["android", "chrome", "webview"]],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", 0, ["windows", "edge", null]],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Whale/4.33.0 Safari/537.36", 0, ["windows", "whale", null]],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15", 5, ["ios", "firefox", null]],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0", 0, ["other", "firefox", null]],
      ["", 0, ["other", "other", null]],
    ];
    for (const [ua, touch, [os, browser, inApp]] of cases) {
      assert.deepEqual(summarizeBrowser(ua, touch), { os, browser, in_app: inApp }, ua);
    }
  });

  test("화면 모드: standalone(홈 화면 앱) / browser", () => {
    assert.equal(displayModeOf(true, undefined), "standalone");
    assert.equal(displayModeOf(false, true), "standalone");
    assert.equal(displayModeOf(false, false), "browser");
    assert.equal(displayModeOf(false, undefined), "browser");
  });

  test("검색어는 100자(글자 단위, 이모지가 반쪽 나지 않게), 다른 문자열은 200자에서 자른다", () => {
    const query = "🎵".repeat(60) + "가".repeat(80);
    const cleaned = sanitizeProperties("discover_search", { query, other: "x".repeat(300) });
    assert.equal(Array.from(cleaned.query).length, 100);
    assert.equal(cleaned.query, "🎵".repeat(60) + "가".repeat(40));
    assert.equal(cleaned.other.length, 200);
    assert.equal(sanitizeProperties("item_view", { query: "y".repeat(150) }).query.length, 150, "다른 이벤트의 query 는 200자까지");
    assert.equal(truncateChars("abc", 5), "abc");
  });

  test("속성은 문자열·숫자·참거짓만, 너무 크면 {truncated:true}", () => {
    assert.deepEqual(sanitizeProperties("x", { a: 1, b: NaN, c: Infinity, d: true, e: { nested: 1 }, f: null, g: "ok" }), { a: 1, d: true, g: "ok" });
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key_${i}`, "가".repeat(50)]));
    assert.deepEqual(sanitizeProperties("x", many), { truncated: true });
    assert.deepEqual(sanitizeProperties("x", undefined), {});
  });

  test("uuidFromBytes 는 v4 형식", () => {
    const value = uuidFromBytes(new Uint8Array(16).fill(255));
    assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("서버 설정은 URL·키가 둘 다 있을 때만", () => {
    assert.equal(resolveServerConfig(undefined, undefined), null);
    assert.equal(resolveServerConfig("https://x.supabase.co", ""), null);
    assert.equal(resolveServerConfig("", "sb_publishable_x"), null);
    assert.equal(resolveServerConfig("  ", " sb_publishable_x "), null);
    assert.deepEqual(resolveServerConfig(" https://x.supabase.co/ ", " sb_publishable_x "), { url: "https://x.supabase.co", key: "sb_publishable_x" });
  });
});

// ---------------------------------------------------------------------------
// createAnalytics: track → 행, 이관, 초기화, 로컬 전용 모드

function analyticsWith({ serverMode = true, deleteOutcomes = ["done"], ...overrides } = {}) {
  const clock = fakeClock();
  const store = createMemoryStore();
  const server = fakeServer();
  const calls = { getToken: 0, peekToken: 0, post: 0, ensureSession: 0, delete: 0 };
  let token = "token-1";
  let path = "/home";
  const order = [];
  const analytics = createAnalytics({
    serverMode,
    store,
    timers: clock.timers,
    now: clock.now,
    newId: id,
    context: () => ({ path, displayMode: "standalone", client: { os: "android", browser: "chrome", in_app: "kakaotalk" } }),
    appVersion: "abc1234",
    getToken: async () => {
      calls.getToken += 1;
      return token;
    },
    peekToken: () => {
      calls.peekToken += 1;
      return token;
    },
    post: async (...args) => {
      calls.post += 1;
      order.push(`post:${args[1]}`);
      return server.post(...args);
    },
    ensureSession: async () => {
      calls.ensureSession += 1;
      return token ? { access_token: token } : null;
    },
    deleteServerDataAndSignOut: async () => {
      calls.delete += 1;
      order.push(`delete:${token}`);
      const outcome = deleteOutcomes.shift() ?? "done";
      if (outcome === "done") token = "token-2"; // 로그아웃 뒤 새 익명 세션
      return outcome;
    },
    ...overrides,
  });
  return { analytics, clock, store, server, calls, order, setToken: (value) => (token = value), setPath: (value) => (path = value) };
}

describe("track", () => {
  test("공통 필드를 붙여 보내고 user_id 는 보내지 않는다", async () => {
    const { analytics, clock, server } = analyticsWith();
    analytics.track("app_open", { display_mode: "standalone" });
    analytics.track("discover_search", { query: "q".repeat(150) });
    await clock.advance(FLUSH_DEBOUNCE_MS);
    const [open, search] = server.received();
    assert.equal(open.name, "app_open");
    assert.equal(open.path, "/home");
    assert.equal(open.display_mode, "standalone");
    assert.equal(open.app_version, "abc1234");
    assert.deepEqual([open.os, open.browser, open.in_app], ["android", "chrome", "kakaotalk"]);
    assert.equal(open.client_at, "2026-10-22T00:00:00.000Z");
    assert.equal(open.device_id, search.device_id, "기기 id 는 이어진다");
    assert.equal(open.session_id, search.session_id);
    assert.notEqual(open.client_event_id, search.client_event_id);
    assert.equal(search.properties.query.length, 100);
    assert.ok(!("user_id" in open));
    assert.deepEqual(Object.keys(open).sort(), [
      "app_version", "browser", "client_at", "client_event_id", "device_id", "display_mode", "in_app", "name", "os", "path", "properties", "session_id",
    ]);
  });

  test("30분 넘게 쉬면 session_id 가 바뀌고 기기 id 는 그대로", async () => {
    const { analytics, clock, server } = analyticsWith();
    analytics.track("home_view");
    await clock.advance(10 * 60_000);
    analytics.track("item_view");
    await clock.advance(SESSION_IDLE_MS + 1);
    analytics.track("home_view");
    await clock.advance(FLUSH_DEBOUNCE_MS);
    const [a, b, c] = server.received();
    assert.equal(a.session_id, b.session_id);
    assert.notEqual(b.session_id, c.session_id);
    assert.equal(a.device_id, c.device_id);
  });
});

describe("예전 로컬 기록 이관", () => {
  const legacy = [
    { name: "home_view", at: "2026-10-01T01:00:00.000Z" },
    { name: "discover_search", at: "2026-10-01T01:01:00.000Z", properties: { query: "가".repeat(130) } },
    { name: "add_to_trove", at: "2026-10-01T01:02:00.000Z", properties: { item_id: "rel-1", surface: "home" } },
    { broken: true },
  ];

  test("계정당 한 번만, migrated = true 를 붙여 올리고 예전 키를 지운다", async () => {
    const { analytics, store, server } = analyticsWith();
    store.setItem(LEGACY_KEY, JSON.stringify(legacy));
    analytics.userChanged("user-1");
    await settle();
    const got = server.received();
    assert.deepEqual(got.map((r) => r.name), ["home_view", "discover_search", "add_to_trove"]);
    assert.ok(got.every((r) => r.properties.migrated === true));
    assert.deepEqual(got.map((r) => r.client_at), legacy.slice(0, 3).map((e) => e.at));
    assert.equal(got[1].properties.query.length, 100);
    assert.equal(got[0].path, null);
    assert.equal(store.getItem(LEGACY_KEY), null);
    assert.ok(store.getItem(migrationFlagKey("user-1")));

    // 같은 계정이면 다시 생겨도 올리지 않는다
    store.setItem(LEGACY_KEY, JSON.stringify(legacy));
    analytics.userChanged("user-1");
    await settle();
    assert.equal(server.received().length, 3);
    assert.ok(store.getItem(LEGACY_KEY), "다른 계정 몫으로 남는다");

    // 다른 계정이면 한 번
    analytics.userChanged("user-2");
    await settle();
    assert.equal(server.received().length, 6);
  });
});

describe("MVP 데이터 초기화", () => {
  test("서버 삭제·로그아웃이 끝날 때까지 새 기록을 보내지 않고, 끝나면 새 세션으로 보낸다", async () => {
    const { analytics, clock, store, server, calls, order } = analyticsWith();
    analytics.track("home_view");
    await clock.advance(FLUSH_DEBOUNCE_MS);
    assert.equal(server.received("token-1").length, 1);
    const deviceBefore = server.received("token-1")[0].device_id;

    analytics.clear();
    const reset = analytics.resetServerData();
    analytics.track("app_open"); // 초기화 직후의 기록
    await reset;
    await clock.advance(FLUSH_DEBOUNCE_MS);
    assert.equal(calls.delete, 1);
    assert.equal(store.getItem(RESET_PENDING_KEY), null);
    assert.equal(server.received("token-1").length, 1, "옛 계정에는 새 기록이 가지 않는다");
    const fresh = server.received("token-2");
    assert.deepEqual(fresh.map((r) => r.name), ["app_open"]);
    assert.notEqual(fresh[0].device_id, deviceBefore, "초기화하면 기기 id 도 새로");
    assert.deepEqual(order, ["post:token-1", "delete:token-1", "post:token-2"]);
  });

  test("삭제가 네트워크 문제로 실패하면 표식을 남기고, 다음 기회(resume)에 마저 지운 뒤 보낸다", async () => {
    const { analytics, clock, store, server, calls } = analyticsWith({ deleteOutcomes: ["retry", "done"] });
    analytics.clear();
    await analytics.resetServerData();
    analytics.track("home_view");
    await clock.advance(FLUSH_DEBOUNCE_MS);
    assert.ok(store.getItem(RESET_PENDING_KEY));
    assert.equal(server.calls.length, 0, "삭제를 마치기 전에는 보내지 않는다");
    await analytics.resume();
    await settle();
    assert.equal(calls.delete, 2);
    assert.equal(store.getItem(RESET_PENDING_KEY), null);
    assert.deepEqual(server.received("token-2").map((r) => r.name), ["home_view"]);
  });

  test("재시도 예약이 남은 채 resume 으로 초기화가 끝나도, 같은 페이지의 다음 초기화가 막히지 않는다", async () => {
    const { analytics, clock, store, server, calls } = analyticsWith({ deleteOutcomes: ["retry", "done", "done"] });
    analytics.clear();
    await analytics.resetServerData(); // 네트워크 문제 → 30초 뒤 다시 예약
    await analytics.resume(); // 온라인 복귀로 마저 지움
    assert.equal(calls.delete, 2);
    assert.equal(store.getItem(RESET_PENDING_KEY), null);
    await clock.advance(30_000); // 남은 예약이 있었다면 여기서 표식 없이 돈다
    assert.equal(calls.delete, 2);

    analytics.clear();
    await analytics.resetServerData();
    assert.equal(calls.delete, 3, "두 번째 초기화도 서버 삭제를 부른다");
    assert.equal(store.getItem(RESET_PENDING_KEY), null);
    await settle();
    analytics.track("home_view");
    await clock.advance(FLUSH_DEBOUNCE_MS);
    assert.equal(server.calls.length, 1, "초기화 뒤 기록이 묶이지 않고 나간다");
  });

  test("보내는 중인 묶음이 끝난 뒤에 삭제한다", async () => {
    let release;
    const server = fakeServer();
    const order = [];
    const { analytics, clock } = analyticsWith({
      post: (rows, token, keepalive) => {
        order.push("post-start");
        return new Promise((resolve) => (release = () => resolve(server.post(rows, token, keepalive)))).then((result) => {
          order.push("post-end");
          return result;
        });
      },
      deleteServerDataAndSignOut: async () => {
        order.push("delete");
        return "done";
      },
    });
    analytics.track("home_view");
    await clock.advance(FLUSH_DEBOUNCE_MS);
    const reset = analytics.resetServerData();
    await settle();
    assert.deepEqual(order, ["post-start"]);
    release();
    await reset;
    assert.deepEqual(order, ["post-start", "post-end", "delete"]);
  });

  test("다른 탭이 보내는 중인 묶음도 도착한 뒤에 삭제한다(보내기 잠금을 함께 쓴다)", async () => {
    const store = createMemoryStore();
    const withLock = serialLock();
    const server = fakeServer();
    let release;
    const otherTab = createEventPipeline({
      store,
      timers: fakeClock().timers,
      getToken: async () => "token-1",
      peekToken: () => "token-1",
      post: (rows, token, keepalive) => new Promise((resolve) => (release = () => resolve(server.post(rows, token, keepalive)))),
      isHeld: () => store.getItem(RESET_PENDING_KEY) !== null,
      withLock,
    });
    const deletes = [];
    const { analytics } = analyticsWith({
      store,
      withLock,
      deleteServerDataAndSignOut: async () => {
        deletes.push(server.received("token-1").length);
        server.byToken.delete("token-1"); // delete_my_data
        return "done";
      },
    });
    otherTab.enqueue(row("other_tab_before_reset"));
    const otherFlush = otherTab.flush();
    await settle(); // 다른 탭의 묶음이 옛 계정 토큰으로 나가는 중
    analytics.clear();
    const reset = analytics.resetServerData();
    await settle();
    assert.deepEqual(deletes, [], "다른 탭의 요청이 끝나기 전에는 지우지 않는다");
    release();
    await Promise.all([otherFlush, reset]);
    assert.deepEqual(deletes, [1], "그 묶음이 들어간 뒤에 지운다");
    assert.equal(server.received("token-1").length, 0, "초기화 전 기록이 서버에 남지 않는다");
  });

  test("서버 삭제가 끝나기 전에 다른 탭이 남긴 기록은, 옛 캐시 쓰기에 큐에서 지워져도 되살려 새 계정으로 보낸다", async () => {
    const storage = sharedStorage();
    const server = fakeServer();
    let now = Date.parse("2026-10-22T00:00:00Z");
    let token = jwt("user-1");
    let held = false;
    const tab = () =>
      createEventPipeline({
        store: storage.view(),
        timers: fakeClock().timers,
        getToken: async () => token,
        peekToken: () => token,
        post: (...args) => server.post(...args),
        isHeld: () => held,
        now: () => now,
      });
    const a = tab();
    const b = tab();
    b.enqueue(row("b_before", { now }));
    await b.flush(); // b 는 user-1 을 기억한다
    storage.deliver();

    now += 1_000;
    a.clear(); // a 에서 MVP 데이터 초기화: 서버 삭제가 끝날 때까지 보내기 멈춤
    held = true;
    storage.deliver();

    now += 1_000;
    b.enqueue(row("b_after_reset", { now }));
    await b.flush(); // 멈춰 있어 저장 큐에만 남는다
    a.enqueue(row("a_after_reset", { now }));
    await a.flush(); // a 는 b 의 쓰기를 아직 못 본 캐시로 큐를 쓴다
    storage.deliver();
    assert.deepEqual(storage.stored().map((r) => r.name), ["a_after_reset"], "나중 쓰기가 b 의 행을 덮었다");

    held = false;
    token = jwt("user-2"); // 삭제·로그아웃 뒤 새 익명 계정
    await a.flush();
    storage.deliver();
    await b.flush();
    storage.deliver();
    assert.deepEqual(server.received(jwt("user-2")).map((r) => r.name).sort(), ["a_after_reset", "b_after_reset"], "b 의 초기화 뒤 기록도 새 계정으로 간다");
    assert.deepEqual(server.received(jwt("user-1")).map((r) => r.name), ["b_before"], "옛 계정에는 새 기록이 가지 않는다");
    assert.equal(a.pendingCount() + b.pendingCount(), 0);
    assert.deepEqual(storage.stored(), []);
  });
});

describe("로컬 전용 모드(Supabase 환경 변수 없음)", () => {
  test("네트워크·세션 함수를 하나도 부르지 않고, 예전처럼 이 기기에 최근 200개만 남긴다", async () => {
    const { analytics, clock, store, calls } = analyticsWith({ serverMode: false });
    for (let i = 0; i < 205; i += 1) analytics.track("home_view", { i });
    analytics.track("discover_search", { query: "q".repeat(150) });
    analytics.hidden();
    analytics.userChanged("user-1");
    await analytics.resume();
    await analytics.resetServerData();
    await clock.advance(10 * 60_000);
    assert.deepEqual(calls, { getToken: 0, peekToken: 0, post: 0, ensureSession: 0, delete: 0 });
    assert.equal(analytics.pipeline, null);
    const log = JSON.parse(store.getItem(LEGACY_KEY));
    assert.equal(log.length, 200);
    assert.equal(log.at(-1).name, "discover_search");
    assert.equal(log.at(-1).properties.query.length, 150, "로컬 기록은 예전 그대로(자르지 않음)");
    assert.equal(log[0].properties.i, 6);
    assert.equal(store.getItem(QUEUE_KEY), null);
    assert.equal(store.getItem(DEVICE_KEY), null, "기기 id 도 만들지 않는다");
    analytics.clear();
    assert.equal(store.getItem(LEGACY_KEY), null);
  });
});

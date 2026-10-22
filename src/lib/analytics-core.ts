/**
 * 사용 기록을 Trove 서버(Supabase `events` 표)로 보내는 일 가운데 DOM·Vite·Supabase 없이 돌릴 수 있는 부분.
 * 큐·묶어 보내기·재시도·세션 갱신·브라우저 요약·기존 기록 이관을 여기서 정하고, `analytics.ts` 가 브라우저에 붙인다.
 *
 * 이 파일은 아무것도 import 하지 않는다. `scripts/test/analytics-core.test.mjs` 가 Node 의 타입 지우기로
 * 이 .ts 파일을 그대로 불러와 시험하기 때문이다(enum·namespace 같은 지울 수 없는 문법도 쓰지 않는다).
 */

/** 보내지 못한 기록을 쌓아 두는 localStorage 키(최대 QUEUE_MAX 개, 넘치면 오래된 것부터 버린다) */
export const QUEUE_KEY = "trove-events-queue-v1";
/**
 * keepalive 로 보냈지만 페이지가 닫혀 결과를 모르는 행의 client_event_id. 대개 이미 들어갔으므로 다음 flush 는
 * 이 행들을 새 기록과 한 묶음에 싣지 않고(섞으면 묶음 전체가 409 로 돌아와 반씩 나눠 다시 보내야 한다) 한 행씩 보낸다
 */
export const UNCONFIRMED_KEY = "trove-events-unconfirmed-v1";
/** 예전 버전이 이 기기에 남긴 최근 200개 기록. 서버 모드에서 계정당 한 번 올리고 지운다 */
export const LEGACY_KEY = "trove-analytics-v1";
export const QUEUE_MAX = 500;
export const BATCH_MAX = 100;
/** 마지막 기록 뒤 이만큼 조용하면 보낸다 */
export const FLUSH_DEBOUNCE_MS = 3_000;
/** 기록이 계속 생겨도 첫 기록 뒤 이 시간 안에는 보낸다 */
export const FLUSH_MAX_WAIT_MS = 15_000;
/** 이만큼 아무 기록이 없으면 다음 기록부터 새 session_id */
export const SESSION_IDLE_MS = 30 * 60_000;
/** 페이지가 닫힐 때 keepalive 로 보내는 몸통 상한(브라우저 한도 64KB 보다 여유 있게) */
export const KEEPALIVE_MAX_BYTES = 60_000;
/** 검색어(discover_search.query)는 앞 100자까지만 서버에 남긴다(처리방침에 적은 약속) */
export const QUERY_MAX_CHARS = 100;
export const TEXT_PROPERTY_MAX_CHARS = 200;
/** events.properties 의 DB 제한은 2048바이트. JSON 기준으로 이보다 크면 {truncated:true} 로 바꾼다 */
export const PROPERTIES_MAX_BYTES = 1_500;
/** 보내기가 실패하면 이 간격으로 다시 시도한다(마지막 값을 계속 쓴다) */
export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];

export type EventProperties = Record<string, string | number | boolean>;

/** `public.events` 에 넣는 한 행. user_id 는 보내지 않는다(DB 기본값 auth.uid(), 클라이언트는 그 열에 쓸 권한이 없다) */
export interface ServerEventRow {
  client_event_id: string;
  device_id: string;
  session_id: string | null;
  name: string;
  properties: EventProperties;
  path: string | null;
  display_mode: string | null;
  app_version: string | null;
  os: string | null;
  browser: string | null;
  in_app: string | null;
  /** ISO 시각(기기 시계) */
  client_at: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage 를 못 쓸 때(사생활 보호 모드 등) 쓰는 대용품. 탭을 닫으면 사라진다 */
export function createMemoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

// ---------------------------------------------------------------------------
// 작은 도우미

const encoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

export function byteLength(text: string): number {
  return encoder ? encoder.encode(text).length : text.length * 3;
}

/** 글자(코드 포인트) 기준으로 자른다. 이모지·한글 조합이 반쪽으로 잘리지 않게 */
export function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** 16바이트 난수로 UUID v4 문자열을 만든다(crypto.randomUUID 가 없는 브라우저용) */
export function uuidFromBytes(bytes: Uint8Array): string {
  const b = Array.from(bytes.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// 공통 필드

export type OsFamily = "ios" | "android" | "mac" | "windows" | "other";

export interface BrowserSummary {
  os: OsFamily;
  /** safari, chrome, samsung, firefox, edge, whale, opera, other */
  browser: string;
  /** 앱 안 브라우저면 그 앱(kakaotalk, instagram, naver, facebook, line, daum, threads, webview), 아니면 null */
  in_app: string | null;
}

const IN_APP_RULES: Array<[RegExp, string]> = [
  [/KAKAOTALK/i, "kakaotalk"],
  [/Instagram/i, "instagram"],
  [/NAVER\(inapp|\bNAVER\//, "naver"],
  [/FBAN|FBAV|FB_IAB|FBIOS/, "facebook"],
  [/\bLine\//i, "line"],
  [/DaumApps/i, "daum"],
  [/Barcelona/, "threads"],
];

/**
 * User-Agent 에서 OS·브라우저 계열·앱 안 브라우저 여부만 뽑는다. 원문 UA 는 서버에 보내지 않는다.
 * iPadOS 는 맥처럼 보이므로 터치 지점 수(navigator.maxTouchPoints)로 가른다.
 */
export function summarizeBrowser(userAgent: string, maxTouchPoints = 0): BrowserSummary {
  const ua = userAgent || "";
  let os: OsFamily = "other";
  if (/iPhone|iPad|iPod/.test(ua)) os = "ios";
  else if (/Android/.test(ua)) os = "android";
  else if (/Macintosh|Mac OS X/.test(ua)) os = maxTouchPoints > 1 ? "ios" : "mac";
  else if (/Windows/.test(ua)) os = "windows";

  let inApp: string | null = null;
  for (const [pattern, name] of IN_APP_RULES) {
    if (pattern.test(ua)) {
      inApp = name;
      break;
    }
  }
  if (!inApp && os === "android" && /; wv\)/.test(ua)) inApp = "webview";

  let browser = "other";
  if (/SamsungBrowser\//.test(ua)) browser = "samsung";
  else if (/Whale\//.test(ua)) browser = "whale";
  else if (/Edg(e|A|iOS)?\//.test(ua)) browser = "edge";
  else if (/OPR\/|OPiOS\/|Opera/.test(ua)) browser = "opera";
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = "firefox";
  else if (/CriOS\/|Chrome\//.test(ua)) browser = "chrome";
  else if (/Safari\//.test(ua) || os === "ios") browser = "safari";
  return { os, browser, in_app: inApp };
}

/** 홈 화면 앱(standalone)인지 브라우저 탭인지. iOS Safari 는 navigator.standalone 도 본다 */
export function displayModeOf(matchesStandalone: boolean, navigatorStandalone: unknown): "standalone" | "browser" {
  return matchesStandalone || navigatorStandalone === true ? "standalone" : "browser";
}

export interface AnalyticsSession {
  id: string;
  /** 마지막 기록 시각(ms) */
  lastAt: number;
}

export function parseSession(raw: string | null): AnalyticsSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AnalyticsSession>;
    if (typeof value.id === "string" && value.id && typeof value.lastAt === "number" && Number.isFinite(value.lastAt)) {
      return { id: value.id, lastAt: value.lastAt };
    }
  } catch {
    // 깨진 값은 새 세션으로
  }
  return null;
}

/** 30분(idleMs) 넘게 조용했으면 새 세션, 아니면 같은 세션의 마지막 시각만 당긴다 */
export function nextSession(
  previous: AnalyticsSession | null,
  now: number,
  newId: () => string,
  idleMs = SESSION_IDLE_MS,
): AnalyticsSession {
  if (previous && now - previous.lastAt < idleMs) return { id: previous.id, lastAt: Math.max(now, previous.lastAt) };
  return { id: newId(), lastAt: now };
}

/** 서버로 보낼 속성만 남긴다: 문자열·유한한 숫자·참거짓. 검색어는 100자, 다른 문자열은 200자에서 자른다 */
export function sanitizeProperties(name: string, properties?: Record<string, unknown> | null): EventProperties {
  const result: EventProperties = {};
  if (properties && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties)) {
      const safeKey = truncateChars(key, 40);
      if (typeof value === "string") {
        const max = name === "discover_search" && key === "query" ? QUERY_MAX_CHARS : TEXT_PROPERTY_MAX_CHARS;
        result[safeKey] = truncateChars(value, max);
      } else if (typeof value === "number") {
        if (Number.isFinite(value)) result[safeKey] = value;
      } else if (typeof value === "boolean") {
        result[safeKey] = value;
      }
    }
  }
  if (byteLength(JSON.stringify(result)) > PROPERTIES_MAX_BYTES) return { truncated: true };
  return result;
}

export interface RowContext {
  now: number;
  clientEventId: string;
  deviceId: string;
  sessionId: string | null;
  path: string | null;
  displayMode: string | null;
  appVersion: string | null;
  client: BrowserSummary | null;
}

export function createRow(name: string, properties: Record<string, unknown> | null | undefined, context: RowContext): ServerEventRow {
  return {
    client_event_id: context.clientEventId,
    device_id: context.deviceId,
    session_id: context.sessionId,
    name: truncateChars(name, 64),
    properties: sanitizeProperties(name, properties),
    path: context.path === null ? null : truncateChars(context.path, 300),
    display_mode: context.displayMode,
    app_version: context.appVersion === null ? null : truncateChars(context.appVersion, 64),
    os: context.client?.os ?? null,
    browser: context.client?.browser ?? null,
    in_app: context.client?.in_app ?? null,
    client_at: new Date(context.now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 큐(localStorage)

function isRow(value: unknown): value is ServerEventRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ServerEventRow>;
  return (
    typeof row.client_event_id === "string" &&
    typeof row.device_id === "string" &&
    typeof row.name === "string" &&
    typeof row.client_at === "string" &&
    !!row.properties &&
    typeof row.properties === "object"
  );
}

/** 넘치면 오래된(앞쪽) 것부터 버린다 */
export function capQueue<T>(rows: T[], max = QUEUE_MAX): T[] {
  return rows.length > max ? rows.slice(rows.length - max) : rows;
}

export function readQueue(store: KeyValueStore): ServerEventRow[] {
  try {
    const parsed = JSON.parse(store.getItem(QUEUE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRow) : [];
  } catch {
    return [];
  }
}

export function writeQueue(store: KeyValueStore, rows: ServerEventRow[]): void {
  const capped = capQueue(rows);
  try {
    if (capped.length === 0) store.removeItem(QUEUE_KEY);
    else store.setItem(QUEUE_KEY, JSON.stringify(capped));
  } catch {
    // 저장 공간이 꽉 찼으면 오래된 절반을 버리고 한 번 더
    try {
      store.setItem(QUEUE_KEY, JSON.stringify(capped.slice(Math.floor(capped.length / 2))));
    } catch {
      // 그래도 안 되면 이번 기록은 잃는다. 앱 흐름은 멈추지 않는다
    }
  }
}

function readUnconfirmed(store: KeyValueStore): Set<string> {
  try {
    const parsed = JSON.parse(store.getItem(UNCONFIRMED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeUnconfirmed(store: KeyValueStore, ids: Set<string>): void {
  try {
    if (ids.size === 0) store.removeItem(UNCONFIRMED_KEY);
    else store.setItem(UNCONFIRMED_KEY, JSON.stringify(capQueue([...ids])));
  } catch {
    // 표시를 못 남기면 다음 flush 가 예전처럼 나눠 보낸다(잃는 것은 없다)
  }
}

/** 표시에서 ids 를 뗀다(들어갔거나, 페이지가 살아 있어 결과를 알게 된 행) */
function unmarkUnconfirmed(store: KeyValueStore, ids: string[]): void {
  const marked = readUnconfirmed(store);
  if (marked.size === 0) return;
  const before = marked.size;
  ids.forEach((id) => marked.delete(id));
  if (marked.size !== before) writeUnconfirmed(store, marked);
}

// ---------------------------------------------------------------------------
// 응답 해석

/**
 * ok: 들어감. duplicate: 이미 있음(같은 client_event_id, 409/23505). reject: 이 행(들) 자체가 DB 제한에 걸림(22xxx·23xxx, 413).
 * retry: 그 밖의 모든 것(네트워크 0, 401 토큰 만료, 403, 404 표 없음, PGRST 스키마 캐시, 429, 5xx) — 잃지 않고 나중에 다시.
 * 다른 코드의 409(예: 23503 — 대시보드에서 지운 계정의 토큰이 아직 살아 있음)도 retry: 토큰이 끝나면 새 익명 계정으로 들어간다.
 */
export type SendOutcome = "ok" | "duplicate" | "reject" | "retry";

export function classifyResponse(status: number, code?: string | null): SendOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (code === "23505" || (status === 409 && !code)) return "duplicate";
  if (status === 413) return "reject";
  if ((status === 400 || status === 422) && typeof code === "string" && /^(22|23)/.test(code)) return "reject";
  return "retry";
}

// ---------------------------------------------------------------------------
// 보내기

export interface PostResult {
  status: number;
  code?: string | null;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PipelineDeps {
  store: KeyValueStore;
  timers: Timers;
  /** 지금 쓸 수 있는 사용자 토큰(필요하면 익명 세션을 만든다). 아직 없으면 null — 기록은 큐에서 기다린다 */
  getToken(): Promise<string | null>;
  /** 기다릴 수 없을 때(페이지가 숨겨지거나 닫힐 때) 이미 손에 있는 토큰. 없거나 만료가 가까우면 null */
  peekToken(): string | null;
  /** POST /rest/v1/events (Prefer: return=minimal). 던지지 않고 상태만 돌려준다(네트워크 실패는 0) */
  post(rows: ServerEventRow[], token: string, keepalive: boolean): Promise<PostResult>;
  /** MVP 데이터 초기화가 서버에서 끝나기 전에는 보내지 않는다(옛 계정으로 새 기록이 가지 않게) */
  isHeld(): boolean;
  /** 여러 탭이 같은 큐를 동시에 보내지 않게. 없으면 그냥 실행 */
  withLock?: <T>(task: () => Promise<T>) => Promise<T>;
}

export interface EventPipeline {
  /** 기록 하나를 메모리 큐에 넣고 3초 뒤(계속 쌓이면 15초 안에, 100개면 바로) 보낸다 */
  enqueue(row: ServerEventRow): void;
  /** 이관할 옛 기록처럼 더 오래된 것을 저장 큐 앞에 넣는다 */
  prepend(rows: ServerEventRow[]): void;
  /** 메모리 큐를 저장 큐로 옮기고, 세션이 있으면 100개씩 보낸다 */
  flush(): Promise<void>;
  /** 페이지가 숨겨지거나 닫힐 때: 저장 큐로 옮긴 뒤 keepalive 요청 하나로 보낸다(동기) */
  flushOnHide(): void;
  /** 메모리·저장 큐와 예약을 모두 비운다. 진행 중인 보내기는 다음 묶음으로 넘어가지 않는다 */
  clear(): void;
  /** 진행 중인 flush 가 끝날 때까지 기다린다 */
  idle(): Promise<void>;
  /** 메모리 + 저장 큐에 남은 수(시험용) */
  pendingCount(): number;
}

interface BatchResult {
  /** 들어갔거나(중복 포함) 고칠 수 없어 버린 행의 id */
  done: string[];
  retry: boolean;
}

function idsOf(rows: ServerEventRow[]): string[] {
  return rows.map((row) => row.client_event_id);
}

export function createEventPipeline(deps: PipelineDeps): EventPipeline {
  const { store, timers } = deps;
  let memory: ServerEventRow[] = [];
  let debounceTimer: unknown = null;
  let maxWaitTimer: unknown = null;
  let retryTimer: unknown = null;
  let flushing: Promise<void> | null = null;
  let again = false;
  let failures = 0;
  let epoch = 0;
  /** 지금 요청에 실려 가는 행. 같은 행을 두 요청이 동시에 싣지 않게 */
  const inflight = new Set<string>();

  const clearTimer = (handle: unknown) => {
    if (handle !== null) timers.clear(handle);
  };

  function clearScheduled() {
    clearTimer(debounceTimer);
    clearTimer(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
  }

  function schedule() {
    clearTimer(debounceTimer);
    debounceTimer = timers.set(() => {
      debounceTimer = null;
      void flush();
    }, FLUSH_DEBOUNCE_MS);
    if (maxWaitTimer === null) {
      maxWaitTimer = timers.set(() => {
        maxWaitTimer = null;
        void flush();
      }, FLUSH_MAX_WAIT_MS);
    }
  }

  function scheduleRetry() {
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
    failures += 1;
    clearTimer(retryTimer);
    retryTimer = timers.set(() => {
      retryTimer = null;
      void flush();
    }, delay);
  }

  /** 메모리 큐를 저장 큐 뒤에 붙인다. 보내는 도중 페이지가 닫혀도 다음 시작 때 남아 있게 */
  function persistMemory() {
    if (memory.length === 0) return;
    const rows = memory;
    memory = [];
    writeQueue(store, [...readQueue(store), ...rows]);
  }

  function removeFromQueue(ids: string[]) {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    writeQueue(store, readQueue(store).filter((row) => !drop.has(row.client_event_id)));
    unmarkUnconfirmed(store, ids);
  }

  function sendable(): ServerEventRow[] {
    return readQueue(store).filter((row) => !inflight.has(row.client_event_id));
  }

  async function post(rows: ServerEventRow[], token: string, keepalive: boolean): Promise<PostResult> {
    try {
      return await deps.post(rows, token, keepalive);
    } catch {
      return { status: 0 };
    }
  }

  /** 한 묶음을 보낸다. 409·DB 제한 위반이면 반으로 나눠 다시 보내서, 이미 있는 행과 고칠 수 없는 행만 버린다 */
  async function sendBatch(rows: ServerEventRow[], token: string): Promise<BatchResult> {
    const outcome = await (async () => {
      const ids = idsOf(rows);
      ids.forEach((id) => inflight.add(id));
      try {
        const response = await post(rows, token, false);
        return classifyResponse(response.status, response.code);
      } finally {
        ids.forEach((id) => inflight.delete(id));
      }
    })();
    if (outcome === "ok") return { done: idsOf(rows), retry: false };
    if (outcome === "retry") return { done: [], retry: true };
    if (rows.length === 1) return { done: idsOf(rows), retry: false };
    const middle = Math.ceil(rows.length / 2);
    const left = await sendBatch(rows.slice(0, middle), token);
    if (left.retry) return left;
    const right = await sendBatch(rows.slice(middle), token);
    return { done: [...left.done, ...right.done], retry: right.retry };
  }

  async function sendAll(token: string, startEpoch: number): Promise<boolean> {
    let progressed = false;
    for (;;) {
      if (startEpoch !== epoch || deps.isHeld()) return progressed;
      const rows = sendable();
      const unconfirmed = readUnconfirmed(store);
      const fresh = unconfirmed.size === 0 ? rows : rows.filter((row) => !unconfirmed.has(row.client_event_id));
      // 새 기록을 먼저 묶어 보내고, keepalive 결과를 모르는 행은 한 행씩(이미 있으면 409 하나로 끝난다)
      const batch = fresh.length > 0 ? fresh.slice(0, BATCH_MAX) : rows.slice(0, 1);
      if (batch.length === 0) {
        failures = 0;
        return progressed;
      }
      const result = await sendBatch(batch, token);
      if (startEpoch !== epoch) return progressed;
      removeFromQueue(result.done);
      if (result.retry) {
        scheduleRetry();
        return progressed;
      }
      progressed = true;
      failures = 0;
    }
  }

  async function flushOnce(): Promise<boolean> {
    clearScheduled();
    persistMemory();
    if (deps.isHeld() || sendable().length === 0) return false;
    const startEpoch = epoch;
    const token = await deps.getToken().catch(() => null);
    if (startEpoch !== epoch) return false;
    if (!token) {
      // 세션이 아직 없다(만드는 중이거나 실패). 기록은 저장 큐에서 기다리고, 조금 뒤 다시 본다
      scheduleRetry();
      return false;
    }
    const run = () => sendAll(token, startEpoch);
    return deps.withLock ? deps.withLock(run) : run();
  }

  function flush(): Promise<void> {
    if (flushing) {
      again = true;
      return flushing;
    }
    flushing = (async () => {
      try {
        let progressed: boolean;
        do {
          again = false;
          progressed = await flushOnce().catch(() => false);
        } while (again && progressed);
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function flushOnHide() {
    clearScheduled();
    persistMemory();
    if (deps.isHeld()) return;
    const token = deps.peekToken();
    if (!token) return;
    const batch: ServerEventRow[] = [];
    let bytes = 2;
    const unconfirmed = readUnconfirmed(store);
    for (const row of sendable()) {
      // 지난번 keepalive 의 결과를 모르는 행은 싣지 않는다. 이미 들어갔으면 이 요청 전체가 409 로 거절된다
      if (unconfirmed.has(row.client_event_id)) continue;
      const size = byteLength(JSON.stringify(row)) + 1;
      if (batch.length >= BATCH_MAX || bytes + size > KEEPALIVE_MAX_BYTES) break;
      batch.push(row);
      bytes += size;
    }
    if (batch.length === 0) return;
    const ids = idsOf(batch);
    const startEpoch = epoch;
    ids.forEach((id) => inflight.add(id));
    // 응답 전에 페이지가 닫히면 .then 이 돌지 않는다. 그때를 위해 "보냈지만 결과 모름" 표시를 먼저 남긴다
    ids.forEach((id) => unconfirmed.add(id));
    writeUnconfirmed(store, unconfirmed);
    void post(batch, token, true)
      .then((response) => {
        // 409·제한 위반은 여기서 나누지 않는다. 행이 저장 큐에 그대로 있으니 다음 flush 가 나눠 보낸다
        if (classifyResponse(response.status, response.code) === "ok" && startEpoch === epoch) removeFromQueue(ids);
        else unmarkUnconfirmed(store, ids);
      })
      .finally(() => ids.forEach((id) => inflight.delete(id)));
  }

  return {
    enqueue(row) {
      memory.push(row);
      if (memory.length >= BATCH_MAX) void flush();
      else schedule();
    },
    prepend(rows) {
      if (rows.length === 0) return;
      writeQueue(store, [...rows, ...readQueue(store)]);
    },
    flush,
    flushOnHide,
    clear() {
      epoch += 1;
      memory = [];
      clearScheduled();
      clearTimer(retryTimer);
      retryTimer = null;
      failures = 0;
      inflight.clear();
      writeQueue(store, []);
      writeUnconfirmed(store, new Set());
    },
    idle() {
      return flushing ?? Promise.resolve();
    },
    pendingCount() {
      return memory.length + readQueue(store).length;
    },
  };
}

// ---------------------------------------------------------------------------
// 예전 기록 이관

export interface LegacyEvent {
  name: string;
  at: string;
  properties?: Record<string, unknown>;
}

export function migrationFlagKey(userId: string): string {
  return `trove-analytics-migrated:${userId}`;
}

/** 예전 기록 하나를 서버 행으로. properties.migrated = true 를 붙이고, 그때의 경로·화면 모드·버전은 모르므로 비운다 */
export function legacyToRow(
  event: unknown,
  context: { clientEventId: string; deviceId: string; client: BrowserSummary | null },
): ServerEventRow | null {
  if (!event || typeof event !== "object") return null;
  const { name, at, properties } = event as Partial<LegacyEvent>;
  if (typeof name !== "string" || !name || typeof at !== "string") return null;
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return null;
  const row = createRow(name, properties ?? null, {
    now: time,
    clientEventId: context.clientEventId,
    deviceId: context.deviceId,
    sessionId: null,
    path: null,
    displayMode: null,
    appVersion: null,
    client: context.client,
  });
  row.properties = { ...row.properties, migrated: true };
  return row;
}

/**
 * 이 계정(userId)으로 아직 안 올렸으면 예전 기록을 저장 큐 앞에 넣고, 계정별 표시를 남긴 뒤 예전 키를 지운다.
 * 큐에 넣기가 실패하면(던지면) 표시도 남기지 않아 다음에 다시 시도한다. 넣은 행 수를 돌려준다.
 */
export function migrateLegacyEvents(
  store: KeyValueStore,
  userId: string,
  toRow: (event: unknown) => ServerEventRow | null,
  prepend: (rows: ServerEventRow[]) => void,
  now: number,
): number {
  const flag = migrationFlagKey(userId);
  if (store.getItem(flag)) return 0;
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(store.getItem(LEGACY_KEY) ?? "[]");
  } catch {
    parsed = [];
  }
  const rows = (Array.isArray(parsed) ? parsed : []).map(toRow).filter((row): row is ServerEventRow => row !== null);
  prepend(rows);
  store.setItem(flag, new Date(now).toISOString());
  store.removeItem(LEGACY_KEY);
  return rows.length;
}

// ---------------------------------------------------------------------------
// 서버 설정과 전체 흐름(analytics.ts 는 여기에 브라우저 API 만 꽂는다)

/** URL·키가 둘 다 있을 때만 서버 모드. 끝의 / 는 뗀다 */
export function resolveServerConfig(url: string | undefined | null, key: string | undefined | null): { url: string; key: string } | null {
  const cleanUrl = (url ?? "").trim().replace(/\/+$/, "");
  const cleanKey = (key ?? "").trim();
  return cleanUrl && cleanKey ? { url: cleanUrl, key: cleanKey } : null;
}

export const DEVICE_KEY = "trove-device-id";
export const SESSION_KEY = "trove-analytics-session";
/** MVP 데이터 초기화를 서버에서 마칠 때까지 남는 표식. 있으면 기록을 보내지 않고 기다린다 */
export const RESET_PENDING_KEY = "trove-reset-pending";
/** 로컬 전용 모드에서 이 기기에 남기는 기록 수(예전과 같다) */
export const LOCAL_LOG_MAX = 200;

export interface AnalyticsDeps {
  /** false 면 예전과 똑같이 이 기기의 localStorage 에만 남긴다. 아래 서버용 함수는 하나도 부르지 않는다 */
  serverMode: boolean;
  store: KeyValueStore;
  timers: Timers;
  now(): number;
  newId(): string;
  /** 기록하는 순간의 화면 정보 */
  context(): { path: string | null; displayMode: string | null; client: BrowserSummary | null };
  appVersion: string;
  getToken(): Promise<string | null>;
  peekToken(): string | null;
  post(rows: ServerEventRow[], token: string, keepalive: boolean): Promise<PostResult>;
  ensureSession(): Promise<unknown>;
  /** delete_my_data RPC + 로그아웃. "retry" 면 표식을 남겨 다음에 다시 */
  deleteServerDataAndSignOut(): Promise<"done" | "retry">;
  withLock?: <T>(task: () => Promise<T>) => Promise<T>;
}

export interface Analytics {
  track(name: string, properties?: Record<string, string | number | boolean>): void;
  /** 이 기기의 기록과 아직 못 보낸 기록을 지우고, 기기 id·세션 id 를 새로 */
  clear(): void;
  /** 서버 모드: 서버의 내 기록 삭제 → 로그아웃. 끝날 때까지 새 기록은 보내지 않고 기다린다 */
  resetServerData(): Promise<void>;
  /** 다음 시작·온라인 복귀·화면 복귀: 밀린 초기화 → 세션 확인 → 밀린 기록 보내기 */
  resume(): Promise<void>;
  /** 로그인한 사용자(익명 포함)가 정해졌을 때: 예전 기록을 이 계정으로 한 번 올리고 보낸다 */
  userChanged(userId: string | null): void;
  /** 화면이 숨겨지거나 닫힐 때 */
  hidden(): void;
  /** 시험용: 서버 모드의 보내기 큐(로컬 전용 모드에선 null) */
  readonly pipeline: EventPipeline | null;
}

export function createAnalytics(deps: AnalyticsDeps): Analytics {
  const { store } = deps;
  let pipeline: EventPipeline | null = null;
  let resetFlight: Promise<void> | null = null;
  let resetRetryTimer: unknown = null;

  const isResetPending = () => {
    try {
      return store.getItem(RESET_PENDING_KEY) !== null;
    } catch {
      return false;
    }
  };

  function getPipeline(): EventPipeline {
    pipeline ??= createEventPipeline({
      store,
      timers: deps.timers,
      getToken: deps.getToken,
      peekToken: deps.peekToken,
      post: deps.post,
      isHeld: isResetPending,
      withLock: deps.withLock,
    });
    return pipeline;
  }

  function deviceId(): string {
    let id = store.getItem(DEVICE_KEY);
    if (!id) {
      id = deps.newId();
      store.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function sessionId(now: number): string {
    const session = nextSession(parseSession(store.getItem(SESSION_KEY)), now, deps.newId);
    store.setItem(SESSION_KEY, JSON.stringify(session));
    return session.id;
  }

  function trackLocally(name: string, properties?: Record<string, string | number | boolean>) {
    try {
      const current = JSON.parse(store.getItem(LEGACY_KEY) ?? "[]") as LegacyEvent[];
      const next = [...current.slice(-(LOCAL_LOG_MAX - 1)), { name, at: new Date(deps.now()).toISOString(), properties }];
      store.setItem(LEGACY_KEY, JSON.stringify(next));
    } catch {
      // Analytics should never interrupt the product flow.
    }
  }

  function clearResetRetry() {
    if (resetRetryTimer !== null) deps.timers.clear(resetRetryTimer);
    resetRetryTimer = null;
  }

  function runPendingReset(force = false): Promise<void> {
    if (resetFlight) return resetFlight;
    // 표식 확인은 비동기 함수 밖에서 한다. 안에서 await 없이 끝나면 finally 의 resetFlight = null 이
    // 대입보다 먼저 돌아, 끝난 promise 가 resetFlight 에 남고 이후 초기화가 모두 막힌다
    if (!force && !isResetPending()) return Promise.resolve();
    resetFlight = (async () => {
      try {
        // 이미 나가는 중인 묶음이 옛 계정으로 도착한 뒤에 지우도록 기다린다
        await getPipeline().idle();
        const outcome = await deps.deleteServerDataAndSignOut().catch(() => "retry" as const);
        if (outcome === "done") {
          clearResetRetry();
          store.removeItem(RESET_PENDING_KEY);
          // 초기화 뒤에 생긴 기록은 새 익명 세션으로 보낸다(세션은 여기서 필요해질 때 만든다)
          void getPipeline().flush();
        } else if (resetRetryTimer === null) {
          resetRetryTimer = deps.timers.set(() => {
            resetRetryTimer = null;
            void runPendingReset();
          }, 30_000);
        }
      } catch {
        // 다음 시작·온라인 복귀·화면 복귀 때 다시
      } finally {
        resetFlight = null;
      }
    })();
    return resetFlight;
  }

  return {
    get pipeline() {
      return pipeline;
    },
    track(name, properties) {
      if (!deps.serverMode) {
        trackLocally(name, properties);
        return;
      }
      try {
        const now = deps.now();
        const view = deps.context();
        getPipeline().enqueue(
          createRow(name, properties, {
            now,
            clientEventId: deps.newId(),
            deviceId: deviceId(),
            sessionId: sessionId(now),
            path: view.path,
            displayMode: view.displayMode,
            appVersion: deps.appVersion,
            client: view.client,
          }),
        );
      } catch {
        // Analytics should never interrupt the product flow.
      }
    },
    clear() {
      try {
        store.removeItem(LEGACY_KEY);
      } catch {
        // 저장소가 막혀 있어도 초기화는 계속된다
      }
      if (!deps.serverMode) return;
      clearResetRetry();
      try {
        getPipeline().clear();
        store.removeItem(DEVICE_KEY);
        store.removeItem(SESSION_KEY);
      } catch {
        // 초기화는 계속된다
      }
    },
    resetServerData() {
      if (!deps.serverMode) return Promise.resolve();
      try {
        store.setItem(RESET_PENDING_KEY, new Date(deps.now()).toISOString());
      } catch {
        // 표식을 못 남겨도 이번 시도는 한다
      }
      return runPendingReset(true);
    },
    async resume() {
      if (!deps.serverMode) return;
      try {
        if (isResetPending()) {
          await runPendingReset();
          if (isResetPending()) return;
        }
        await deps.ensureSession();
        await getPipeline().flush();
      } catch {
        // 조용히 다음 기회에
      }
    },
    userChanged(userId) {
      if (!deps.serverMode || !userId) return;
      try {
        migrateLegacyEvents(
          store,
          userId,
          (event) => legacyToRow(event, { clientEventId: deps.newId(), deviceId: deviceId(), client: deps.context().client }),
          (rows) => getPipeline().prepend(rows),
          deps.now(),
        );
      } catch {
        // 다음에 다시
      }
      void getPipeline().flush();
    },
    hidden() {
      if (deps.serverMode) getPipeline().flushOnHide();
    },
  };
}

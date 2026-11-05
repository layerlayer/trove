import {
  type Analytics,
  type BrowserSummary,
  createAnalytics,
  createMemoryStore,
  displayModeOf,
  type KeyValueStore,
  type PostResult,
  type ServerEventRow,
  summarizeBrowser,
  uuidFromBytes,
} from "./analytics-core";
import {
  deleteServerDataAndSignOut,
  ensureSession,
  onUserChange,
  peekAccessToken,
  supabaseConfig,
} from "./supabase";

/**
 * 앱 안 사용 기록. 흐름은 `analytics-core.ts` 의 createAnalytics 가 정하고, 여기서는 브라우저 API 만 꽂는다.
 * - 로컬 전용 모드(Supabase 환경 변수 없음): 지금처럼 이 브라우저의 localStorage 에 최근 200개만 남긴다. 네트워크 없음.
 * - 서버 모드: Trove 서버의 `events` 표로 묶어 보낸다(3초 모아서, 화면이 숨겨지면 바로). 보내지 못한 것은
 *   localStorage 큐(최대 500개)에서 기다렸다가 다시 보낸다. 예전 로컬 기록은 계정당 한 번 올리고 지운다.
 */

export type AnalyticsEventName =
  | "app_open"
  | "home_view"
  | "feed_more"
  | "category_followed"
  | "entity_view"
  | "entity_followed"
  | "notifications_view"
  | "info_view"
  | "discover_search"
  | "category_selected"
  | "item_view"
  | "add_to_trove"
  | "remove_from_trove"
  | "reminder_enabled"
  | "signup_started"
  | "signup_completed"
  | "notification_permission_granted"
  | "release_source_clicked";

interface AnalyticsEvent {
  name: AnalyticsEventName;
  at: string;
  properties?: Record<string, string | number | boolean>;
}

const APP_VERSION = typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "dev";

/** localStorage. 막혀 있으면(사생활 보호 모드 등) 이 탭에서만 사는 메모리 저장소 */
function pickStore(): KeyValueStore {
  try {
    const storage = window.localStorage;
    const probe = "trove-storage-probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return createMemoryStore();
  }
}

function newId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  } catch {
    return uuidFromBytes(new Uint8Array(16).map(() => Math.floor(Math.random() * 256)));
  }
}

let client: BrowserSummary | null = null;
function browserSummary(): BrowserSummary {
  client ??= summarizeBrowser(navigator.userAgent ?? "", navigator.maxTouchPoints ?? 0);
  return client;
}

function currentDisplayMode(): "standalone" | "browser" {
  try {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
    return displayModeOf(standalone, (navigator as Navigator & { standalone?: boolean }).standalone);
  } catch {
    return "browser";
  }
}

async function postEvents(rows: ServerEventRow[], token: string, keepalive: boolean): Promise<PostResult> {
  const config = supabaseConfig;
  if (!config) return { status: 0 };
  const controller = keepalive || typeof AbortController === "undefined" ? null : new AbortController();
  const timer = controller ? window.setTimeout(() => controller.abort(), 15_000) : null;
  try {
    const response = await fetch(`${config.url}/rest/v1/events`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // events 에는 읽기 정책이 없다. 넣은 행을 돌려받지 않는다
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
      // 페이지가 닫혀도 요청이 끝까지 가게. sendBeacon 과 달리 인증 헤더를 실을 수 있다
      keepalive,
      credentials: "omit",
      signal: controller?.signal,
    });
    let code: string | null = null;
    if (!response.ok) {
      try {
        const body = (await response.json()) as { code?: unknown } | null;
        code = typeof body?.code === "string" ? body.code : null;
      } catch {
        code = null;
      }
    }
    return { status: response.status, code };
  } catch {
    return { status: 0 };
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

let analytics: Analytics | null = null;
function getAnalytics(): Analytics {
  analytics ??= createAnalytics({
    serverMode: supabaseConfig !== null,
    store: pickStore(),
    timers: {
      set: (callback, ms) => window.setTimeout(callback, ms),
      clear: (handle) => window.clearTimeout(handle as number),
    },
    now: () => Date.now(),
    newId,
    context: () => ({ path: window.location.pathname, displayMode: currentDisplayMode(), client: browserSummary() }),
    appVersion: APP_VERSION,
    getToken: async () => (await ensureSession())?.access_token ?? null,
    peekToken: peekAccessToken,
    post: postEvents,
    ensureSession,
    deleteServerDataAndSignOut,
    withLock:
      typeof navigator !== "undefined" && navigator.locks?.request
        ? <T,>(task: () => Promise<T>) => navigator.locks.request("trove-events-flush", () => task()) as Promise<T>
        : undefined,
  });
  return analytics;
}

export function track(
  name: AnalyticsEventName,
  properties?: AnalyticsEvent["properties"],
) {
  try {
    getAnalytics().track(name, properties);
  } catch {
    // Analytics should never interrupt the product flow.
  }
}

let started = false;

/** main.tsx 가 첫 렌더를 건 뒤 한 번 부른다. app_open 을 남기고, 서버 모드면 보내기 준비를 한다 */
export function startAnalytics() {
  if (started) return;
  started = true;
  track("app_open", { display_mode: currentDisplayMode() });
  if (!supabaseConfig) return;
  const instance = getAnalytics();

  onUserChange((userId) => instance.userChanged(userId));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") instance.hidden();
    else void instance.resume();
  });
  window.addEventListener("pagehide", () => instance.hidden());
  window.addEventListener("online", () => void instance.resume());

  // 첫 화면을 막지 않게 브라우저가 한가할 때 Supabase 코드를 읽고 세션을 확인한다
  const boot = () => void instance.resume();
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(boot, { timeout: 2_000 });
  else window.setTimeout(boot, 300);
}

/** MVP 데이터 초기화에서 사용 기록도 함께 지운다(개인정보 처리방침의 약속): 이 기기의 기록과 아직 못 보낸 기록 */
export function clearAnalytics() {
  try {
    getAnalytics().clear();
  } catch {
    // 저장소가 막혀 있어도 초기화는 계속된다
  }
}

/**
 * MVP 데이터 초기화의 서버 쪽(서버 모드에서만): Trove 서버의 내 기록을 `delete_my_data()` 로 지우고 로그아웃한다.
 * 새 익명 세션은 다음 기록 때 만든다. 네트워크가 안 되면 표식을 남겨 두었다가 다음 기회에 마저 지우고,
 * 그동안 생긴 기록은 옛 계정으로 보내지 않고 기다린다. 로컬 전용 모드에서는 아무것도 하지 않는다.
 */
export function resetServerData() {
  try {
    void getAnalytics().resetServerData();
  } catch {
    // 초기화는 계속된다
  }
}

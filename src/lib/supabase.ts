import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { resolveServerConfig } from "./analytics-core";

/**
 * Trove 서버(Supabase) 연결.
 *
 * - `VITE_SUPABASE_URL` 과 `VITE_SUPABASE_PUBLISHABLE_KEY` 가 **둘 다** 있을 때만 서버 모드예요. 하나라도 없으면
 *   `supabaseConfig` 는 null 이고 `getSupabase()` 는 null 을 돌려줘요. 그때 앱은 지금처럼 이 기기 안에서만 돌고,
 *   Supabase 코드는 내려받지도 않아요(동적 import 라 별도 파일로 빠지고, 서버 모드에서 첫 화면을 그린 뒤에만 읽어요).
 * - 익명 세션은 저장된 세션이 **없을 때만** 만들어요(Supabase 는 익명 가입을 IP 당 시간당 30번으로 막아요).
 *   한 탭 안에서는 한 번에 하나만(single-flight), 여러 탭 사이에는 navigator.locks 로 하나만 만들어요.
 * - 실패는 모두 삼키고 나중에(다음 시작·온라인 복귀·화면 복귀·다음 기록) 다시 해요.
 * - 비밀 키(sb_secret_…)는 앱 어디에도 넣지 않아요. 여기 들어가는 publishable 키는 공개돼도 되는 키예요(보안은 RLS 가 지켜요).
 */

export const supabaseConfig: { url: string; key: string } | null = resolveServerConfig(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

/** supabase-js 가 세션을 저장하는 localStorage 키 */
export const AUTH_STORAGE_KEY = "trove-auth-v1";

const SIGNUP_LOCK = "trove-anonymous-signup";
const SIGNUP_LEASE_KEY = "trove-anonymous-signup-lease";
/** 익명 가입이 실패했을 때 다음 시도까지 기다리는 시간(한 페이지 안에서만 기억) */
const SIGNUP_BACKOFF_MS = [10_000, 60_000, 5 * 60_000, 15 * 60_000];

let clientPromise: Promise<SupabaseClient | null> | null = null;

interface CachedAuth {
  token: string;
  /** ms */
  expiresAt: number;
  userId: string;
}

let cachedAuth: CachedAuth | null = null;
const userListeners = new Set<(userId: string | null) => void>();

function remember(session: Session | null) {
  const previousUser = cachedAuth?.userId ?? null;
  cachedAuth = session
    ? { token: session.access_token, expiresAt: (session.expires_at ?? 0) * 1000, userId: session.user.id }
    : null;
  const nextUser = cachedAuth?.userId ?? null;
  if (previousUser === nextUser) return;
  // auth 이벤트 콜백 안에서 다른 auth 메서드를 기다리지 않게 한 박자 뒤에 알린다
  for (const listener of userListeners) {
    window.setTimeout(() => {
      try {
        listener(nextUser);
      } catch {
        // 듣는 쪽의 실패가 다른 쪽을 막지 않게
      }
    }, 0);
  }
}

/** 서버 모드가 아니면 null. 클라이언트는 처음 부를 때 한 번만 만든다(읽기에 실패하면 다음에 다시) */
export function getSupabase(): Promise<SupabaseClient | null> {
  const config = supabaseConfig;
  if (!config) return Promise.resolve(null);
  clientPromise ??= import("@supabase/supabase-js")
    .then(({ createClient }) => {
      const client = createClient(config.url, config.key, {
        auth: {
          storageKey: AUTH_STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          // 로그인 메일 링크를 쓰지 않는다(PR2 는 6자리 코드). 주소창을 읽지 않는다
          detectSessionInUrl: false,
        },
      });
      client.auth.onAuthStateChange((_event, session) => remember(session));
      return client;
    })
    .catch(() => {
      clientPromise = null;
      return null;
    });
  return clientPromise;
}

/** 이미 손에 있는(만료까지 30초 넘게 남은) 토큰. 페이지가 닫힐 때처럼 기다릴 수 없을 때 쓴다 */
export function peekAccessToken(): string | null {
  if (!cachedAuth || cachedAuth.expiresAt - Date.now() < 30_000) return null;
  return cachedAuth.token;
}

/** 로그인한 사용자(익명 포함)가 바뀌면 알린다. 처음 세션을 읽었을 때도 한 번 */
export function onUserChange(listener: (userId: string | null) => void): () => void {
  userListeners.add(listener);
  return () => userListeners.delete(listener);
}

async function withSignupLock<T>(task: () => Promise<T | null>): Promise<T | null> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks?.request) {
    return locks.request(SIGNUP_LOCK, () => task()) as Promise<T | null>;
  }
  // navigator.locks 가 없는 오래된 브라우저: localStorage 에 15초짜리 표식을 두고 다른 탭이 가입 중이면 이번엔 건너뛴다
  try {
    const lease = Number(window.localStorage.getItem(SIGNUP_LEASE_KEY));
    if (lease && Date.now() - lease < 15_000) return null;
    window.localStorage.setItem(SIGNUP_LEASE_KEY, String(Date.now()));
  } catch {
    // 저장소를 못 쓰면 표식 없이 진행
  }
  try {
    return await task();
  } finally {
    try {
      window.localStorage.removeItem(SIGNUP_LEASE_KEY);
    } catch {
      // 무시
    }
  }
}

let sessionFlight: Promise<Session | null> | null = null;
let signupFailures = 0;
let signupBlockedUntil = 0;

async function bootstrapSession(): Promise<Session | null> {
  const client = await getSupabase();
  if (!client) return null;
  const first = await client.auth.getSession();
  // 세션은 있는데 갱신이 실패한 경우(네트워크 등)에는 새 익명 계정을 만들지 않고 나중에 다시 본다
  if (first.error) return null;
  if (first.data.session) {
    remember(first.data.session);
    return first.data.session;
  }
  if (Date.now() < signupBlockedUntil) return null;
  return withSignupLock(async () => {
    // 잠금을 기다리는 동안 다른 탭이 만들었을 수 있다(세션은 localStorage 를 같이 쓴다)
    const again = await client.auth.getSession();
    if (again.error) return null;
    if (again.data.session) {
      remember(again.data.session);
      return again.data.session;
    }
    const { data, error } = await client.auth.signInAnonymously();
    if (error || !data.session) {
      signupBlockedUntil = Date.now() + SIGNUP_BACKOFF_MS[Math.min(signupFailures, SIGNUP_BACKOFF_MS.length - 1)];
      signupFailures += 1;
      return null;
    }
    signupFailures = 0;
    remember(data.session);
    return data.session;
  });
}

/**
 * 세션이 있으면 그대로, 없으면 익명 세션을 하나 만든다. 동시에 여러 번 불러도 요청은 하나만 나간다.
 * 서버 모드가 아니거나 실패하면 null (던지지 않는다).
 */
export function ensureSession(): Promise<Session | null> {
  if (!supabaseConfig) return Promise.resolve(null);
  sessionFlight ??= bootstrapSession()
    .catch(() => null)
    .finally(() => {
      sessionFlight = null;
    });
  return sessionFlight;
}

/**
 * MVP 데이터 초기화의 서버 쪽: `delete_my_data()` 로 이 계정의 서버 기록을 지우고 이 기기에서 로그아웃한다.
 * 새 익명 세션은 다음 기록 때 ensureSession 이 만든다.
 * - "retry": 네트워크·서버 오류라 지우지 못했다(로그아웃하지 않고 남겨 둔다. 부르는 쪽이 나중에 다시 부른다)
 * - "done": 지웠거나, 지울 것이 없거나(세션 없음), 다시 해도 안 되는 오류(401·404 등)라 포기하고 로그아웃했다
 */
export async function deleteServerDataAndSignOut(): Promise<"done" | "retry"> {
  const client = await getSupabase();
  if (!client) return supabaseConfig ? "retry" : "done";
  const current = await client.auth.getSession();
  if (current.error) return "retry";
  if (current.data.session) {
    const { error, status } = await client.rpc("delete_my_data");
    if (error && (status === 0 || status === 408 || status === 429 || status >= 500)) return "retry";
    await client.auth.signOut({ scope: "local" }).catch(() => undefined);
    const after = await client.auth.getSession().catch(() => null);
    if (after?.data.session) return "retry";
  }
  remember(null);
  return "done";
}

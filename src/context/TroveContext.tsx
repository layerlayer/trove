import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { clearAnalytics, resetServerData } from "../lib/analytics";
import type { AlertPreset, TroveState, TroveUser } from "../types";

/** v3: 발행물 기반 id(관심사 category:/entity:, 출시 항목은 콘솔 id)로 바뀌어 v2 의 관심사·담기·알림은 이어받지 않는다 */
const STORAGE_KEY = "trove-demo-state-v3";
const LEGACY_STORAGE_KEYS = ["trove-demo-state-v2", "trove-demo-state-v1"];

const initialState: TroveState = {
  onboardingComplete: false,
  interests: [],
  favorites: [],
  alerts: {},
  notificationsSeenAt: null,
  notificationsSeenIds: [],
  user: null,
  settings: {
    defaultAlerts: ["D-1", "D-Day"],
    weeklyDigest: true,
    notificationPermission:
      typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  },
};

interface TroveContextValue {
  state: TroveState;
  toggleInterest: (id: string) => void;
  completeOnboarding: () => void;
  toggleFavorite: (id: string) => void;
  setAlertPresets: (id: string, presets: AlertPreset[]) => void;
  /** 알림 센터에서 본 울린 알림 id 들을 기록한다(지난 것은 같이 정리) */
  markNotificationsRead: (ids: string[]) => void;
  signIn: (email: string, provider?: TroveUser["provider"]) => void;
  signOut: () => void;
  setDefaultAlerts: (presets: AlertPreset[]) => void;
  setWeeklyDigest: (enabled: boolean) => void;
  setNotificationPermission: (permission: NotificationPermission | "unsupported") => void;
  resetDemo: () => void;
}

const TroveContext = createContext<TroveContextValue | null>(null);

function readState(): TroveState {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<TroveState>;
      return {
        ...initialState,
        ...parsed,
        settings: { ...initialState.settings, ...parsed.settings },
      };
    }
    // 예전 목업 상태에서는 로그인과 설정만 이어받는다. 관심사·담기·알림은 id 체계가 달라 버린다.
    for (const key of LEGACY_STORAGE_KEYS) {
      const legacy = window.localStorage.getItem(key);
      if (!legacy) continue;
      const parsed = JSON.parse(legacy) as Partial<TroveState>;
      return {
        ...initialState,
        user: parsed.user ?? null,
        settings: { ...initialState.settings, ...parsed.settings },
      };
    }
    return initialState;
  } catch {
    return initialState;
  }
}

export function TroveProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<TroveState>(readState);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const toggleInterest = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      interests: current.interests.includes(id)
        ? current.interests.filter((item) => item !== id)
        : [...current.interests, id],
    }));
  }, []);

  const completeOnboarding = useCallback(() => {
    setState((current) => ({ ...current, onboardingComplete: true }));
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setState((current) => {
      if (current.favorites.includes(id)) {
        const alerts = { ...current.alerts };
        delete alerts[id];
        return {
          ...current,
          favorites: current.favorites.filter((item) => item !== id),
          alerts,
        };
      }
      return { ...current, favorites: [...current.favorites, id] };
    });
  }, []);

  const setAlertPresets = useCallback((id: string, presets: AlertPreset[]) => {
    setState((current) => {
      // 빈 배열은 "알림 해제"를 뜻한다. 키를 지우면 기본 알림이 다시 적용되므로 그대로 남긴다
      const alerts = { ...current.alerts, [id]: presets };
      const favorites =
        presets.length > 0 && !current.favorites.includes(id)
          ? [...current.favorites, id]
          : current.favorites;
      return { ...current, alerts, favorites };
    });
  }, []);

  const markNotificationsRead = useCallback((ids: string[]) => {
    setState((current) => ({ ...current, notificationsSeenAt: new Date().toISOString(), notificationsSeenIds: ids }));
  }, []);

  const signIn = useCallback((email: string, provider: TroveUser["provider"] = "email") => {
    const localName = email.split("@")[0].replace(/[._-]+/g, " ").trim();
    const name = localName
      ? localName
          .split(" ")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ")
      : "Trove 사용자";
    setState((current) => ({
      ...current,
      user: { id: `local-${email.toLowerCase()}`, name, email, provider },
    }));
  }, []);

  const signOut = useCallback(() => {
    setState((current) => ({ ...current, user: null }));
  }, []);

  const setDefaultAlerts = useCallback((presets: AlertPreset[]) => {
    setState((current) => ({
      ...current,
      settings: { ...current.settings, defaultAlerts: presets },
    }));
  }, []);

  const setWeeklyDigest = useCallback((enabled: boolean) => {
    setState((current) => ({
      ...current,
      settings: { ...current.settings, weeklyDigest: enabled },
    }));
  }, []);

  const setNotificationPermission = useCallback(
    (permission: NotificationPermission | "unsupported") => {
      setState((current) => ({
        ...current,
        settings: { ...current.settings, notificationPermission: permission },
      }));
    },
    [],
  );

  const resetDemo = useCallback(() => {
    // "사용 기록도 함께 지운다": 이 기기의 기록과 보내지 못한 기록, 그리고 서버 모드면 Trove 서버의 내 기록까지
    // (delete_my_data → 로그아웃 → 다음 기록 때 새 익명 세션). 로컬 전용 모드에서 resetServerData 는 아무것도 안 한다
    clearAnalytics();
    resetServerData();
    window.localStorage.removeItem(STORAGE_KEY);
    for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key);
    setState(initialState);
  }, []);

  const value = useMemo(
    () => ({
      state,
      toggleInterest,
      completeOnboarding,
      toggleFavorite,
      setAlertPresets,
      markNotificationsRead,
      signIn,
      signOut,
      setDefaultAlerts,
      setWeeklyDigest,
      setNotificationPermission,
      resetDemo,
    }),
    [
      completeOnboarding,
      markNotificationsRead,
      resetDemo,
      setDefaultAlerts,
      setAlertPresets,
      setNotificationPermission,
      setWeeklyDigest,
      signIn,
      signOut,
      state,
      toggleFavorite,
      toggleInterest,
    ],
  );

  return <TroveContext.Provider value={value}>{children}</TroveContext.Provider>;
}

export function useTrove(): TroveContextValue {
  const context = useContext(TroveContext);
  if (!context) throw new Error("useTrove must be used inside TroveProvider");
  return context;
}

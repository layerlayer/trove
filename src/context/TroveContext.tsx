import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AlertPreset, TroveState, TroveUser } from "../types";

const STORAGE_KEY = "trove-demo-state-v2";
const LEGACY_STORAGE_KEY = "trove-demo-state-v1";

const initialState: TroveState = {
  onboardingComplete: false,
  interests: [],
  favorites: [],
  alerts: {},
  unreadNotifications: 3,
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
  markNotificationsRead: () => void;
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
    const saved =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!saved) return initialState;
    const parsed = JSON.parse(saved) as Partial<TroveState>;
    return {
      ...initialState,
      ...parsed,
      settings: { ...initialState.settings, ...parsed.settings },
    };
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
      const alerts = { ...current.alerts };
      if (presets.length === 0) delete alerts[id];
      else alerts[id] = presets;
      const favorites =
        presets.length > 0 && !current.favorites.includes(id)
          ? [...current.favorites, id]
          : current.favorites;
      return { ...current, alerts, favorites };
    });
  }, []);

  const markNotificationsRead = useCallback(() => {
    setState((current) => ({ ...current, unreadNotifications: 0 }));
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
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
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

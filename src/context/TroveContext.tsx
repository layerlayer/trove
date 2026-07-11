import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { initialAlerts, initialFavoriteIds } from "../data/mock";
import type { AlertPreset, TroveState } from "../types";

const STORAGE_KEY = "trove-demo-state-v1";

const initialState: TroveState = {
  onboardingComplete: false,
  interests: ["supreme", "gd", "nintendo"],
  favorites: initialFavoriteIds,
  alerts: initialAlerts as Record<string, AlertPreset[]>,
  unreadNotifications: 3,
};

interface TroveContextValue {
  state: TroveState;
  toggleInterest: (id: string) => void;
  completeOnboarding: () => void;
  toggleFavorite: (id: string) => void;
  setAlertPresets: (id: string, presets: AlertPreset[]) => void;
  markNotificationsRead: () => void;
  resetDemo: () => void;
}

const TroveContext = createContext<TroveContextValue | null>(null);

function readState(): TroveState {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return initialState;
    const parsed = JSON.parse(saved) as Partial<TroveState>;
    return { ...initialState, ...parsed };
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
    setState((current) => ({
      ...current,
      favorites: current.favorites.includes(id)
        ? current.favorites.filter((item) => item !== id)
        : [...current.favorites, id],
    }));
  }, []);

  const setAlertPresets = useCallback((id: string, presets: AlertPreset[]) => {
    setState((current) => {
      const alerts = { ...current.alerts };
      if (presets.length === 0) delete alerts[id];
      else alerts[id] = presets;
      return { ...current, alerts };
    });
  }, []);

  const markNotificationsRead = useCallback(() => {
    setState((current) => ({ ...current, unreadNotifications: 0 }));
  }, []);

  const resetDemo = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
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
      resetDemo,
    }),
    [
      completeOnboarding,
      markNotificationsRead,
      resetDemo,
      setAlertPresets,
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

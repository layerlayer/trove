import { useMemo } from "react";
import { useTrove } from "../context/TroveContext";
import { useReleases } from "../data/ReleaseDataContext";
import { buildNotifications } from "./notifications";

/** 헤더 종 아이콘 배지: 마지막으로 알림 센터를 본 뒤 울린 알림 수 */
export function useUnreadNotifications(): number {
  const { releases } = useReleases();
  const { state } = useTrove();
  const { favorites, alerts, settings, notificationsSeenIds } = state;
  return useMemo(
    () => buildNotifications(releases, { favorites, alerts, settings, notificationsSeenIds }).unreadCount,
    [alerts, favorites, notificationsSeenIds, releases, settings],
  );
}

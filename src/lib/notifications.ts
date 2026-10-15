import type { AlertPreset, ReleaseItem, TroveState } from "../types";
import { parseLocalDate, toLocalIso } from "./date";

/**
 * 알림 센터의 재료. 서버 푸시가 없는 MVP 라서, 담아 둔 일정과 알림 설정(D-7·D-1·D-Day)에서
 * "울렸어야 할 알림"과 "앞으로 울릴 알림"을 그 자리에서 계산한다.
 */
export type NotificationKind = "D-7" | "D-1" | "D-Day" | "released";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  item: ReleaseItem;
  /** 울리는(울린) 날짜 "YYYY-MM-DD" */
  at: string;
  title: string;
  body: string;
}

export interface NotificationDigest {
  /** 이미 울린 알림. 최근 것이 먼저 */
  fired: AppNotification[];
  /** 앞으로 울릴 알림. 가까운 것이 먼저 */
  scheduled: AppNotification[];
  /** 알림 센터에서 아직 보지 않은, 울린 알림 수 */
  unreadCount: number;
}

/** 울린 지 이 일수가 지난 알림은 목록에서 뺀다 */
const KEEP_DAYS = 30;

const OFFSETS: Record<Exclude<NotificationKind, "released">, number> = { "D-7": -7, "D-1": -1, "D-Day": 0 };

function shiftDate(iso: string, days: number): string {
  const date = parseLocalDate(iso);
  date.setDate(date.getDate() + days);
  return toLocalIso(date);
}

function presetsFor(item: ReleaseItem, state: Pick<TroveState, "alerts" | "settings">): AlertPreset[] {
  return state.alerts[item.id] ?? state.settings.defaultAlerts;
}

function copyFor(kind: NotificationKind, item: ReleaseItem): { title: string; body: string } {
  const label = item.dateLabel || "출시일";
  switch (kind) {
    case "D-7":
      return { title: `${item.title}, 일주일 남았어요`, body: `${label}이 다음 주예요. 기다림을 미리 챙겨 두세요.` };
    case "D-1":
      return { title: `내일이에요: ${item.title}`, body: `${label} 하루 전이에요. 내일 다시 한 번 알려드릴게요.` };
    case "D-Day":
      return { title: `오늘이에요: ${item.title}`, body: `기다리던 ${label}이 오늘이에요.` };
    case "released":
      return { title: `${item.title}, 이제 만날 수 있어요`, body: `${label}이 지났어요. 어땠는지 확인해 보세요.` };
  }
}

export function buildNotifications(
  releases: ReleaseItem[],
  state: Pick<TroveState, "favorites" | "alerts" | "settings" | "notificationsSeenIds">,
  today: string = toLocalIso(new Date()),
): NotificationDigest {
  const oldest = shiftDate(today, -KEEP_DAYS);
  const fired: AppNotification[] = [];
  const scheduled: AppNotification[] = [];
  const byId = new Map(releases.map((item) => [item.id, item]));

  for (const id of state.favorites) {
    const item = byId.get(id);
    if (!item?.releaseAt) continue;
    const presets = presetsFor(item, state);
    // 빈 배열 = 사용자가 알림을 껐다. 아무것도 만들지 않는다
    if (presets.length === 0) continue;
    const kinds = (Object.keys(OFFSETS) as Array<keyof typeof OFFSETS>).filter((kind) => presets.includes(kind));
    for (const kind of kinds) {
      const at = shiftDate(item.releaseAt, OFFSETS[kind]);
      const entry: AppNotification = { id: `${item.id}:${kind}`, kind, item, at, ...copyFor(kind, item) };
      if (at <= today) {
        if (at >= oldest) fired.push(entry);
      } else {
        scheduled.push(entry);
      }
    }
    // D-Day 알림을 끈 채로 지나간 일정은 "나왔어요" 로 한 번만 알려 준다
    if (!presets.includes("D-Day") && item.releaseAt < today && item.releaseAt >= oldest) {
      fired.push({ id: `${item.id}:released`, kind: "released", item, at: item.releaseAt, ...copyFor("released", item) });
    }
  }

  fired.sort((a, b) => (a.at === b.at ? a.item.title.localeCompare(b.item.title, "ko-KR") : b.at.localeCompare(a.at)));
  scheduled.sort((a, b) => (a.at === b.at ? a.item.title.localeCompare(b.item.title, "ko-KR") : a.at.localeCompare(b.at)));

  const seen = new Set(state.notificationsSeenIds);
  const unreadCount = fired.filter((entry) => !seen.has(entry.id)).length;
  return { fired, scheduled, unreadCount };
}

/** 알림이 울린 날을 사람 말로: 오늘 / 어제 / 3일 전 / 10.02 */
export function firedLabel(at: string, today: string = toLocalIso(new Date())): string {
  const diff = Math.round((parseLocalDate(today).getTime() - parseLocalDate(at).getTime()) / 86_400_000);
  if (diff <= 0) return "오늘";
  if (diff === 1) return "어제";
  if (diff < 7) return `${diff}일 전`;
  return at.slice(5).replace("-", ".");
}

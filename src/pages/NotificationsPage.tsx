import "./NotificationsPage.css";
import {
  ArrowLeft,
  BellRing,
  CalendarClock,
  PartyPopper,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthSheet } from "../components/AuthSheet";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { useReleases } from "../data/ReleaseDataContext";
import { track } from "../lib/analytics";
import { dDayLabel, formatDate } from "../lib/date";
import { useBack } from "../lib/useBack";
import {
  buildNotifications,
  firedLabel,
  type AppNotification,
  type NotificationKind,
} from "../lib/notifications";

/** 알림 종류별 아이콘. D-7 은 달력, D-1 은 종, D-Day 는 축하, 지나간 일정은 반짝임 */
const KIND_ICONS: Record<NotificationKind, LucideIcon> = {
  "D-7": CalendarClock,
  "D-1": BellRing,
  "D-Day": PartyPopper,
  released: Sparkles,
};

interface NotificationRowProps {
  entry: AppNotification;
  variant: "fired" | "scheduled";
  unread?: boolean;
  onOpen: () => void;
}

/**
 * 알림 한 줄. 전역 .notification-item 모양을 그대로 쓰되, 줄 전체를 버튼으로 만들어 일정 상세로 보낸다.
 * 버튼 안에는 구문 요소만 둘 수 있어 본문은 <p> 대신 같은 모양의 <span> 으로 그린다.
 */
function NotificationRow({ entry, variant, unread = false, onOpen }: NotificationRowProps) {
  const Icon = KIND_ICONS[entry.kind];
  const className = ["notif-row", `notif-row--${variant}`, variant === "fired" && !unread ? "is-read" : ""]
    .filter(Boolean)
    .join(" ");
  const when = variant === "fired" ? firedLabel(entry.at) : `${formatDate(entry.at)} · ${dDayLabel(entry.at)}`;

  return (
    <li className="notification-item notif-item">
      <button className={className} type="button" onClick={onOpen}>
        <span className="notification-item__icon" aria-hidden="true">
          <Icon size={20} />
        </span>
        <span className="notification-item__content notif-row__content">
          <strong className="notif-row__title">
            {unread ? <span className="notif-dot" role="img" aria-label="안 읽음" /> : null}
            {entry.title}
          </strong>
          <span className="notif-row__body">{entry.body}</span>
          <time dateTime={entry.at}>{when}</time>
        </span>
      </button>
    </li>
  );
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const { state, markNotificationsRead } = useTrove();
  const { releases } = useReleases();
  // 화면에 들어온 순간의 "마지막으로 본 시각". 곧바로 읽음 처리해도 안 읽음 점이 그 자리에서 사라지지 않게 한 번만 잡아 둔다
  const [seenBefore] = useState(() => new Set(state.notificationsSeenIds));
  const goBack = useBack("/home");
  const [authOpen, setAuthOpen] = useState(false);
  const viewedRef = useRef(false);

  const digest = useMemo(
    () =>
      buildNotifications(releases, {
        favorites: state.favorites,
        alerts: state.alerts,
        settings: state.settings,
        notificationsSeenIds: state.notificationsSeenIds,
      }),
    [releases, state.favorites, state.alerts, state.settings, state.notificationsSeenIds],
  );

  // 들어온 순간에 잡아 둔 "본 알림" 목록으로만 판단해, 읽음 처리 뒤에도 점이 그 자리에서 사라지지 않는다
  const isUnread = (entry: AppNotification) => !seenBefore.has(entry.id);
  const unreadCount = digest.fired.filter(isUnread).length;

  // 들어올 때 한 번만: 읽음 처리와 조회 기록
  const firedIds = digest.fired.map((entry) => entry.id).join("|");
  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    markNotificationsRead(firedIds ? firedIds.split("|") : []);
    track("notifications_view", { fired: digest.fired.length });
  }, [digest.fired.length, firedIds, markNotificationsRead]);

  const hasFavorites = state.favorites.length > 0;
  // presetsFor 와 같은 규칙: 키가 없으면 기본 알림, 빈 배열이면 꺼진 것
  const hasAlertsOn = state.favorites.some((id) => (state.alerts[id] ?? state.settings.defaultAlerts).length > 0);
  const openRelease = (entry: AppNotification) => navigate(`/release/${entry.item.slug}`);

  return (
    <main className="app-page notif-page">
      <StatusBar />
      <header className="simple-header notif-header">
        <button className="icon-button" type="button" aria-label="뒤로 가기" onClick={goBack}>
          <ArrowLeft size={28} strokeWidth={1.8} />
        </button>
        <h1 className="notif-header__title">알림</h1>
        <button className="icon-button" type="button" aria-label="알림 설정" onClick={() => navigate("/profile")}>
          <SlidersHorizontal size={24} strokeWidth={1.8} />
        </button>
      </header>

      {!hasFavorites ? (
        <div className="empty-state notif-empty-state">
          <strong>담아 둔 기다림이 없어요</strong>
          <p>담기를 눌러 두면 설정한 시점(기본 D-1·D-Day)에 여기서 알려드려요.</p>
          <button className="primary-button" type="button" onClick={() => navigate("/discover")}>
            기다림 찾아보기
          </button>
          {!state.user ? (
            <button className="text-button" type="button" onClick={() => setAuthOpen(true)}>
              로그인
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <section className="notif-section" aria-labelledby="notif-fired-heading">
            <div className="notif-section__heading">
              <h2 id="notif-fired-heading">새 소식</h2>
              {unreadCount > 0 ? (
                <span className="notif-section__count">
                  {unreadCount}
                  <span className="sr-only">개 안 읽음</span>
                </span>
              ) : null}
            </div>
            {digest.fired.length > 0 ? (
              <ul className="notification-list notif-list">
                {digest.fired.map((entry) => (
                  <NotificationRow key={entry.id} entry={entry} variant="fired" unread={isUnread(entry)} onOpen={() => openRelease(entry)} />
                ))}
              </ul>
            ) : (
              <p className="notif-empty">아직 울린 알림이 없어요. 가까운 일정이 오면 여기에 쌓여요.</p>
            )}
          </section>

          <section className="notif-section" aria-labelledby="notif-scheduled-heading">
            <div className="notif-section__heading">
              <h2 id="notif-scheduled-heading">예정된 알림</h2>
              {digest.scheduled.length > 0 ? <span className="notif-section__meta">{digest.scheduled.length}개</span> : null}
            </div>
            {digest.scheduled.length > 0 ? (
              <ul className="notification-list notif-list">
                {digest.scheduled.map((entry) => (
                  <NotificationRow key={entry.id} entry={entry} variant="scheduled" onOpen={() => openRelease(entry)} />
                ))}
              </ul>
            ) : (
              <p className="notif-empty">
                {hasAlertsOn
                  ? "앞으로 울릴 알림이 없어요. 새 기다림을 담으면 설정한 시점에 여기에 쌓여요."
                  : "예정된 알림이 없어요. 일정 상세에서 알림을 켤 수 있어요."}
              </p>
            )}
          </section>
        </>
      )}

      <p className="notif-note">
        브라우저 푸시 알림은 아직 연결 전이에요. 지금은 앱을 열었을 때 이 목록에서 확인하고, 알림 시점은 프로필 &gt; 알림에서 바꿀 수 있어요.
      </p>

      <AuthSheet
        open={authOpen}
        intentLabel="알림을 받으려면 로그인해주세요"
        onClose={() => setAuthOpen(false)}
        onAuthenticated={() => setAuthOpen(false)}
      />
    </main>
  );
}

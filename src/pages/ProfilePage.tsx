import {
  Bell,
  BellRing,
  ChevronRight,
  LogOut,
  Mail,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  UserCircle,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { AuthSheet } from "../components/AuthSheet";
import { BottomNav } from "../components/BottomNav";
import { BottomSheet } from "../components/BottomSheet";
import { NotificationList } from "../components/NotificationList";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { interests } from "../data/mock";
import { track } from "../lib/analytics";
import type { AlertPreset } from "../types";

type ProfileSheet = "notifications" | "logout" | "reset" | null;

const defaultAlertOptions: Array<{ id: AlertPreset; label: string }> = [
  { id: "D-7", label: "일주일 전" },
  { id: "D-1", label: "하루 전" },
  { id: "D-Day", label: "출시 당일" },
];

export function ProfilePage() {
  const navigate = useNavigate();
  const {
    state,
    signOut,
    setDefaultAlerts,
    setWeeklyDigest,
    setNotificationPermission,
    markNotificationsRead,
    resetDemo,
  } = useTrove();
  const [sheet, setSheet] = useState<ProfileSheet>(null);
  const [authOpen, setAuthOpen] = useState(false);

  const selectedInterests = interests.filter((interest) => state.interests.includes(interest.id));
  const reminderCount = Object.values(state.alerts).filter((alerts) => alerts.length > 0).length;

  const requestNotifications = async () => {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted") track("notification_permission_granted");
  };

  const toggleDefaultAlert = (preset: AlertPreset) => {
    const current = state.settings.defaultAlerts;
    setDefaultAlerts(current.includes(preset) ? current.filter((item) => item !== preset) : [...current, preset]);
  };

  const permissionLabel = {
    granted: "허용됨",
    denied: "차단됨",
    default: "허용 필요",
    unsupported: "지원하지 않음",
  }[state.settings.notificationPermission];

  return (
    <main className="app-page profile-page">
      <StatusBar />
      <AppHeader
        unreadCount={state.unreadNotifications}
        onNotifications={() => {
          markNotificationsRead();
          setSheet("notifications");
        }}
      />

      <section className="page-heading profile-heading">
        <span className="eyebrow">YOUR TROVE</span>
        <h1>Profile</h1>
      </section>

      {!state.user ? (
        <section className="signed-out-panel profile-signed-out">
          <span className="signed-out-panel__icon"><UserCircle size={32} /></span>
          <h2>기다림을 나답게 모아보세요</h2>
          <p>로그인하면 취향과 알림 설정을 저장하고 이어서 사용할 수 있어요.</p>
          <button className="primary-button" type="button" onClick={() => setAuthOpen(true)}>로그인 / 회원가입</button>
        </section>
      ) : (
        <>
          <section className="profile-card">
            <span className="profile-avatar">{state.user.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{state.user.name}</strong><span>{state.user.email}</span></div>
            <span className="profile-plan-badge">FREE</span>
          </section>

          <section className="profile-stats">
            <div><strong>{state.favorites.length}</strong><span>기다림</span></div>
            <div><strong>{reminderCount}</strong><span>알림</span></div>
            <div><strong>{selectedInterests.length}</strong><span>관심사</span></div>
          </section>

          <section className="premium-card">
            <span><Sparkles size={22} /></span>
            <div><strong>Trove Plus</strong><p>무제한 알림과 맞춤 캘린더를 준비 중이에요.</p></div>
            <small>COMING SOON</small>
          </section>
        </>
      )}

      <section className="settings-section">
        <h2>내 취향</h2>
        <button className="settings-row" type="button" onClick={() => navigate("/preferences", { state: { returnTo: "/profile" } }) }>
          <span className="settings-row__icon"><SlidersHorizontal size={20} /></span>
          <span className="settings-row__copy"><strong>관심사 수정</strong><small>{selectedInterests.length > 0 ? selectedInterests.map((item) => item.label).slice(0, 3).join(", ") : "관심사를 선택해주세요"}</small></span>
          <ChevronRight size={20} />
        </button>
      </section>

      <section className="settings-section">
        <h2>알림</h2>
        <button className="settings-row" type="button" onClick={requestNotifications}>
          <span className="settings-row__icon"><Bell size={20} /></span>
          <span className="settings-row__copy"><strong>브라우저 알림</strong><small>{permissionLabel}</small></span>
          <span className={`status-text status-text--${state.settings.notificationPermission}`}>{permissionLabel}</span>
        </button>

        <div className="settings-card">
          <div className="settings-card__heading">
            <div><strong>기본 알림 시점</strong><small>새 알림을 설정할 때 미리 선택돼요.</small></div>
            <BellRing size={20} />
          </div>
          <div className="settings-toggle-list">
            {defaultAlertOptions.map((option) => (
              <label key={option.id}>
                <span>{option.label}</span>
                <input
                  type="checkbox"
                  checked={state.settings.defaultAlerts.includes(option.id)}
                  onChange={() => toggleDefaultAlert(option.id)}
                />
                <i aria-hidden="true" />
              </label>
            ))}
          </div>
        </div>

        <label className="settings-row settings-row--toggle">
          <span className="settings-row__icon"><Mail size={20} /></span>
          <span className="settings-row__copy"><strong>주간 기다림 요약</strong><small>매주 다가오는 출시를 모아봐요.</small></span>
          <input type="checkbox" checked={state.settings.weeklyDigest} onChange={(event) => setWeeklyDigest(event.target.checked)} />
          <i aria-hidden="true" />
        </label>
      </section>

      {state.user ? (
        <section className="settings-section profile-danger-zone">
          <h2>계정</h2>
          <button className="settings-row" type="button" onClick={() => setSheet("logout")}>
            <span className="settings-row__icon"><LogOut size={20} /></span>
            <span className="settings-row__copy"><strong>로그아웃</strong><small>이 기기의 세션을 종료합니다.</small></span>
            <ChevronRight size={20} />
          </button>
          <button className="settings-row is-danger" type="button" onClick={() => setSheet("reset")}>
            <span className="settings-row__icon"><RotateCcw size={20} /></span>
            <span className="settings-row__copy"><strong>MVP 데이터 초기화</strong><small>관심사와 저장 목록을 모두 지웁니다.</small></span>
            <ChevronRight size={20} />
          </button>
        </section>
      ) : null}

      <BottomNav active="profile" />

      <BottomSheet open={sheet === "notifications"} title="새로운 소식" description="기다리는 일정의 중요한 변화만 모았어요." onClose={() => setSheet(null)}>
        <NotificationList />
      </BottomSheet>

      <BottomSheet open={sheet === "logout"} title="로그아웃할까요?" description="이 브라우저의 저장 목록은 유지되며, 다시 로그인하면 이어볼 수 있어요." onClose={() => setSheet(null)}>
        <button className="danger-button sheet-button" type="button" onClick={() => { signOut(); setSheet(null); }}>로그아웃</button>
        <button className="text-button sheet-text-button" type="button" onClick={() => setSheet(null)}>취소</button>
      </BottomSheet>

      <BottomSheet open={sheet === "reset"} title="모든 MVP 데이터를 지울까요?" description="관심사, Trove, 알림 설정과 로그인 정보가 초기화됩니다." onClose={() => setSheet(null)}>
        <button className="danger-button sheet-button" type="button" onClick={() => { resetDemo(); navigate("/preferences", { replace: true }); }}>모두 초기화</button>
        <button className="text-button sheet-text-button" type="button" onClick={() => setSheet(null)}>취소</button>
      </BottomSheet>

      <AuthSheet open={authOpen} intentLabel="Profile을 사용하려면 로그인해주세요" onClose={() => setAuthOpen(false)} onAuthenticated={() => setAuthOpen(false)} />
    </main>
  );
}

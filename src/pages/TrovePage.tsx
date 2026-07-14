import { BellRing, CalendarDays, Check, Gem, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { AuthSheet } from "../components/AuthSheet";
import { BottomNav } from "../components/BottomNav";
import { BottomSheet } from "../components/BottomSheet";
import { NotificationList } from "../components/NotificationList";
import { ReleaseListItem } from "../components/ReleaseListItem";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { releases } from "../data/mock";
import { daysUntil } from "../lib/date";
import { track } from "../lib/analytics";
import type { AlertPreset, ReleaseItem } from "../types";

type TroveSheet = "notifications" | "alerts" | "remove" | null;

const alertOptions: Array<{ id: AlertPreset; title: string; description: string }> = [
  { id: "D-7", title: "일주일 전", description: "기대감을 천천히 끌어올려요." },
  { id: "D-1", title: "하루 전", description: "마지막 준비를 놓치지 않아요." },
  { id: "D-Day", title: "출시 당일", description: "기다림이 끝나는 순간 알려드려요." },
];

interface TroveGroup {
  id: string;
  label: string;
  description: string;
  items: ReleaseItem[];
}

function groupTroveItems(items: ReleaseItem[]): TroveGroup[] {
  const now = new Date();
  const thisMonth = (item: ReleaseItem) => {
    if (!item.releaseAt) return false;
    const [year, month] = item.releaseAt.split("-").map(Number);
    return year === now.getFullYear() && month === now.getMonth() + 1;
  };
  const sortDate = (a: ReleaseItem, b: ReleaseItem) => (a.releaseAt ?? "9999").localeCompare(b.releaseAt ?? "9999");

  return [
    {
      id: "soon",
      label: "7일 이내",
      description: "곧 기다림이 끝나요",
      items: items.filter((item) => {
        const days = daysUntil(item.releaseAt);
        return days !== null && days >= 0 && days <= 7;
      }).sort(sortDate),
    },
    {
      id: "month",
      label: "이번 달",
      description: "이번 달에 만날 기다림",
      items: items.filter((item) => {
        const days = daysUntil(item.releaseAt);
        return days !== null && days > 7 && thisMonth(item);
      }).sort(sortDate),
    },
    {
      id: "later",
      label: "그 이후",
      description: "조금 더 천천히 기다려요",
      items: items.filter((item) => {
        const days = daysUntil(item.releaseAt);
        return days !== null && days > 7 && !thisMonth(item);
      }).sort(sortDate),
    },
    {
      id: "tba",
      label: "날짜 미정",
      description: "날짜가 정해지면 알려드려요",
      items: items.filter((item) => item.releaseAt === null),
    },
    {
      id: "complete",
      label: "기다림 완료",
      description: "기다렸던 순간의 기록",
      items: items.filter((item) => {
        const days = daysUntil(item.releaseAt);
        return days !== null && days < 0;
      }).sort(sortDate),
    },
  ].filter((group) => group.items.length > 0);
}

export function TrovePage() {
  const navigate = useNavigate();
  const { state, toggleFavorite, setAlertPresets, markNotificationsRead } = useTrove();
  const [sheet, setSheet] = useState<TroveSheet>(null);
  const [selectedItem, setSelectedItem] = useState<ReleaseItem | null>(null);
  const [draftAlerts, setDraftAlerts] = useState<AlertPreset[]>([]);
  const [authOpen, setAuthOpen] = useState(false);

  const savedItems = useMemo(
    () => releases.filter((item) => state.favorites.includes(item.id)),
    [state.favorites],
  );
  const groups = useMemo(() => groupTroveItems(savedItems), [savedItems]);
  const activeAlertCount = Object.values(state.alerts).filter((presets) => presets.length > 0).length;

  const openAlerts = (item: ReleaseItem) => {
    setSelectedItem(item);
    setDraftAlerts(state.alerts[item.id] ?? state.settings.defaultAlerts);
    setSheet("alerts");
  };

  const askRemove = (item: ReleaseItem) => {
    setSelectedItem(item);
    setSheet("remove");
  };

  const saveAlerts = () => {
    if (!selectedItem) return;
    const nextAlerts: AlertPreset[] = selectedItem.releaseAt
      ? draftAlerts
      : ["DATE_CONFIRMED", "DATE_CHANGED"];
    setAlertPresets(selectedItem.id, nextAlerts);
    if (nextAlerts.length > 0) {
      track("reminder_enabled", { item_id: selectedItem.id, count: nextAlerts.length, surface: "trove" });
    }
    setSheet(null);
  };

  return (
    <main className="app-page trove-page">
      <StatusBar />
      <AppHeader
        unreadCount={state.unreadNotifications}
        onNotifications={() => {
          markNotificationsRead();
          setSheet("notifications");
        }}
      />

      <section className="page-heading trove-heading">
        <span className="eyebrow">MY FUTURE</span>
        <h1>내가 기다리는 것들</h1>
        <p>기다림을 날짜순으로 모아보고, 중요한 순간을 놓치지 마세요.</p>
      </section>

      {!state.user ? (
        <section className="signed-out-panel">
          <span className="signed-out-panel__icon"><Gem size={30} /></span>
          <h2>내 Trove를 어디서든 이어보세요</h2>
          <p>로그인하면 저장한 콘텐츠와 알림 설정을 한곳에서 관리할 수 있어요.</p>
          <button className="primary-button" type="button" onClick={() => setAuthOpen(true)}>로그인하고 시작하기</button>
          <button className="text-button" type="button" onClick={() => navigate("/discover")}>먼저 둘러보기</button>
        </section>
      ) : savedItems.length === 0 ? (
        <section className="empty-trove-panel">
          <span><Sparkles size={28} /></span>
          <h2>첫 번째 기다림을 담아보세요</h2>
          <p>영화, 게임, 음악, 스니커즈까지<br />마음 가는 출시를 모을 수 있어요.</p>
          <button className="primary-button" type="button" onClick={() => navigate("/discover")}>Discover 둘러보기</button>
        </section>
      ) : (
        <>
          <section className="trove-summary">
            <div>
              <span>담은 기다림</span>
              <strong>{savedItems.length}</strong>
            </div>
            <div>
              <span>알림 켜짐</span>
              <strong>{activeAlertCount}</strong>
            </div>
            <button type="button" onClick={() => navigate("/trove/calendar")}> 
              <CalendarDays size={19} /> 캘린더
            </button>
          </section>

          <section className="trove-groups">
            {groups.map((group) => (
              <div className="trove-group" key={group.id}>
                <div className="trove-group__heading">
                  <div><h2>{group.label}</h2><p>{group.description}</p></div>
                  <span>{group.items.length}</span>
                </div>
                <div className="release-list">
                  {group.items.map((item) => (
                    <ReleaseListItem
                      key={item.id}
                      item={item}
                      saved
                      hasAlerts={(state.alerts[item.id] ?? []).length > 0}
                      onOpen={() => navigate(`/release/${item.slug}`)}
                      onAlerts={() => openAlerts(item)}
                      onSave={() => askRemove(item)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      <BottomNav active="trove" />

      <BottomSheet open={sheet === "notifications"} title="새로운 소식" description="내가 기다리는 일정의 변화를 모았어요." onClose={() => setSheet(null)}>
        <NotificationList />
      </BottomSheet>

      <BottomSheet
        open={sheet === "alerts"}
        title="언제 알려드릴까요?"
        description={`${selectedItem?.title ?? "선택한 기다림"}의 알림을 관리하세요.`}
        onClose={() => setSheet(null)}
      >
        {selectedItem?.releaseAt ? (
          <div className="alert-options">
            {alertOptions.map((option) => {
              const selected = draftAlerts.includes(option.id);
              return (
                <button
                  className={selected ? "is-selected" : ""}
                  type="button"
                  aria-pressed={selected}
                  key={option.id}
                  onClick={() => setDraftAlerts((current) => current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id])}
                >
                  <span className="alert-options__icon">{selected ? <Check size={18} strokeWidth={3} /> : <BellRing size={18} />}</span>
                  <span><strong>{option.title}</strong><small>{option.description}</small></span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="tba-alert-note">
            <BellRing size={22} />
            <div><strong>출시일이 확정되면 알려드릴게요</strong><p>날짜 변경도 함께 추적해요.</p></div>
          </div>
        )}
        <button className="primary-button sheet-button" type="button" onClick={saveAlerts}>
          {draftAlerts.length > 0 || selectedItem?.releaseAt === null ? "알림 저장" : "알림 해제"}
        </button>
      </BottomSheet>

      <BottomSheet
        open={sheet === "remove"}
        title="Trove에서 뺄까요?"
        description="설정한 알림도 함께 해제됩니다."
        onClose={() => setSheet(null)}
      >
        <button className="danger-button sheet-button" type="button" onClick={() => {
          if (selectedItem) {
            toggleFavorite(selectedItem.id);
            track("remove_from_trove", { item_id: selectedItem.id, surface: "trove" });
          }
          setSheet(null);
        }}>Trove에서 빼기</button>
        <button className="text-button sheet-text-button" type="button" onClick={() => setSheet(null)}>취소</button>
      </BottomSheet>

      <AuthSheet
        open={authOpen}
        intentLabel="내 Trove를 시작하려면 로그인해주세요"
        onClose={() => setAuthOpen(false)}
        onAuthenticated={() => setAuthOpen(false)}
      />
    </main>
  );
}

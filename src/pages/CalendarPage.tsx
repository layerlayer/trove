import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { BottomNav } from "../components/BottomNav";
import { BottomSheet } from "../components/BottomSheet";
import { NotificationList } from "../components/NotificationList";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { releases } from "../data/mock";
import {
  dDayLabel,
  formatDate,
  isSameDay,
  isSameMonth,
  parseLocalDate,
} from "../lib/date";
import type { ReleaseItem } from "../types";

type CalendarView = "month" | "week";
type CalendarSheet = "notifications" | "menu" | "month-picker" | null;

const dayNames = ["일", "월", "화", "수", "목", "금", "토"];

function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function getMonthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function getWeekGrid(selected: Date): Date[] {
  const start = startOfWeek(selected);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function EventRow({ item, onOpen }: { item: ReleaseItem; onOpen: () => void }) {
  return (
    <button className="calendar-event" type="button" onClick={onOpen}>
      <img src={item.thumbnail} alt="" />
      <span className="calendar-event__copy">
        <span className="calendar-event__heading">
          <strong>{item.title}</strong>
          <b>{dDayLabel(item.releaseAt)}</b>
        </span>
        <span className="calendar-event__meta">
          {item.dateLabel} <time>{formatDate(item.releaseAt)}</time>
        </span>
      </span>
    </button>
  );
}

export function CalendarPage() {
  const navigate = useNavigate();
  const { state, markNotificationsRead, resetDemo } = useTrove();
  const firstTracked =
    releases.find((item) => state.favorites.includes(item.id) && item.releaseAt) ??
    releases.find((item) => item.releaseAt) ??
    releases[0];
  const initialDate = firstTracked.releaseAt ? parseLocalDate(firstTracked.releaseAt) : new Date();
  const [viewDate, setViewDate] = useState(
    () => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1, 12),
  );
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [calendarView, setCalendarView] = useState<CalendarView>("month");
  const [sheet, setSheet] = useState<CalendarSheet>(null);

  const trackedIds = useMemo(
    () => new Set([...state.favorites, ...Object.keys(state.alerts)]),
    [state.alerts, state.favorites],
  );
  const trackedReleases = useMemo(
    () => releases.filter((item) => trackedIds.has(item.id)),
    [trackedIds],
  );

  const visibleDays = useMemo(
    () => (calendarView === "month" ? getMonthGrid(viewDate) : getWeekGrid(selectedDate)),
    [calendarView, selectedDate, viewDate],
  );

  const releasesByDay = useMemo(() => {
    const map = new Map<string, ReleaseItem[]>();
    trackedReleases.forEach((item) => {
      if (!item.releaseAt) return;
      const existing = map.get(item.releaseAt) ?? [];
      map.set(item.releaseAt, [...existing, item]);
    });
    return map;
  }, [trackedReleases]);

  const monthCount = trackedReleases.filter((item) =>
    item.releaseAt ? isSameMonth(parseLocalDate(item.releaseAt), viewDate) : false,
  ).length;

  const selectedIso = [
    selectedDate.getFullYear(),
    String(selectedDate.getMonth() + 1).padStart(2, "0"),
    String(selectedDate.getDate()).padStart(2, "0"),
  ].join("-");

  const selectedItems = releasesByDay.get(selectedIso) ?? [];
  const listItems = selectedItems.length
    ? selectedItems
    : trackedReleases
        .filter((item) => item.releaseAt !== null && item.releaseAt >= selectedIso)
        .sort((a, b) => (a.releaseAt ?? "").localeCompare(b.releaseAt ?? ""))
        .slice(0, 3);

  const changeMonth = (offset: number) => {
    const next = new Date(viewDate.getFullYear(), viewDate.getMonth() + offset, 1, 12);
    setViewDate(next);
    setSelectedDate(next);
    setSheet(null);
  };

  const chooseDay = (day: Date) => {
    setSelectedDate(day);
    if (!isSameMonth(day, viewDate)) {
      setViewDate(new Date(day.getFullYear(), day.getMonth(), 1, 12));
    }
  };

  return (
    <main className="app-page calendar-page">
      <StatusBar />
      <AppHeader
        unreadCount={state.unreadNotifications}
        onNotifications={() => {
          markNotificationsRead();
          setSheet("notifications");
        }}
        onMenu={() => setSheet("menu")}
      />

      <section className="calendar-intro">
        <h1>
          이번 달
          <br />
          내가 기다리는 {monthCount}가지
        </h1>
        <div className="calendar-toolbar">
          <button
            className="month-trigger"
            type="button"
            aria-label="표시할 달 선택"
            onClick={() => setSheet("month-picker")}
          >
            {viewDate.getFullYear()}. {String(viewDate.getMonth() + 1).padStart(2, "0")}
            <ChevronDown size={20} />
          </button>
          <div className="view-segment" aria-label="캘린더 보기 방식">
            <button
              className={calendarView === "month" ? "is-active" : ""}
              type="button"
              aria-pressed={calendarView === "month"}
              onClick={() => setCalendarView("month")}
            >
              월
            </button>
            <button
              className={calendarView === "week" ? "is-active" : ""}
              type="button"
              aria-pressed={calendarView === "week"}
              onClick={() => setCalendarView("week")}
            >
              주
            </button>
          </div>
        </div>
      </section>

      <section className={`calendar-board calendar-board--${calendarView}`} aria-label="출시 캘린더">
        <div className="calendar-weekdays">
          {dayNames.map((name, index) => (
            <span className={index === 0 ? "is-sunday" : index === 6 ? "is-saturday" : ""} key={name}>
              {name}
            </span>
          ))}
        </div>
        <div className="calendar-grid">
          {visibleDays.map((day) => {
            const iso = [
              day.getFullYear(),
              String(day.getMonth() + 1).padStart(2, "0"),
              String(day.getDate()).padStart(2, "0"),
            ].join("-");
            const events = releasesByDay.get(iso) ?? [];
            const selected = isSameDay(day, selectedDate);
            const outside = calendarView === "month" && !isSameMonth(day, viewDate);
            return (
              <button
                key={iso}
                className={`calendar-day ${selected ? "is-selected" : ""} ${outside ? "is-outside" : ""}`}
                type="button"
                aria-label={`${day.getMonth() + 1}월 ${day.getDate()}일, 일정 ${events.length}개`}
                aria-pressed={selected}
                onClick={() => chooseDay(day)}
              >
                <span>{day.getDate()}</span>
                {events.length > 0 ? (
                  <span className="calendar-dots" aria-hidden="true">
                    {events.slice(0, 3).map((event) => (
                      <i key={event.id} />
                    ))}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="calendar-events" aria-live="polite">
        {listItems.length > 0 ? (
          listItems.map((item) => (
            <EventRow
              key={item.id}
              item={item}
              onOpen={() => navigate(`/release/${item.slug}`)}
            />
          ))
        ) : (
          <div className="empty-state calendar-empty">
            <CalendarDays size={28} />
            <strong>이후에 예정된 기다림이 없어요</strong>
            <p>홈에서 새로운 출시작을 저장해보세요.</p>
          </div>
        )}
      </section>

      <BottomNav active="trove" />

      <BottomSheet
        open={sheet === "notifications"}
        title="새로운 소식"
        description="날짜 변경과 임박 알림을 놓치지 마세요."
        onClose={() => setSheet(null)}
      >
        <NotificationList />
      </BottomSheet>

      <BottomSheet
        open={sheet === "month-picker"}
        title="달 이동"
        description="확인하고 싶은 출시 일정의 달을 선택하세요."
        onClose={() => setSheet(null)}
      >
        <div className="month-picker-actions">
          <button type="button" onClick={() => changeMonth(-1)}>
            <ChevronLeft size={19} /> 이전 달
          </button>
          <button
            type="button"
            onClick={() => {
              const now = new Date();
              const current = new Date(now.getFullYear(), now.getMonth(), 1, 12);
              setViewDate(current);
              setSelectedDate(now);
              setSheet(null);
            }}
          >
            이번 달
          </button>
          <button type="button" onClick={() => changeMonth(1)}>
            다음 달 <ChevronRight size={19} />
          </button>
        </div>
      </BottomSheet>

      <BottomSheet
        open={sheet === "menu"}
        title="Trove 설정"
        description="취향과 데모 데이터를 관리할 수 있어요."
        onClose={() => setSheet(null)}
      >
        <div className="menu-actions">
          <button type="button" onClick={() => navigate("/preferences")}>
            취향 다시 고르기
          </button>
          <button
            className="is-danger"
            type="button"
            onClick={() => {
              resetDemo();
              navigate("/preferences");
            }}
          >
            데모 데이터 초기화
          </button>
        </div>
      </BottomSheet>

    </main>
  );
}

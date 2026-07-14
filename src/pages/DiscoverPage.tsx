import { Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { AuthSheet } from "../components/AuthSheet";
import { BottomNav } from "../components/BottomNav";
import { BottomSheet } from "../components/BottomSheet";
import { NotificationList } from "../components/NotificationList";
import { ReleaseListItem } from "../components/ReleaseListItem";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { categories, releases } from "../data/mock";
import { daysUntil } from "../lib/date";
import { track } from "../lib/analytics";
import type { Category, ReleaseItem } from "../types";

type Period = "all" | "week" | "month" | "tba";
type Sort = "release" | "popular" | "new";
type DiscoverSheet = "notifications" | "filters" | "saved" | null;

const periodLabels: Record<Period, string> = {
  all: "전체 기간",
  week: "이번 주",
  month: "이번 달",
  tba: "날짜 미정",
};

const sortLabels: Record<Sort, string> = {
  release: "출시일순",
  popular: "인기순",
  new: "새로 추가됨",
};

function matchesPeriod(item: ReleaseItem, period: Period) {
  if (period === "tba") return item.releaseAt === null;
  if (period === "all") return true;
  const days = daysUntil(item.releaseAt);
  if (days === null || days < 0) return false;
  return period === "week" ? days <= 7 : days <= 31;
}

export function DiscoverPage() {
  const navigate = useNavigate();
  const { state, toggleFavorite, markNotificationsRead } = useTrove();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | Category>("all");
  const [period, setPeriod] = useState<Period>("all");
  const [sort, setSort] = useState<Sort>("release");
  const [sheet, setSheet] = useState<DiscoverSheet>(null);
  const [pendingItem, setPendingItem] = useState<ReleaseItem | null>(null);
  const [authOpen, setAuthOpen] = useState(false);

  useEffect(() => {
    if (!query.trim()) return;
    const timer = window.setTimeout(() => track("discover_search", { query: query.trim() }), 450);
    return () => window.clearTimeout(timer);
  }, [query]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ko-KR");
    const filtered = releases.filter((item) => {
      const queryMatch = !normalized || [item.title, ...item.tags, ...item.meta.map((meta) => meta.value)]
        .join(" ")
        .toLocaleLowerCase("ko-KR")
        .includes(normalized);
      return item.status !== "released" && queryMatch && (category === "all" || item.category === category) && matchesPeriod(item, period);
    });

    return filtered.sort((a, b) => {
      if (sort === "popular") return (b.waitingCount ?? 0) - (a.waitingCount ?? 0);
      if (sort === "new") return b.id.localeCompare(a.id);
      if (!a.releaseAt) return 1;
      if (!b.releaseAt) return -1;
      return a.releaseAt.localeCompare(b.releaseAt);
    });
  }, [category, period, query, sort]);

  const save = (item: ReleaseItem) => {
    if (!state.user) {
      setPendingItem(item);
      setAuthOpen(true);
      return;
    }
    const removing = state.favorites.includes(item.id);
    toggleFavorite(item.id);
    track(removing ? "remove_from_trove" : "add_to_trove", { item_id: item.id, surface: "discover" });
    if (!removing) {
      setPendingItem(item);
      setSheet("saved");
    }
  };

  const completePendingSave = () => {
    if (pendingItem && !state.favorites.includes(pendingItem.id)) {
      toggleFavorite(pendingItem.id);
      track("add_to_trove", { item_id: pendingItem.id, surface: "discover_auth" });
    }
    setAuthOpen(false);
    setSheet("saved");
  };

  const resetFilters = () => {
    setQuery("");
    setCategory("all");
    setPeriod("all");
    setSort("release");
  };

  return (
    <main className="app-page discover-page">
      <StatusBar />
      <AppHeader
        unreadCount={state.unreadNotifications}
        onNotifications={() => {
          markNotificationsRead();
          setSheet("notifications");
        }}
      />

      <section className="page-heading discover-heading">
        <span className="eyebrow">EXPLORE WHAT'S NEXT</span>
        <h1>새로운 기다림을<br />발견해보세요.</h1>
        <div className="discover-search-row">
          <label className="search-field">
            <Search size={21} />
            <input
              type="search"
              value={query}
              placeholder="영화, 게임, 아티스트 검색"
              aria-label="출시 콘텐츠 검색"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button type="button" aria-label="검색어 지우기" onClick={() => setQuery("")}>
                <X size={18} />
              </button>
            ) : null}
          </label>
          <button
            className={`filter-trigger ${period !== "all" || sort !== "release" ? "is-active" : ""}`}
            type="button"
            aria-label="기간과 정렬 필터"
            onClick={() => setSheet("filters")}
          >
            <SlidersHorizontal size={21} />
          </button>
        </div>
      </section>

      <div className="category-strip discover-categories" role="tablist" aria-label="카테고리">
        {categories.map((item) => (
          <button
            key={item.id}
            className={`category-chip ${category === item.id ? "is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            onClick={() => {
              setCategory(item.id);
              track("category_selected", { category: item.id, surface: "discover" });
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section className="discover-results">
        <div className="section-heading-row">
          <div>
            <strong>{query ? `'${query}' 검색 결과` : "다가오는 출시"}</strong>
            <span>{visible.length}개</span>
          </div>
          <small>{periodLabels[period]} · {sortLabels[sort]}</small>
        </div>
        {visible.length > 0 ? (
          <div className="release-list">
            {visible.map((item) => (
              <ReleaseListItem
                key={item.id}
                item={item}
                saved={state.favorites.includes(item.id)}
                onOpen={() => navigate(`/release/${item.slug}`)}
                onSave={() => save(item)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state discover-empty">
            <Search size={30} />
            <strong>조건에 맞는 기다림이 없어요</strong>
            <p>검색어나 필터를 바꿔 다시 둘러보세요.</p>
            <button className="secondary-button" type="button" onClick={resetFilters}>필터 초기화</button>
          </div>
        )}
      </section>

      <BottomNav active="discover" />

      <BottomSheet
        open={sheet === "notifications"}
        title="새로운 소식"
        description="날짜 변경과 임박 알림을 놓치지 마세요."
        onClose={() => setSheet(null)}
      >
        <NotificationList />
      </BottomSheet>

      <BottomSheet
        open={sheet === "filters"}
        title="어떻게 둘러볼까요?"
        description="출시 시기와 정렬 기준을 선택하세요."
        onClose={() => setSheet(null)}
      >
        <div className="filter-sheet-group">
          <strong>출시 시기</strong>
          <div className="option-chip-grid">
            {(Object.keys(periodLabels) as Period[]).map((id) => (
              <button className={period === id ? "is-selected" : ""} type="button" key={id} onClick={() => setPeriod(id)}>
                {periodLabels[id]}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-sheet-group">
          <strong>정렬</strong>
          <div className="option-chip-grid option-chip-grid--three">
            {(Object.keys(sortLabels) as Sort[]).map((id) => (
              <button className={sort === id ? "is-selected" : ""} type="button" key={id} onClick={() => setSort(id)}>
                {sortLabels[id]}
              </button>
            ))}
          </div>
        </div>
        <button className="primary-button sheet-button" type="button" onClick={() => setSheet(null)}>적용하기</button>
      </BottomSheet>

      <BottomSheet
        open={sheet === "saved"}
        title="Trove에 담았어요"
        description={`${pendingItem?.title ?? "선택한 기다림"}을 내 시간표에서 다시 만날 수 있어요.`}
        onClose={() => setSheet(null)}
      >
        <button
          className="primary-button sheet-button"
          type="button"
          onClick={() => pendingItem && navigate(`/release/${pendingItem.slug}`, { state: { openAlerts: true } })}
        >
          알림도 설정하기
        </button>
        <button className="text-button sheet-text-button" type="button" onClick={() => setSheet(null)}>계속 둘러보기</button>
      </BottomSheet>

      <AuthSheet
        open={authOpen}
        intentLabel="Trove에 담으려면 로그인해주세요"
        onClose={() => setAuthOpen(false)}
        onAuthenticated={completePendingSave}
      />
    </main>
  );
}

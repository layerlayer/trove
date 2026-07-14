import { ArrowRight, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { AuthSheet } from "../components/AuthSheet";
import { BottomNav } from "../components/BottomNav";
import { BottomSheet } from "../components/BottomSheet";
import { NotificationList } from "../components/NotificationList";
import { ReleaseCard } from "../components/ReleaseCard";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { categories, releases } from "../data/mock";
import { daysUntil } from "../lib/date";
import { track } from "../lib/analytics";
import type { Category, ReleaseItem } from "../types";

type HomeSheet = "notifications" | "saved" | null;

const compareReleaseDate = (a: ReleaseItem, b: ReleaseItem) => {
  if (!a.releaseAt) return 1;
  if (!b.releaseAt) return -1;
  return a.releaseAt.localeCompare(b.releaseAt);
};

export function HomePage() {
  const navigate = useNavigate();
  const { state, toggleFavorite, markNotificationsRead } = useTrove();
  const [activeCategory, setActiveCategory] = useState<"all" | Category>("all");
  const [sheet, setSheet] = useState<HomeSheet>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [pendingItem, setPendingItem] = useState<ReleaseItem | null>(null);

  useEffect(() => track("home_view"), []);

  const visibleReleases = useMemo(() => {
    const filtered = releases.filter(
      (release) =>
        release.status !== "released" &&
        (activeCategory === "all" || release.category === activeCategory),
    );
    return [...filtered].sort((a, b) => {
      const aMatch = a.interestIds.some((id) => state.interests.includes(id)) ? 1 : 0;
      const bMatch = b.interestIds.some((id) => state.interests.includes(id)) ? 1 : 0;
      return bMatch - aMatch || compareReleaseDate(a, b);
    });
  }, [activeCategory, state.interests]);

  const nextSaved = useMemo(
    () =>
      releases
        .filter((item) => state.favorites.includes(item.id) && (daysUntil(item.releaseAt) ?? -1) >= 0)
        .sort(compareReleaseDate)[0],
    [state.favorites],
  );
  const hero = activeCategory === "all" && nextSaved ? nextSaved : visibleReleases[0];
  const thisWeek = visibleReleases.filter((item) => {
    const days = daysUntil(item.releaseAt);
    return days !== null && days >= 0 && days <= 7 && item.id !== hero?.id;
  });
  const thisWeekIds = new Set(thisWeek.map((item) => item.id));
  const recommendations = visibleReleases
    .filter((item) => item.id !== hero?.id && !thisWeekIds.has(item.id))
    .slice(0, 7);

  const openNotifications = () => {
    setSheet("notifications");
    markNotificationsRead();
  };

  const save = (item: ReleaseItem) => {
    if (!state.user) {
      setPendingItem(item);
      setAuthOpen(true);
      return;
    }
    const removing = state.favorites.includes(item.id);
    toggleFavorite(item.id);
    track(removing ? "remove_from_trove" : "add_to_trove", { item_id: item.id, surface: "home" });
    if (!removing) {
      setPendingItem(item);
      setSheet("saved");
    }
  };

  const completePendingSave = () => {
    if (pendingItem && !state.favorites.includes(pendingItem.id)) {
      toggleFavorite(pendingItem.id);
      track("add_to_trove", { item_id: pendingItem.id, surface: "home_auth" });
    }
    setAuthOpen(false);
    setSheet("saved");
  };

  const card = (item: ReleaseItem, variant: "hero" | "compact") => (
    <ReleaseCard
      key={item.id}
      item={item}
      variant={variant}
      favorite={state.favorites.includes(item.id)}
      onOpen={() => navigate(`/release/${item.slug}`)}
      onFavorite={() => save(item)}
    />
  );

  return (
    <main className="app-page home-page">
      <StatusBar />
      <AppHeader brand unreadCount={state.unreadNotifications} onNotifications={openNotifications} />

      <div className="category-strip" role="tablist" aria-label="출시 카테고리">
        {categories.map((category) => (
          <button
            key={category.id}
            className={`category-chip ${activeCategory === category.id ? "is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeCategory === category.id}
            onClick={() => {
              setActiveCategory(category.id);
              track("category_selected", { category: category.id, surface: "home" });
            }}
          >
            {category.label}
          </button>
        ))}
      </div>

      <section className="home-content">
        <div className="home-hero-context">
          <div>
            <span className="eyebrow">{nextSaved && hero?.id === nextSaved.id ? "YOUR NEXT RELEASE" : "PICKED FOR YOU"}</span>
            <h1>{nextSaved && hero?.id === nextSaved.id ? "내 다음 기다림" : "오늘의 기다림"}</h1>
          </div>
          <Sparkles size={21} />
        </div>

        {hero ? card(hero, "hero") : (
          <div className="empty-state home-empty"><strong>이 카테고리의 출시작을 준비 중이에요</strong><p>전체 탭에서 다른 기다림을 둘러보세요.</p></div>
        )}

        {thisWeek.length > 0 ? (
          <section className="recommendation-section">
            <div className="home-section-heading"><h2>이번 주 출시</h2><button type="button" onClick={() => navigate("/discover")}>전체보기 <ArrowRight size={16} /></button></div>
            <div className="recommendation-row">{thisWeek.map((item) => card(item, "compact"))}</div>
          </section>
        ) : null}

        {recommendations.length > 0 ? (
          <section className="recommendation-section">
            <div className="home-section-heading"><h2>이런 기다림도 좋아하실 것 같아요.</h2></div>
            <div className="recommendation-row">{recommendations.map((item) => card(item, "compact"))}</div>
          </section>
        ) : null}
      </section>

      <BottomNav active="home" />

      <BottomSheet open={sheet === "notifications"} title="새로운 소식" description="기다리는 일정의 중요한 변화만 모았어요." onClose={() => setSheet(null)}>
        <NotificationList />
      </BottomSheet>

      <BottomSheet
        open={sheet === "saved"}
        title="Trove에 담았어요"
        description={`${pendingItem?.title ?? "선택한 기다림"}을 내 시간표에서 다시 만날 수 있어요.`}
        onClose={() => setSheet(null)}
      >
        <button className="primary-button sheet-button" type="button" onClick={() => pendingItem && navigate(`/release/${pendingItem.slug}`, { state: { openAlerts: true } })}>알림도 설정하기</button>
        <button className="text-button sheet-text-button" type="button" onClick={() => setSheet(null)}>계속 둘러보기</button>
      </BottomSheet>

      <AuthSheet open={authOpen} intentLabel="Trove에 담으려면 로그인해주세요" onClose={() => setAuthOpen(false)} onAuthenticated={completePendingSave} />
    </main>
  );
}

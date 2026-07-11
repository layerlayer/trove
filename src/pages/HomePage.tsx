import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { BottomNav } from "../components/BottomNav";
import { BottomSheet } from "../components/BottomSheet";
import { NotificationList } from "../components/NotificationList";
import { ReleaseCard } from "../components/ReleaseCard";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { categories, releases } from "../data/mock";
import type { Category } from "../types";

type HomeSheet = "notifications" | "coming-soon" | null;

export function HomePage() {
  const navigate = useNavigate();
  const { state, toggleFavorite, markNotificationsRead } = useTrove();
  const [activeCategory, setActiveCategory] = useState<"all" | Category>("all");
  const [sheet, setSheet] = useState<HomeSheet>(null);
  const [comingSoonLabel, setComingSoonLabel] = useState("");

  const visibleReleases = useMemo(() => {
    const filtered =
      activeCategory === "all"
        ? releases
        : releases.filter((release) => release.category === activeCategory);
    return [...filtered].sort((a, b) => {
      const aMatch = a.interestIds.some((id) => state.interests.includes(id)) ? 1 : 0;
      const bMatch = b.interestIds.some((id) => state.interests.includes(id)) ? 1 : 0;
      return bMatch - aMatch || a.releaseAt.localeCompare(b.releaseAt);
    });
  }, [activeCategory, state.interests]);

  const hero = visibleReleases[0];
  const recommendations = visibleReleases.slice(1, 7);

  const openNotifications = () => {
    setSheet("notifications");
    markNotificationsRead();
  };

  const showComingSoon = (label: string) => {
    setComingSoonLabel(label);
    setSheet("coming-soon");
  };

  return (
    <main className="app-page home-page">
      <StatusBar />
      <AppHeader
        brand
        unreadCount={state.unreadNotifications}
        onNotifications={openNotifications}
      />

      <div className="category-strip" role="tablist" aria-label="출시 카테고리">
        {categories.map((category) => (
          <button
            key={category.id}
            className={`category-chip ${activeCategory === category.id ? "is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeCategory === category.id}
            onClick={() => setActiveCategory(category.id)}
          >
            {category.label}
          </button>
        ))}
      </div>

      <section className="home-content">
        {hero ? (
          <ReleaseCard
            item={hero}
            variant="hero"
            favorite={state.favorites.includes(hero.id)}
            onOpen={() => navigate(`/release/${hero.slug}`)}
            onFavorite={() => toggleFavorite(hero.id)}
          />
        ) : (
          <div className="empty-state home-empty">
            <strong>이 카테고리의 출시작을 준비 중이에요</strong>
            <p>전체 탭에서 다른 기다림을 둘러보세요.</p>
          </div>
        )}

        {recommendations.length > 0 ? (
          <section className="recommendation-section">
            <h2>이런 기다림도 좋아하실 것 같아요.</h2>
            <div className="recommendation-row">
              {recommendations.map((item) => (
                <ReleaseCard
                  key={item.id}
                  item={item}
                  variant="compact"
                  favorite={state.favorites.includes(item.id)}
                  onOpen={() => navigate(`/release/${item.slug}`)}
                  onFavorite={() => toggleFavorite(item.id)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </section>

      <BottomNav active="home" onComingSoon={showComingSoon} />

      <BottomSheet
        open={sheet === "notifications"}
        title="새로운 소식"
        description="기다리는 일정의 중요한 변화만 모았어요."
        onClose={() => setSheet(null)}
      >
        <NotificationList />
      </BottomSheet>

      <BottomSheet
        open={sheet === "coming-soon"}
        title={`${comingSoonLabel} 준비 중`}
        description="다음 MVP에서 더 깊은 탐색과 프로필 기능을 만날 수 있어요."
        onClose={() => setSheet(null)}
      >
        <button className="primary-button sheet-button" type="button" onClick={() => setSheet(null)}>
          확인
        </button>
      </BottomSheet>
    </main>
  );
}

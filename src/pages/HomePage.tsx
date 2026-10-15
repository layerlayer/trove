import { ArrowRight, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { AuthSheet } from "../components/AuthSheet";
import { BottomNav } from "../components/BottomNav";
import { BottomSheet } from "../components/BottomSheet";
import { NotificationList } from "../components/NotificationList";
import { ReleaseCard } from "../components/ReleaseCard";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { categories } from "../data/categories";
import { useReleases } from "../data/ReleaseDataContext";
import { dDayLabel } from "../lib/date";
import { buildFeed, nextSavedRelease, type FeedBlock } from "../lib/feed";
import { track } from "../lib/analytics";
import type { Category, ReleaseItem } from "../types";

type HomeSheet = "notifications" | "saved" | null;

/** 한 번에 더 그리는 블록 수(카드·추천 줄 합쳐서) */
const PAGE_SIZE = 6;

export function HomePage() {
  const navigate = useNavigate();
  const { state, toggleFavorite, toggleInterest, markNotificationsRead } = useTrove();
  const { releases } = useReleases();
  const [activeCategory, setActiveCategory] = useState<"all" | Category>("all");
  const [sheet, setSheet] = useState<HomeSheet>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [pendingItem, setPendingItem] = useState<ReleaseItem | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => track("home_view"), []);

  const feed = useMemo(
    () => buildFeed({ releases, interests: state.interests, category: activeCategory }),
    [activeCategory, releases, state.interests],
  );
  const nextSaved = useMemo(() => nextSavedRelease(releases, state.favorites), [releases, state.favorites]);

  // 필터나 관심사가 바뀌면 처음부터 다시 내려본다
  const feedKey = `${activeCategory}|${state.interests.join(",")}|${releases.length}`;
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [feedKey]);

  const total = feed.blocks.length;
  const hasMore = visibleCount < total;
  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (!("IntersectionObserver" in window)) {
      setVisibleCount(total);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, total));
          track("feed_more", { surface: "home" });
        }
      },
      { rootMargin: "480px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, total, visibleCount]);

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

  const card = (item: ReleaseItem, variant: "feed" | "compact") => (
    <ReleaseCard
      key={item.id}
      item={item}
      variant={variant}
      favorite={state.favorites.includes(item.id)}
      onOpen={() => navigate(`/release/${item.slug}`)}
      onFavorite={() => save(item)}
    />
  );

  const renderBlock = (block: FeedBlock) => {
    if (block.type === "item") return card(block.item, "feed");
    if (block.type === "row") {
      return (
        <section className="feed-row" key={block.key} aria-label={block.title}>
          <div className="feed-row__heading">
            <span className="eyebrow">{block.eyebrow}</span>
            <h2>{block.title}</h2>
          </div>
          <div className="recommendation-row">{block.items.map((item) => card(item, "compact"))}</div>
        </section>
      );
    }
    return (
      <div className="feed-notice" key={block.key} role="note">
        <strong>{block.title}</strong>
        <p>{block.body}</p>
        {block.action === "preferences" ? (
          <button className="text-button" type="button" onClick={() => navigate("/preferences", { state: { returnTo: "/home" } })}>
            관심사 고르기 <ChevronRight size={14} />
          </button>
        ) : null}
        {block.action === "follow-category" && activeCategory !== "all" ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              toggleInterest(`category:${activeCategory}`);
              track("category_followed", { category: activeCategory, surface: "home_feed" });
            }}
          >
            관심사에 더하기 <ChevronRight size={14} />
          </button>
        ) : null}
      </div>
    );
  };

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

      <section className="feed" aria-label={feed.personalized ? "내 취향 피드" : "모든 기다림 피드"}>
        {nextSaved ? (
          <button className="next-up" type="button" onClick={() => navigate(`/release/${nextSaved.slug}`)}>
            <span className="next-up__label">내 다음 기다림</span>
            <strong>{nextSaved.title}</strong>
            <b>{dDayLabel(nextSaved.releaseAt)}</b>
            <ArrowRight size={16} />
          </button>
        ) : null}

        {feed.blocks.slice(0, visibleCount).map(renderBlock)}

        {hasMore ? (
          <div className="feed-sentinel" ref={sentinelRef}>
            <button className="text-button" type="button" onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, total))}>
              더 보기
            </button>
          </div>
        ) : feed.itemCount > 0 ? (
          <p className="feed-end">
            오늘의 기다림은 여기까지예요.
            <button type="button" onClick={() => navigate("/discover")}>더 찾아보기</button>
          </p>
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

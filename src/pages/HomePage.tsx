import { ArrowRight, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { AuthSheet } from "../components/AuthSheet";
import { BottomNav } from "../components/BottomNav";
import { BottomSheet } from "../components/BottomSheet";
import { ReleaseCard } from "../components/ReleaseCard";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { categories, isCategory } from "../data/categories";
import { entityInterestId } from "../data/published";
import { useReleases } from "../data/ReleaseDataContext";
import { dDayLabel } from "../lib/date";
import { buildFeed, nextSavedRelease, type FeedBlock } from "../lib/feed";
import { track } from "../lib/analytics";
import { useUnreadNotifications } from "../lib/useUnreadNotifications";
import type { Category, ReleaseItem } from "../types";

type HomeSheet = "saved" | null;

/** 한 번에 더 그리는 블록 수(카드·추천 줄 합쳐서) */
const PAGE_SIZE = 6;

/** 상세로 갔다가 뒤로 올 때 피드 자리를 되살리기 위한 기록 */
const FEED_MEMO_KEY = "trove-home-feed";
interface FeedMemo {
  /** 기록을 남긴 히스토리 항목(react-router location.key). 같은 항목으로 돌아올 때만 되살린다 */
  key: string;
  category: "all" | Category;
  visibleCount: number;
  scrollY: number;
}

function readFeedMemo(key: string): FeedMemo | null {
  try {
    const raw = window.sessionStorage.getItem(FEED_MEMO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FeedMemo>;
    if (parsed.key !== key || typeof parsed.visibleCount !== "number" || typeof parsed.scrollY !== "number") return null;
    return {
      key,
      category: parsed.category === "all" || isCategory(parsed.category) ? parsed.category : "all",
      visibleCount: Math.max(PAGE_SIZE, parsed.visibleCount),
      scrollY: Math.max(0, parsed.scrollY),
    };
  } catch {
    return null;
  }
}

function writeFeedMemo(memo: FeedMemo) {
  try {
    window.sessionStorage.setItem(FEED_MEMO_KEY, JSON.stringify(memo));
  } catch {
    // 저장이 막혀 있어도 피드는 그대로 동작한다
  }
}

export function HomePage() {
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const location = useLocation();
  const { state, toggleFavorite, toggleInterest } = useTrove();
  const unreadNotifications = useUnreadNotifications();
  const { releases } = useReleases();
  // 뒤로 가기로 돌아왔을 때만 탭·펼친 양·스크롤 자리를 되살린다
  const [restored] = useState(() => (navigationType === "POP" ? readFeedMemo(location.key) : null));
  const [activeCategory, setActiveCategory] = useState<"all" | Category>(restored?.category ?? "all");
  const [sheet, setSheet] = useState<HomeSheet>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [pendingItem, setPendingItem] = useState<ReleaseItem | null>(null);
  const [visibleCount, setVisibleCount] = useState(restored?.visibleCount ?? PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => track("home_view"), []);
  useEffect(() => {
    if (!restored) return;
    const frame = window.requestAnimationFrame(() => window.scrollTo({ top: restored.scrollY, behavior: "instant" }));
    return () => window.cancelAnimationFrame(frame);
  }, [restored]);

  const feed = useMemo(
    () => buildFeed({ releases, interests: state.interests, category: activeCategory }),
    [activeCategory, releases, state.interests],
  );
  const nextSaved = useMemo(() => nextSavedRelease(releases, state.favorites), [releases, state.favorites]);

  // 필터나 관심사가 바뀌면 처음부터 다시 내려본다(처음 그릴 때는 되살린 값을 지키지 않도록 건너뛴다)
  const feedKey = `${activeCategory}|${state.interests.join(",")}|${releases.length}`;
  const previousFeedKey = useRef(feedKey);
  useEffect(() => {
    if (previousFeedKey.current === feedKey) return;
    previousFeedKey.current = feedKey;
    setVisibleCount(PAGE_SIZE);
  }, [feedKey]);

  const total = feed.blocks.length;
  const hasMore = visibleCount < total;
  const loadMore = (trigger: "scroll" | "button" | "autofill") => {
    setVisibleCount((count) => Math.min(count + PAGE_SIZE, total));
    track("feed_more", { surface: "home", trigger });
  };
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
          // 화면이 커서 저절로 채워지는 경우와 실제로 내려 본 경우를 구분해 기록한다
          loadMore(window.scrollY > 0 ? "scroll" : "autofill");
        }
      },
      { rootMargin: "480px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, total, visibleCount]);

  const openRelease = (item: ReleaseItem) => {
    writeFeedMemo({ key: location.key, category: activeCategory, visibleCount, scrollY: window.scrollY });
    navigate(`/release/${item.slug}`);
  };

  const openEntity = (item: ReleaseItem) => {
    if (!item.entityName) return;
    writeFeedMemo({ key: location.key, category: activeCategory, visibleCount, scrollY: window.scrollY });
    navigate(`/entity/${entityInterestId(item.entityName).slice("entity:".length)}`);
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
      onOpen={() => openRelease(item)}
      onFavorite={() => save(item)}
      onEntity={item.entityName ? () => openEntity(item) : undefined}
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
      <AppHeader brand unreadCount={unreadNotifications} onNotifications={() => navigate("/notifications")} />

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
          <button className="next-up" type="button" onClick={() => openRelease(nextSaved)}>
            <span className="next-up__label">내 다음 기다림</span>
            <strong>{nextSaved.title}</strong>
            <b>{dDayLabel(nextSaved.releaseAt)}</b>
            <ArrowRight size={16} />
          </button>
        ) : null}

        {feed.blocks.slice(0, visibleCount).map(renderBlock)}

        {hasMore ? (
          <div className="feed-sentinel" ref={sentinelRef}>
            <button className="text-button" type="button" onClick={() => loadMore("button")}>
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

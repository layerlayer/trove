import "./EntityPage.css";
import { ArrowLeft, Check, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AuthSheet } from "../components/AuthSheet";
import { BottomSheet } from "../components/BottomSheet";
import { InterestImage } from "../components/Media";
import { ReleaseListItem } from "../components/ReleaseListItem";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "../data/categories";
import { entityInterestId } from "../data/published";
import { useReleases } from "../data/ReleaseDataContext";
import { track } from "../lib/analytics";
import { compareReleaseDate, isUpcoming } from "../lib/feed";
import type { Category, ReleaseItem } from "../types";

/** 지난 기다림은 처음에 이만큼만 보여 주고 "더 보기"로 펼친다 */
const PAST_PREVIEW = 5;

/** 이 아티스트의 일정이 가장 많이 속한 카테고리. 글자 타일 색을 정하는 데 쓴다 */
function dominantCategory(items: ReleaseItem[]): Category | undefined {
  const counts = new Map<Category, number>();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return CATEGORY_ORDER.filter((category) => counts.has(category)).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0];
}

export function EntityPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { state, toggleFavorite, toggleInterest } = useTrove();
  const { releases } = useReleases();
  const [showAllPast, setShowAllPast] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [pendingItem, setPendingItem] = useState<ReleaseItem | null>(null);
  const [shared, setShared] = useState(false);

  const interestId = `entity:${slug ?? ""}`;
  const items = useMemo(
    () => (slug ? releases.filter((item) => item.entityName && entityInterestId(item.entityName) === interestId) : []),
    [interestId, releases, slug],
  );
  const upcoming = useMemo(() => items.filter(isUpcoming).sort(compareReleaseDate), [items]);
  const past = useMemo(() => items.filter((item) => !isUpcoming(item)).sort((a, b) => compareReleaseDate(b, a)), [items]);

  useEffect(() => {
    if (slug) track("entity_view", { entity: slug });
  }, [slug]);

  // 슬러그가 바뀌면 펼친 상태를 접는다
  useEffect(() => setShowAllPast(false), [slug]);

  const entityName = items[0]?.entityName;
  if (!slug || !entityName) {
    return (
      <main className="app-page entity-page entity-page--missing">
        <StatusBar />
        <header className="simple-header">
          <button className="icon-button" type="button" aria-label="뒤로 가기" onClick={() => navigate(-1)}><ArrowLeft size={28} strokeWidth={1.8} /></button>
        </header>
        <div className="empty-state">
          <strong>아직 모르는 아티스트예요</strong>
          <p>발행된 일정이 있는 아티스트만 페이지가 생겨요.</p>
          <button className="primary-button" type="button" onClick={() => navigate("/discover")}>둘러보기</button>
        </div>
      </main>
    );
  }

  const following = state.interests.includes(interestId);
  const categoryLine = CATEGORY_ORDER.filter((category) => items.some((item) => item.category === category)).map((category) => CATEGORY_LABELS[category]).join(" · ");
  const tileInterest = { id: interestId, label: entityName, image: "", keywords: [] };
  const visiblePast = showAllPast ? past : past.slice(0, PAST_PREVIEW);

  const follow = () => {
    toggleInterest(interestId);
    track("entity_followed", { entity: slug, followed: !following });
  };

  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: entityName, url: window.location.href });
      else await navigator.clipboard.writeText(window.location.href);
    } catch {
      return;
    }
    setShared(true);
  };

  const save = (item: ReleaseItem) => {
    if (!state.user) {
      setPendingItem(item);
      setAuthOpen(true);
      return;
    }
    const removing = state.favorites.includes(item.id);
    toggleFavorite(item.id);
    track(removing ? "remove_from_trove" : "add_to_trove", { item_id: item.id, surface: "entity" });
  };

  const completePendingSave = () => {
    if (pendingItem && !state.favorites.includes(pendingItem.id)) {
      toggleFavorite(pendingItem.id);
      track("add_to_trove", { item_id: pendingItem.id, surface: "entity_auth" });
    }
    setPendingItem(null);
    setAuthOpen(false);
  };

  const listItem = (item: ReleaseItem, withAlerts: boolean) => (
    <ReleaseListItem
      key={item.id}
      item={item}
      saved={state.favorites.includes(item.id)}
      hasAlerts={Boolean(state.alerts[item.id]?.length)}
      onOpen={() => navigate(`/release/${item.slug}`)}
      onSave={() => save(item)}
      onAlerts={withAlerts ? () => navigate(`/release/${item.slug}`, { state: { openAlerts: true } }) : undefined}
    />
  );

  return (
    <main className="app-page entity-page">
      <StatusBar />
      <header className="simple-header entity-header">
        <button className="icon-button" type="button" aria-label="뒤로 가기" onClick={() => navigate(-1)}><ArrowLeft size={28} strokeWidth={1.8} /></button>
        <button className="icon-button" type="button" aria-label="공유하기" onClick={share}><Share2 size={26} strokeWidth={1.8} /></button>
      </header>

      <section className="entity-hero">
        <span className="entity-hero__tile" data-category={dominantCategory(items)}><InterestImage interest={tileInterest} /></span>
        <span className="eyebrow">ARTIST</span>
        <h1>{entityName}</h1>
        {categoryLine ? <p className="entity-hero__categories">{categoryLine}</p> : null}
        <p className="entity-hero__stats">다가오는 {upcoming.length} · 지난 {past.length}</p>
      </section>

      <section className="entity-follow" aria-label="팔로우">
        <button className={following ? "secondary-button" : "primary-button"} type="button" aria-pressed={following} onClick={follow}>
          {following ? <><Check size={18} strokeWidth={3} /> 팔로잉</> : "팔로우"}
        </button>
        <p className="entity-follow__hint">{following ? "홈 피드에 이 아티스트의 일정이 섞여 나와요" : "팔로우하면 홈 피드에서 바로 만나요"}</p>
      </section>

      <section className="entity-section" aria-labelledby="entity-upcoming-heading">
        <h2 id="entity-upcoming-heading">다가오는 기다림 <small>{upcoming.length}</small></h2>
        {upcoming.length > 0 ? (
          <div className="release-list">{upcoming.map((item) => listItem(item, true))}</div>
        ) : (
          <p className="entity-section__empty">아직 예정된 일정이 없어요. 팔로우해 두면 새 일정이 생길 때 피드에서 보여요.</p>
        )}
      </section>

      {past.length > 0 ? (
        <section className="entity-section" aria-labelledby="entity-past-heading">
          <h2 id="entity-past-heading">지난 기다림 <small>{past.length}</small></h2>
          <div className="release-list">{visiblePast.map((item) => listItem(item, false))}</div>
          {!showAllPast && past.length > PAST_PREVIEW ? (
            <div className="entity-section__more">
              <button className="text-button" type="button" onClick={() => setShowAllPast(true)}>더 보기 ({past.length - PAST_PREVIEW}개 더)</button>
            </div>
          ) : null}
        </section>
      ) : null}

      <BottomSheet open={shared} title="공유할 준비가 됐어요" description="링크가 복사되었거나 기기의 공유 창으로 전달됐어요." onClose={() => setShared(false)}>
        <button className="primary-button sheet-button" type="button" onClick={() => setShared(false)}>확인</button>
      </BottomSheet>

      <AuthSheet open={authOpen} intentLabel="Trove에 담으려면 로그인해주세요" onClose={() => setAuthOpen(false)} onAuthenticated={completePendingSave} />
    </main>
  );
}

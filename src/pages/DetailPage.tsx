import {
  ArrowLeft,
  BellRing,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Gem,
  Share2,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AuthSheet } from "../components/AuthSheet";
import { BottomSheet } from "../components/BottomSheet";
import { ReleaseListItem } from "../components/ReleaseListItem";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { releases } from "../data/mock";
import { dDayLabel, formatDate } from "../lib/date";
import { track } from "../lib/analytics";
import type { AlertPreset } from "../types";

type DetailSheet = "alerts" | "shared" | "saved" | null;
type PendingAction = "save" | "alerts" | null;

const exactDateOptions: Array<{ id: AlertPreset; title: string; description: string }> = [
  { id: "D-7", title: "일주일 전", description: "기대감을 천천히 끌어올릴 수 있어요." },
  { id: "D-1", title: "하루 전", description: "놓치지 않도록 마지막으로 준비해요." },
  { id: "D-Day", title: "출시 당일", description: "기다림이 끝나는 순간 알려드려요." },
];

const tbaOptions: Array<{ id: AlertPreset; title: string; description: string }> = [
  { id: "DATE_CONFIRMED", title: "출시일 확정", description: "정확한 날짜가 공개되는 순간 알려드려요." },
  { id: "DATE_CHANGED", title: "출시 일정 변경", description: "예정 시기나 상태가 바뀌면 알려드려요." },
];

export function DetailPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleFavorite, setAlertPresets } = useTrove();
  const item = releases.find((release) => release.slug === slug);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [sheet, setSheet] = useState<DetailSheet>(null);
  const [draftPresets, setDraftPresets] = useState<AlertPreset[]>([]);
  const [authOpen, setAuthOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const related = useMemo(
    () => item ? releases.filter((release) => release.id !== item.id && (release.category === item.category || release.interestIds.some((id) => item.interestIds.includes(id)))).slice(0, 3) : [],
    [item],
  );

  useEffect(() => {
    if (!item) return;
    track("item_view", { item_id: item.id });
  }, [item]);

  useEffect(() => {
    const shouldOpen = Boolean((location.state as { openAlerts?: boolean } | null)?.openAlerts);
    if (shouldOpen && item && state.user) {
      if (!state.favorites.includes(item.id)) toggleFavorite(item.id);
      setDraftPresets(state.alerts[item.id] ?? (item.releaseAt ? state.settings.defaultAlerts : ["DATE_CONFIRMED", "DATE_CHANGED"]));
      setSheet("alerts");
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [item, location.pathname, location.state, navigate, state.alerts, state.favorites, state.settings.defaultAlerts, state.user, toggleFavorite]);

  if (!item) {
    return (
      <main className="app-page not-found-page">
        <div className="empty-state"><strong>출시 정보를 찾지 못했어요</strong><p>목록으로 돌아가 다른 기다림을 확인해보세요.</p><button className="primary-button" type="button" onClick={() => navigate("/home")}>홈으로 돌아가기</button></div>
      </main>
    );
  }

  const favorite = state.favorites.includes(item.id);
  const savedPresets = state.alerts[item.id] ?? [];
  const hasAlerts = savedPresets.length > 0;
  const alertOptions = item.releaseAt ? exactDateOptions : tbaOptions;

  const changeSlide = (direction: number) => setGalleryIndex((current) => (current + direction + item.gallery.length) % item.gallery.length);

  const openAlertSheet = () => {
    if (!state.user) {
      setPendingAction("alerts");
      setAuthOpen(true);
      return;
    }
    if (!favorite) {
      toggleFavorite(item.id);
      track("add_to_trove", { item_id: item.id, surface: "detail_alert" });
    }
    setDraftPresets(savedPresets.length > 0 ? savedPresets : item.releaseAt ? state.settings.defaultAlerts : ["DATE_CONFIRMED", "DATE_CHANGED"]);
    setSheet("alerts");
  };

  const handleTrove = () => {
    if (!state.user) {
      setPendingAction("save");
      setAuthOpen(true);
      return;
    }
    toggleFavorite(item.id);
    track(favorite ? "remove_from_trove" : "add_to_trove", { item_id: item.id, surface: "detail" });
    if (!favorite) setSheet("saved");
  };

  const completePendingAction = () => {
    if (!favorite) {
      toggleFavorite(item.id);
      track("add_to_trove", { item_id: item.id, surface: "detail_auth" });
    }
    setAuthOpen(false);
    if (pendingAction === "alerts") {
      setDraftPresets(item.releaseAt ? state.settings.defaultAlerts : ["DATE_CONFIRMED", "DATE_CHANGED"]);
      setSheet("alerts");
    } else {
      setSheet("saved");
    }
    setPendingAction(null);
  };

  const toggleDraftPreset = (preset: AlertPreset) => setDraftPresets((current) => current.includes(preset) ? current.filter((id) => id !== preset) : [...current, preset]);

  const share = async () => {
    const payload = { title: `${item.title} — Trove`, text: `${item.title} ${item.releaseAt ? `${formatDate(item.releaseAt)} 출시 예정` : item.releaseWindow ?? "출시 예정"}`, url: window.location.href };
    try {
      if (navigator.share) await navigator.share(payload);
      else await navigator.clipboard.writeText(window.location.href);
    } catch {
      return;
    }
    setSheet("shared");
  };

  const dateText = item.releaseAt ? formatDate(item.releaseAt) : item.releaseWindow ?? "출시일 미정";

  return (
    <main className="app-page detail-page">
      <StatusBar />
      <header className="simple-header detail-header">
        <button className="icon-button" type="button" aria-label="뒤로 가기" onClick={() => navigate(-1)}><ArrowLeft size={28} strokeWidth={1.8} /></button>
        <button className="icon-button" type="button" aria-label="공유하기" onClick={share}><Share2 size={26} strokeWidth={1.8} /></button>
      </header>

      <section className="detail-gallery" aria-label={`${item.title} 이미지 ${galleryIndex + 1} / ${item.gallery.length}`}>
        <img src={item.gallery[galleryIndex]} alt={`${item.title} 이미지 ${galleryIndex + 1}`} style={{ objectPosition: item.galleryPositions?.[galleryIndex] ?? "50% 50%" }} />
        <button className="gallery-arrow gallery-arrow--left" type="button" aria-label="이전 이미지" onClick={() => changeSlide(-1)}><ChevronLeft size={24} /></button>
        <button className="gallery-arrow gallery-arrow--right" type="button" aria-label="다음 이미지" onClick={() => changeSlide(1)}><ChevronRight size={24} /></button>
        <span className="gallery-count">{galleryIndex + 1} / {item.gallery.length}</span>
      </section>

      <section className="detail-content">
        <span className="eyebrow">{item.status === "confirmed" ? "DATE CONFIRMED" : item.status === "released" ? "RELEASED" : "COMING SOON"}</span>
        <div className="detail-title-row"><h1>{item.title}</h1><strong>{dDayLabel(item.releaseAt)}</strong></div>
        <p className="detail-date-line">{item.categoryLabel} · {dateText}</p>
        <div className="tag-list" aria-label="분류">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>

        <div className="detail-waiting-count"><Users size={18} /><strong>{(item.waitingCount ?? 0).toLocaleString("ko-KR")}명</strong><span>이 함께 기다리고 있어요</span></div>

        <div className="detail-divider" />
        <section className="detail-description"><h2>소개</h2><p>{item.description ?? `${item.title}의 공식 출시 일정과 변동 사항을 Trove에서 계속 확인해보세요.`}</p></section>
        <div className="detail-divider" />
        <dl className="detail-meta">
          <div><dt>{item.dateLabel}</dt><dd>{dateText}</dd></div>
          {item.meta.map((meta) => <div key={meta.label}><dt>{meta.label}</dt><dd>{meta.value}</dd></div>)}
        </dl>

        <div className="source-card">
          <div><small>정보 출처</small><strong>{item.sourceName}</strong><span>마지막 확인 {item.lastVerifiedAt ? formatDate(item.lastVerifiedAt) : "최근 24시간 이내"}</span></div>
          {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer" onClick={() => track("release_source_clicked", { item_id: item.id })}><ExternalLink size={19} /><span className="sr-only">공식 출처 열기</span></a> : <Check size={20} />}
        </div>

        {related.length > 0 ? (
          <section className="related-section">
            <h2>비슷한 기다림</h2>
            <div className="release-list">{related.map((relatedItem) => <ReleaseListItem key={relatedItem.id} item={relatedItem} saved={state.favorites.includes(relatedItem.id)} onOpen={() => navigate(`/release/${relatedItem.slug}`)} onSave={() => {
              if (!state.user) { navigate(`/release/${relatedItem.slug}`); return; }
              toggleFavorite(relatedItem.id);
            }} />)}</div>
          </section>
        ) : null}
      </section>

      <footer className="sticky-action detail-actions">
        <button className={`detail-favorite detail-trove-button ${favorite ? "is-active" : ""}`} type="button" aria-pressed={favorite} onClick={handleTrove}>
          {favorite ? <Check size={22} strokeWidth={3} /> : <Gem size={22} />}<span>{favorite ? "담김" : "담기"}</span>
        </button>
        <button className={`primary-button alert-button ${hasAlerts ? "has-alerts" : ""}`} type="button" onClick={openAlertSheet}>
          {hasAlerts ? <><Check size={19} strokeWidth={3} /> 알림 설정됨</> : "알림 받기"}
        </button>
      </footer>

      <BottomSheet open={sheet === "alerts"} title="언제 알려드릴까요?" description={`${item.title}의 중요한 순간을 골라보세요.`} onClose={() => setSheet(null)}>
        <div className="alert-options">
          {alertOptions.map((option) => {
            const selected = draftPresets.includes(option.id);
            return <button className={selected ? "is-selected" : ""} type="button" aria-pressed={selected} key={option.id} onClick={() => toggleDraftPreset(option.id)}><span className="alert-options__icon">{selected ? <Check size={18} strokeWidth={3} /> : <BellRing size={18} />}</span><span><strong>{option.title}</strong><small>{option.description}</small></span></button>;
          })}
        </div>
        <button className="primary-button sheet-button" type="button" onClick={() => {
          setAlertPresets(item.id, draftPresets);
          if (draftPresets.length > 0) track("reminder_enabled", { item_id: item.id, count: draftPresets.length, surface: "detail" });
          setSheet(null);
        }}>{draftPresets.length > 0 ? `${draftPresets.length}개 알림 저장` : "알림 해제"}</button>
      </BottomSheet>

      <BottomSheet open={sheet === "saved"} title="Trove에 담았어요" description="저장과 알림은 따로 관리할 수 있어요." onClose={() => setSheet(null)}>
        <button className="primary-button sheet-button" type="button" onClick={openAlertSheet}>알림도 설정하기</button>
        <button className="text-button sheet-text-button" type="button" onClick={() => navigate("/trove")}>내 Trove 보기</button>
      </BottomSheet>

      <BottomSheet open={sheet === "shared"} title="공유할 준비가 됐어요" description="링크가 복사되었거나 기기의 공유 창으로 전달됐어요." onClose={() => setSheet(null)}><button className="primary-button sheet-button" type="button" onClick={() => setSheet(null)}>확인</button></BottomSheet>

      <AuthSheet open={authOpen} intentLabel={pendingAction === "alerts" ? "알림을 설정하려면 로그인해주세요" : "Trove에 담으려면 로그인해주세요"} onClose={() => setAuthOpen(false)} onAuthenticated={completePendingAction} />
    </main>
  );
}

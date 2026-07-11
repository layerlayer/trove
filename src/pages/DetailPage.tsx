import {
  ArrowLeft,
  BellRing,
  Check,
  ChevronLeft,
  ChevronRight,
  Heart,
  Share2,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BottomSheet } from "../components/BottomSheet";
import { StatusBar } from "../components/StatusBar";
import { useTrove } from "../context/TroveContext";
import { releases } from "../data/mock";
import { dDayLabel, formatDate } from "../lib/date";
import type { AlertPreset } from "../types";

type DetailSheet = "alerts" | "shared" | null;
const alertOptions: Array<{ id: AlertPreset; title: string; description: string }> = [
  { id: "D-7", title: "일주일 전", description: "기대감을 천천히 끌어올릴 수 있어요." },
  { id: "D-1", title: "하루 전", description: "놓치지 않도록 마지막으로 준비해요." },
  { id: "D-Day", title: "출시 당일", description: "기다림이 끝나는 순간 알려드려요." },
];

export function DetailPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { state, toggleFavorite, setAlertPresets } = useTrove();
  const item = releases.find((release) => release.slug === slug);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [sheet, setSheet] = useState<DetailSheet>(null);
  const [draftPresets, setDraftPresets] = useState<AlertPreset[]>(
    item ? state.alerts[item.id] ?? [] : [],
  );

  if (!item) {
    return (
      <main className="app-page not-found-page">
        <div className="empty-state">
          <strong>출시 정보를 찾지 못했어요</strong>
          <p>목록으로 돌아가 다른 기다림을 확인해보세요.</p>
          <button className="primary-button" type="button" onClick={() => navigate("/home")}>
            홈으로 돌아가기
          </button>
        </div>
      </main>
    );
  }

  const favorite = state.favorites.includes(item.id);
  const savedPresets = state.alerts[item.id] ?? [];
  const hasAlerts = savedPresets.length > 0;

  const changeSlide = (direction: number) => {
    setGalleryIndex((current) => (current + direction + item.gallery.length) % item.gallery.length);
  };

  const openAlertSheet = () => {
    setDraftPresets(savedPresets);
    setSheet("alerts");
  };

  const toggleDraftPreset = (preset: AlertPreset) => {
    setDraftPresets((current) =>
      current.includes(preset)
        ? current.filter((itemPreset) => itemPreset !== preset)
        : [...current, preset],
    );
  };

  const share = async () => {
    const payload = {
      title: `${item.title} — Trove`,
      text: `${item.title} ${formatDate(item.releaseAt)} 출시 예정`,
      url: window.location.href,
    };
    try {
      if (navigator.share) await navigator.share(payload);
      else await navigator.clipboard.writeText(window.location.href);
    } catch {
      // A cancelled native share sheet is not an error for this prototype.
    }
    setSheet("shared");
  };

  return (
    <main className="app-page detail-page">
      <StatusBar />
      <header className="simple-header detail-header">
        <button className="icon-button" type="button" aria-label="뒤로 가기" onClick={() => navigate(-1)}>
          <ArrowLeft size={28} strokeWidth={1.8} />
        </button>
        <button className="icon-button" type="button" aria-label="공유하기" onClick={share}>
          <Share2 size={26} strokeWidth={1.8} />
        </button>
      </header>

      <section className="detail-gallery" aria-label={`${item.title} 이미지 ${galleryIndex + 1} / ${item.gallery.length}`}>
        <img
          src={item.gallery[galleryIndex]}
          alt={`${item.title} 이미지 ${galleryIndex + 1}`}
          style={{ objectPosition: item.galleryPositions?.[galleryIndex] ?? "50% 50%" }}
        />
        <button
          className="gallery-arrow gallery-arrow--left"
          type="button"
          aria-label="이전 이미지"
          onClick={() => changeSlide(-1)}
        >
          <ChevronLeft size={24} />
        </button>
        <button
          className="gallery-arrow gallery-arrow--right"
          type="button"
          aria-label="다음 이미지"
          onClick={() => changeSlide(1)}
        >
          <ChevronRight size={24} />
        </button>
        <span className="gallery-count">
          {galleryIndex + 1} / {item.gallery.length}
        </span>
      </section>

      <section className="detail-content">
        <div className="detail-title-row">
          <h1>{item.title}</h1>
          <strong>{dDayLabel(item.releaseAt)}</strong>
        </div>
        <div className="tag-list" aria-label="분류">
          {item.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
        <div className="detail-divider" />
        <dl className="detail-meta">
          <div>
            <dt>{item.dateLabel}</dt>
            <dd>{formatDate(item.releaseAt)}</dd>
          </div>
          {item.meta.map((meta) => (
            <div key={meta.label}>
              <dt>{meta.label}</dt>
              <dd>{meta.value}</dd>
            </div>
          ))}
          <div>
            <dt>출처</dt>
            <dd>{item.sourceName}</dd>
          </div>
        </dl>
      </section>

      <footer className="sticky-action detail-actions">
        <button
          className={`detail-favorite ${favorite ? "is-active" : ""}`}
          type="button"
          aria-label={favorite ? "좋아요 해제" : "좋아요"}
          aria-pressed={favorite}
          onClick={() => toggleFavorite(item.id)}
        >
          <Heart size={28} fill={favorite ? "currentColor" : "none"} />
        </button>
        <button
          className={`primary-button alert-button ${hasAlerts ? "has-alerts" : ""}`}
          type="button"
          onClick={openAlertSheet}
        >
          {hasAlerts ? (
            <>
              <Check size={19} strokeWidth={3} /> 알림 설정됨
            </>
          ) : (
            "알림 받기"
          )}
        </button>
      </footer>

      <BottomSheet
        open={sheet === "alerts"}
        title="언제 알려드릴까요?"
        description={`${item.title}의 중요한 순간을 골라보세요.`}
        onClose={() => setSheet(null)}
      >
        <div className="alert-options">
          {alertOptions.map((option) => {
            const selected = draftPresets.includes(option.id);
            return (
              <button
                className={selected ? "is-selected" : ""}
                type="button"
                aria-pressed={selected}
                key={option.id}
                onClick={() => toggleDraftPreset(option.id)}
              >
                <span className="alert-options__icon">
                  {selected ? <Check size={18} strokeWidth={3} /> : <BellRing size={18} />}
                </span>
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            );
          })}
        </div>
        <button
          className="primary-button sheet-button"
          type="button"
          onClick={() => {
            setAlertPresets(item.id, draftPresets);
            setSheet(null);
          }}
        >
          {draftPresets.length > 0 ? `${draftPresets.length}개 알림 저장` : "알림 해제"}
        </button>
      </BottomSheet>

      <BottomSheet
        open={sheet === "shared"}
        title="공유할 준비가 됐어요"
        description="링크가 복사되었거나 기기의 공유 창으로 전달됐어요."
        onClose={() => setSheet(null)}
      >
        <button className="primary-button sheet-button" type="button" onClick={() => setSheet(null)}>
          확인
        </button>
      </BottomSheet>
    </main>
  );
}

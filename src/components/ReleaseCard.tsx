import { Heart } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { ReleaseItem } from "../types";
import { dDayLabel, formatDate } from "../lib/date";

interface ReleaseCardProps {
  item: ReleaseItem;
  variant: "hero" | "compact";
  favorite: boolean;
  onOpen: () => void;
  onFavorite: () => void;
}

export function ReleaseCard({
  item,
  variant,
  favorite,
  onOpen,
  onFavorite,
}: ReleaseCardProps) {
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <article
      className={`release-card release-card--${variant}`}
      role="link"
      tabIndex={0}
      aria-label={`${item.title} 상세 보기`}
      onClick={onOpen}
      onKeyDown={handleKey}
    >
      <img src={item.thumbnail} alt="" className="release-card__image" />
      <div className="release-card__shade" />
      <div className="release-card__top">
        <span className="d-day-pill">{dDayLabel(item.releaseAt)}</span>
        <button
          className={`favorite-button ${favorite ? "is-active" : ""}`}
          type="button"
          aria-label={favorite ? `${item.title} 좋아요 해제` : `${item.title} 좋아요`}
          aria-pressed={favorite}
          onClick={(event) => {
            event.stopPropagation();
            onFavorite();
          }}
        >
          <Heart size={variant === "hero" ? 27 : 25} fill={favorite ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="release-card__copy">
        <h3>{item.title}</h3>
        <p>
          <span>{item.dateLabel}</span>
          {formatDate(item.releaseAt)}
        </p>
      </div>
    </article>
  );
}

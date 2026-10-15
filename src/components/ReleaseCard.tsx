import { Heart } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { ReleaseItem } from "../types";
import { dDayLabel, formatDate } from "../lib/date";
import { ReleaseThumb } from "./Media";

interface ReleaseCardProps {
  item: ReleaseItem;
  variant: "hero" | "compact" | "feed";
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
  // 작은 카드에는 시각까지 넣으면 줄이 넘어가서 날짜만 보여 준다
  const showTime = variant !== "compact" && Boolean(item.releaseTime);
  const dateText = item.releaseAt
    ? `${formatDate(item.releaseAt)}${showTime ? ` ${item.releaseTime}` : ""}`
    : item.releaseWindow ?? "출시일 미정";
  // "기타" 같은 빈 분류는 숨긴다
  const kind = item.contentKind && item.contentKind !== "기타" ? item.contentKind : undefined;
  const eyebrow = [item.entityName ?? item.categoryLabel, kind]
    .filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index)
    .join(" · ");

  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    // 안쪽 하트 버튼에서 올라온 키 입력은 버튼이 처리하게 둔다
    if (event.target !== event.currentTarget) return;
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
      <ReleaseThumb item={item} className="release-card__image" showLabel={variant === "hero"} />
      <div className="release-card__shade" />
      <div className="release-card__top">
        <span className="d-day-pill">{dDayLabel(item.releaseAt)}</span>
        <button
          className={`favorite-button ${favorite ? "is-active" : ""}`}
          type="button"
          aria-label={favorite ? `${item.title} Trove에서 빼기` : `${item.title} Trove에 담기`}
          aria-pressed={favorite}
          onClick={(event) => {
            event.stopPropagation();
            onFavorite();
          }}
        >
          <Heart size={variant === "compact" ? 25 : 27} fill={favorite ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="release-card__copy">
        {variant === "feed" ? <span className="release-card__eyebrow">{eyebrow}</span> : null}
        <h3>{item.title}</h3>
        <p>
          <span>{item.dateLabel}</span>
          {dateText}
        </p>
      </div>
    </article>
  );
}

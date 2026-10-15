import { Heart } from "lucide-react";
import type { ReleaseItem } from "../types";
import { dDayLabel, formatDate } from "../lib/date";
import { ReleaseThumb } from "./Media";

interface ReleaseCardProps {
  item: ReleaseItem;
  variant: "hero" | "compact" | "feed";
  favorite: boolean;
  onOpen: () => void;
  onFavorite: () => void;
  /** 아이브로(아티스트·브랜드)를 누르면 그 페이지로 */
  onEntity?: () => void;
}

export function ReleaseCard({
  item,
  variant,
  favorite,
  onOpen,
  onFavorite,
  onEntity,
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

  // 카드 전체는 포인터용 편의 클릭 영역이고, 키보드·보조기기에는 제목 버튼이 실제 "열기" 조작이다.
  // 하트와 아이브로 버튼은 링크 안에 중첩되지 않고 형제로 놓인다.
  return (
    <article className={`release-card release-card--${variant}`} onClick={onOpen}>
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
        {variant === "feed" ? (
          onEntity && item.entityName ? (
            <button
              className="release-card__eyebrow release-card__eyebrow--link"
              type="button"
              aria-label={`${item.entityName} 페이지 보기`}
              onClick={(event) => {
                event.stopPropagation();
                onEntity();
              }}
            >
              {eyebrow}
            </button>
          ) : (
            <span className="release-card__eyebrow">{eyebrow}</span>
          )
        ) : null}
        <h3>
          <button
            className="release-card__open"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            {item.title}
          </button>
        </h3>
        <p>
          <span>{item.dateLabel}</span>
          {dateText}
        </p>
      </div>
    </article>
  );
}

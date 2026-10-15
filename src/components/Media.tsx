import type { Interest, ReleaseItem } from "../types";

/** 글자 타일에 쓸 첫 글자. 공백·기호는 건너뛴다 */
export function initialOf(text: string | null | undefined): string {
  const chars = Array.from((text ?? "").normalize("NFC").trim());
  const first = chars.find((char) => /[\p{L}\p{N}]/u.test(char));
  return (first ?? "?").toUpperCase();
}

interface ReleaseThumbProps {
  item: ReleaseItem;
  className?: string;
  /** 큰 타일(홈 히어로·상세 상단)에서는 종류 라벨도 같이 보여 준다 */
  showLabel?: boolean;
}

/**
 * 출시 항목의 이미지 자리. 이미지가 없으면(발행물 기본) 아티스트·브랜드 첫 글자와 종류로 채운다.
 * 카테고리별 색은 data-category 로 CSS 에서 정한다.
 */
export function ReleaseThumb({ item, className, showLabel = false }: ReleaseThumbProps) {
  if (item.thumbnail) return <img src={item.thumbnail} alt="" className={className} />;
  return (
    <span className={`media-placeholder ${className ?? ""}`.trim()} data-category={item.category} aria-hidden="true">
      <span className="media-placeholder__glyph">{initialOf(item.entityName ?? item.title)}</span>
      {showLabel ? <span className="media-placeholder__label">{item.contentKind ?? item.categoryLabel}</span> : null}
    </span>
  );
}

/** 관심사 타일의 이미지 자리. 이미지가 없으면 첫 글자 */
export function InterestImage({ interest }: { interest: Interest }) {
  if (interest.image) return <img src={interest.image} alt="" />;
  const category = interest.id.startsWith("category:") ? interest.id.slice("category:".length) : undefined;
  return (
    <span className="media-placeholder media-placeholder--round" data-category={category} aria-hidden="true">
      <span className="media-placeholder__glyph">{initialOf(interest.label)}</span>
    </span>
  );
}

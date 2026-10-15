import type { Category } from "../types";

/** 운영 콘솔의 PublishCategory 와 같은 다섯 가지. 라벨도 콘솔과 맞춘다 */
export const CATEGORY_LABELS: Record<Category, string> = {
  music: "음악",
  concert: "공연",
  game: "게임",
  movie: "영화",
  lifestyle: "라이프스타일",
};

export const CATEGORY_ORDER: Category[] = ["music", "concert", "game", "movie", "lifestyle"];

export const categories: Array<{ id: "all" | Category; label: string }> = [
  { id: "all", label: "전체" },
  ...CATEGORY_ORDER.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
];

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, value);
}

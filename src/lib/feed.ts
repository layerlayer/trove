import { CATEGORY_LABELS } from "../data/categories";
import { categoryInterestId } from "../data/published";
import type { Category, ReleaseItem } from "../types";
import { daysUntil } from "./date";

/**
 * 홈 피드 구성. SNS 처럼 관심사(카테고리·아티스트)로 고른 일정을 날짜순으로 끝없이 내려보고,
 * 그 사이사이에 "이런 건 어때요" 추천 줄(캐러셀)을 끼운다.
 */
export type FeedBlock =
  | { type: "item"; key: string; item: ReleaseItem }
  | { type: "row"; key: string; eyebrow: string; title: string; items: ReleaseItem[] }
  | { type: "notice"; key: string; title: string; body: string; action?: "preferences" | "follow-category" };

export interface FeedInput {
  releases: ReleaseItem[];
  /** 사용자가 고른 관심사 id (category:… / entity:…) */
  interests: string[];
  category: "all" | Category;
}

export interface FeedResult {
  blocks: FeedBlock[];
  /** 피드 카드 수(추천 줄·안내 제외) */
  itemCount: number;
  /** 관심사와 맞는 일정이 있어 맞춤 피드인지 */
  personalized: boolean;
}

/** 첫 추천 줄은 3번째 카드 뒤, 그다음부터는 5장마다 */
const FIRST_ROW_AFTER = 3;
const ROW_EVERY = 5;
const ROW_SIZE = 8;
/** "방금 나온 기다림" 으로 치는 기간(일) */
const RECENT_DAYS = 14;

/** 날짜 → (공연 티켓오픈) 시각 → 제목 순. 날짜 미정은 맨 뒤 */
export function compareReleaseDate(a: ReleaseItem, b: ReleaseItem): number {
  if (a.releaseAt !== b.releaseAt) {
    if (!a.releaseAt) return 1;
    if (!b.releaseAt) return -1;
    return a.releaseAt.localeCompare(b.releaseAt);
  }
  if ((a.releaseTime ?? "") !== (b.releaseTime ?? "")) {
    if (!a.releaseTime) return 1;
    if (!b.releaseTime) return -1;
    return a.releaseTime.localeCompare(b.releaseTime);
  }
  return a.title.localeCompare(b.title, "ko-KR");
}

/** 어댑터 규칙과 맞춘다: 지난 날짜만 "나온 것", 오늘은 아직 기다리는 것(D-Day) */
export function isUpcoming(item: ReleaseItem): boolean {
  return item.status !== "released" || daysUntil(item.releaseAt) === 0;
}

export function matchesInterests(item: ReleaseItem, interests: string[]): boolean {
  return item.interestIds.some((id) => interests.includes(id));
}

export function buildFeed({ releases, interests, category }: FeedInput): FeedResult {
  const upcoming = releases.filter(isUpcoming);
  const scoped = category === "all" ? upcoming : upcoming.filter((item) => item.category === category);
  const mine = scoped.filter((item) => matchesInterests(item, interests)).sort(compareReleaseDate);
  const personalized = mine.length > 0;
  const feedItems = personalized ? mine : [...scoped].sort(compareReleaseDate);
  const feedIds = new Set(feedItems.map((item) => item.id));

  // 추천 풀: 피드에 없는 다가오는 일정. 카테고리 탭에서는 그 카테고리 안에서만 고르고,
  // 탭이 비어 있을 때만 다른 카테고리에서 "대신 이런 건 어때요" 를 보여 준다.
  const tabEmpty = category !== "all" && scoped.length === 0;
  const pool = (tabEmpty ? upcoming : scoped).filter((item) => !feedIds.has(item.id)).sort(compareReleaseDate);
  // 최근 2주 안에 나온 것들. 관심사를 모두 팔로우해 추천할 게 없을 때도 이 줄은 남는다.
  const justReleased = (category === "all" ? releases : releases.filter((item) => item.category === category))
    .filter((item) => {
      if (isUpcoming(item)) return false;
      const days = daysUntil(item.releaseAt);
      return days !== null && days < 0 && days >= -RECENT_DAYS;
    })
    .sort((a, b) => compareReleaseDate(b, a));
  const used = new Set<string>();
  const take = (items: ReleaseItem[], limit: number): ReleaseItem[] => {
    const out: ReleaseItem[] = [];
    for (const item of items) {
      if (used.has(item.id)) continue;
      out.push(item);
      if (out.length === limit) break;
    }
    return out;
  };
  const rows: FeedBlock[] = [];
  const pushRow = (key: string, eyebrow: string, title: string, items: ReleaseItem[]) => {
    if (items.length < 2) return;
    items.forEach((item) => used.add(item.id));
    rows.push({ type: "row", key, eyebrow, title, items });
  };

  if (tabEmpty) {
    pushRow("row-instead", "YOU MAY LIKE", "대신 이런 기다림은 어때요", take(pool, ROW_SIZE));
  } else {
    pushRow(
      "row-week",
      "THIS WEEK",
      "이번 주 출시",
      take(
        pool.filter((item) => {
          const days = daysUntil(item.releaseAt);
          return days !== null && days >= 0 && days <= 7;
        }),
        ROW_SIZE,
      ),
    );
    pushRow("row-more", "YOU MAY LIKE", "이런 기다림도 좋아하실 것 같아요", take(pool, ROW_SIZE));
    const byEntity = new Map<string, ReleaseItem>();
    for (const item of pool) {
      if (!item.entityName || matchesInterests(item, interests) || byEntity.has(item.entityName)) continue;
      byEntity.set(item.entityName, item);
    }
    pushRow("row-artists", "NEW FOR YOU", "이런 아티스트도 기다려 보세요", take([...byEntity.values()], ROW_SIZE));
  }
  pushRow("row-released", "JUST OUT", "방금 나온 기다림", take(justReleased, ROW_SIZE));

  const blocks: FeedBlock[] = [];
  if (!personalized) {
    if (scoped.length === 0) {
      blocks.push({
        type: "notice",
        key: "notice-empty",
        title: category === "all" ? "아직 발행된 일정이 없어요" : "이 카테고리의 일정을 준비 중이에요",
        body: category === "all" ? "운영 콘솔에서 일정이 발행되면 여기에 보여요." : "전체 탭에서 다른 기다림을 둘러보세요.",
        ...(interests.length === 0 ? { action: "preferences" as const } : {}),
      });
    } else if (interests.length === 0) {
      blocks.push({
        type: "notice",
        key: "notice-pick",
        title: "관심사를 고르면 피드가 내 취향으로 바뀌어요",
        body:
          category === "all"
            ? "지금은 모든 기다림을 날짜순으로 보여드려요."
            : `지금은 ${CATEGORY_LABELS[category]} 기다림을 모두 날짜순으로 보여드려요.`,
        action: "preferences",
      });
    } else if (category !== "all" && !interests.includes(categoryInterestId(category))) {
      blocks.push({
        type: "notice",
        key: "notice-follow",
        title: `${withObjectParticle(CATEGORY_LABELS[category])} 관심사에 더해 보세요`,
        body: "더하면 전체 피드에도 이 일정들이 섞여 나와요.",
        action: "follow-category",
      });
    } else {
      blocks.push({
        type: "notice",
        key: "notice-fallback",
        title: "관심사에 맞는 일정이 아직 없어요",
        body: "대신 모든 기다림을 날짜순으로 보여드려요.",
      });
    }
  }

  let nextRow = 0;
  feedItems.forEach((item, index) => {
    blocks.push({ type: "item", key: item.id, item });
    const n = index + 1;
    const due = n === FIRST_ROW_AFTER || (n > FIRST_ROW_AFTER && (n - FIRST_ROW_AFTER) % ROW_EVERY === 0);
    if (due && nextRow < rows.length) blocks.push(rows[nextRow++]);
  });
  while (nextRow < rows.length) blocks.push(rows[nextRow++]);

  return { blocks, itemCount: feedItems.length, personalized };
}

/** 받침 유무에 따라 을/를 을 붙인다 */
export function withObjectParticle(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  const hangul = last >= 0xac00 && last <= 0xd7a3;
  return `${word}${hangul && (last - 0xac00) % 28 !== 0 ? "을" : "를"}`;
}

/** 담아 둔 일정 중 가장 가까운 것(오늘 포함) */
export function nextSavedRelease(releases: ReleaseItem[], favorites: string[]): ReleaseItem | undefined {
  return releases
    .filter((item) => favorites.includes(item.id) && (daysUntil(item.releaseAt) ?? -1) >= 0)
    .sort(compareReleaseDate)[0];
}

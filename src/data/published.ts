import { daysUntil, toLocalIso } from "../lib/date";
import type { Category, DatePrecision, Interest, ReleaseItem, ReleaseMeta, ReleaseStatus } from "../types";
import { CATEGORY_LABELS, CATEGORY_ORDER, isCategory } from "./categories";

/**
 * 운영 콘솔(trove-ops)이 발행하는 releases.json 한 건.
 * 콘솔 쪽 필드가 늘어나도 앱이 깨지지 않도록 전부 느슨하게 받고, 모르는 필드는 무시한다.
 */
export interface PublishedRelease {
  id: string;
  slug: string;
  title: string;
  category: string;
  categoryLabel?: string;
  releaseAt: string | null;
  releaseWindow?: string | null;
  datePrecision?: string;
  dateLabel?: string;
  status?: string;
  tags?: string[];
  interestIds?: string[];
  thumbnail?: string;
  gallery?: string[];
  meta?: Array<{ label?: string; value?: string }>;
  sourceName?: string;
  sourceUrl?: string;
  description?: string;
  lastVerifiedAt?: string;
  endsAt?: string | null;
  scheduleType?: string;
  entityName?: string | null;
  contentKind?: string | null;
  contentFormat?: string | null;
  opsFlags?: string[];
}

export interface PublishedMeta {
  publishedAt?: string;
  count?: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_RE = /T(\d{2}:\d{2})/;
const STATUSES: ReleaseStatus[] = ["confirmed", "tentative", "delayed", "released"];
const PRECISIONS: DatePrecision[] = ["exact_time", "exact_day", "month", "quarter", "year", "tba"];

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isStatus(value: unknown): value is ReleaseStatus {
  return typeof value === "string" && (STATUSES as string[]).includes(value);
}

function isPrecision(value: unknown): value is DatePrecision {
  return typeof value === "string" && (PRECISIONS as string[]).includes(value);
}

/** 관심사 id 용 슬러그. 한글·영문·숫자는 남기고 나머지는 하이픈 */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

/** 콘솔이 영어로 내보낸 날짜 라벨을 우리말로. 모르는 값은 그대로 둔다 */
const DATE_LABELS: Record<string, string> = {
  "release date": "발매일",
  release: "출시일",
  "ticket open": "티켓오픈",
  "ticket opening": "티켓오픈",
  "on sale": "판매 시작",
  premiere: "개봉일",
  "release day": "출시일",
  launch: "출시일",
  "launch date": "출시일",
  "street date": "발매일",
  "air date": "방영일",
  "opening date": "개봉일",
};

export function normalizeDateLabel(label: string | undefined): string {
  if (!label) return "출시일";
  return DATE_LABELS[label.toLowerCase()] ?? label;
}

export function categoryInterestId(category: Category): string {
  return `category:${category}`;
}

export function entityInterestId(entityName: string): string {
  return `entity:${slugify(entityName)}`;
}

/** 콘솔의 month/quarter/year 값("2026-11", "2026-Q4", "2026")을 읽는 말로 */
export function formatWindow(precision: DatePrecision, raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (precision === "month") {
    const match = /^(\d{4})-(\d{2})/.exec(raw);
    if (match) return `${match[1]}년 ${Number(match[2])}월`;
  }
  if (precision === "quarter") {
    const match = /^(\d{4})-Q([1-4])/.exec(raw);
    if (match) return `${match[1]}년 ${match[2]}분기`;
  }
  if (precision === "year") {
    const match = /^(\d{4})/.exec(raw);
    if (match) return `${match[1]}년`;
  }
  const date = DATE_RE.exec(raw);
  if (date) return `${date[1]}년 ${Number(date[2])}월`;
  return raw;
}

/** ISO 순간("2026-10-03T03:00:00.000Z")이나 날짜를 "YYYY-MM-DD"(보는 사람의 지역 날짜)로 */
function toLocalDate(value: unknown): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  if (!text.includes("T") && DATE_RE.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return toLocalIso(parsed);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * 발행물 한 건 → 앱 ReleaseItem. 모양이 맞지 않는 건(필수 필드 없음, 모르는 카테고리)은 null 로 돌려 건너뛴다.
 *  - 날짜: exact_time/exact_day 의 starts_at 에서 날짜 10자리만 쓴다(값은 이미 한국 시간대).
 *  - 시각: 공연(concert)이고 exact_time 일 때만 releaseTime 으로 남긴다. 다른 카테고리는 날짜까지만.
 *  - 기간형(month/quarter/year)은 releaseWindow 를 읽는 말로 바꾼다. tba 는 둘 다 비운다.
 *  - 관심사: 카테고리 하나 + 아티스트·브랜드(있을 때) 하나.
 *  - 상태: 콘솔이 발행 시점에 정한 status 를 그대로 믿지 않고, 날짜가 지났으면 보는 시점에 "released" 로 바꾼다
 *    (발행 파일은 다음 배포까지 그대로이므로).
 */
export function adaptRelease(raw: PublishedRelease | null | undefined): ReleaseItem | null {
  if (!raw || typeof raw !== "object") return null;
  const id = clean(raw.id);
  const slug = clean(raw.slug);
  const title = clean(raw.title);
  if (!id || !slug || !title) return null;
  if (!isCategory(raw.category)) return null;
  const category = raw.category;

  const startsAt = clean(raw.releaseAt);
  const precision: DatePrecision = isPrecision(raw.datePrecision)
    ? raw.datePrecision
    : startsAt && DATE_RE.test(startsAt)
      ? "exact_day"
      : "tba";
  const exact = precision === "exact_time" || precision === "exact_day";
  const dateMatch = exact && startsAt ? DATE_RE.exec(startsAt) : null;
  const releaseAt = dateMatch ? dateMatch[0] : null;
  const timeMatch = precision === "exact_time" && startsAt ? TIME_RE.exec(startsAt) : null;
  const releaseTime = category === "concert" && timeMatch ? timeMatch[1] : undefined;
  const releaseWindow = releaseAt ? undefined : formatWindow(precision, clean(raw.releaseWindow) ?? startsAt);

  const entityName = clean(raw.entityName) ?? null;
  const contentKind = clean(raw.contentKind) ?? clean(raw.tags?.[0]);
  const contentFormat = clean(raw.contentFormat) ?? null;

  const publishedStatus: ReleaseStatus = isStatus(raw.status) ? raw.status : "tentative";
  const status: ReleaseStatus =
    releaseAt && publishedStatus !== "released" && (daysUntil(releaseAt) ?? 0) < 0 ? "released" : publishedStatus;

  const meta: ReleaseMeta[] = [];
  for (const entry of raw.meta ?? []) {
    const label = clean(entry?.label);
    const value = clean(entry?.value);
    if (label && value && !meta.some((m) => m.label === label)) meta.push({ label, value });
  }
  if (contentFormat && !meta.some((m) => m.value === contentFormat)) {
    meta.unshift({ label: "형식", value: contentFormat });
  }

  return {
    id,
    slug,
    title,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    releaseAt,
    releaseTime,
    releaseWindow,
    datePrecision: precision,
    dateLabel: normalizeDateLabel(clean(raw.dateLabel)),
    status,
    tags: uniqueStrings([contentKind, contentFormat ?? undefined, ...(raw.tags ?? [])].map(clean)),
    interestIds: [categoryInterestId(category), ...(entityName ? [entityInterestId(entityName)] : [])],
    thumbnail: clean(raw.thumbnail) ?? "",
    gallery: (raw.gallery ?? []).map(clean).filter((url): url is string => Boolean(url)),
    meta,
    sourceName: clean(raw.sourceName) ?? "출처 미상",
    sourceUrl: clean(raw.sourceUrl),
    description: clean(raw.description),
    lastVerifiedAt: toLocalDate(raw.lastVerifiedAt),
    entityName,
    contentKind,
    contentFormat,
  };
}

export interface AdaptResult {
  releases: ReleaseItem[];
  /** 모양이 맞지 않아 건너뛴 건수 */
  skipped: number;
}

export function adaptReleases(raw: unknown): AdaptResult {
  if (!Array.isArray(raw)) throw new Error("발행물이 목록(JSON 배열)이 아니에요.");
  const releases: ReleaseItem[] = [];
  let skipped = 0;
  const slugs = new Set<string>();
  for (const entry of raw as PublishedRelease[]) {
    const item = adaptRelease(entry);
    if (!item || slugs.has(item.slug)) {
      skipped++;
      continue;
    }
    slugs.add(item.slug);
    releases.push(item);
  }
  return { releases, skipped };
}

/**
 * 발행물에서 관심사 목록을 만든다.
 * 카테고리 다섯 개가 먼저(발행물이 없어도 온보딩이 막히지 않게), 그 뒤에 아티스트·브랜드를 출시 건수 많은 순으로.
 */
export function deriveInterests(releases: ReleaseItem[]): Interest[] {
  const categoryInterests: Interest[] = CATEGORY_ORDER.map((category) => ({
    id: categoryInterestId(category),
    label: CATEGORY_LABELS[category],
    image: "",
    keywords: ["카테고리", category],
    count: releases.filter((item) => item.category === category).length,
  }));

  const entities = new Map<string, { label: string; count: number; keywords: Set<string> }>();
  for (const item of releases) {
    if (!item.entityName) continue;
    const id = entityInterestId(item.entityName);
    const entry = entities.get(id) ?? { label: item.entityName, count: 0, keywords: new Set<string>() };
    entry.count++;
    entry.keywords.add(item.categoryLabel);
    if (item.contentKind) entry.keywords.add(item.contentKind);
    entities.set(id, entry);
  }
  const entityInterests: Interest[] = [...entities.entries()]
    .map(([id, entry]) => ({ id, label: entry.label, image: "", keywords: [...entry.keywords], count: entry.count }))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label, "ko-KR"));

  return [...categoryInterests, ...entityInterests];
}

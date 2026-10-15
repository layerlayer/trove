export type Category = "music" | "concert" | "game" | "movie" | "lifestyle";

export type AlertPreset = "D-7" | "D-1" | "D-Day" | "DATE_CONFIRMED" | "DATE_CHANGED";

export type ReleaseStatus = "confirmed" | "tentative" | "delayed" | "released";

/** 운영 콘솔이 쓰는 날짜 정밀도와 같다. exact_time 은 앱에서 날짜(+공연 시각)로만 보여 준다 */
export type DatePrecision = "exact_time" | "exact_day" | "month" | "quarter" | "year" | "tba";

export interface Interest {
  id: string;
  label: string;
  /** 비어 있으면 글자 타일로 그린다 */
  image: string;
  keywords: string[];
  /** 이 관심사에 묶인 출시 건수(발행물에서 만든 관심사만) */
  count?: number;
}

export interface ReleaseMeta {
  label: string;
  value: string;
}

export interface ReleaseItem {
  id: string;
  slug: string;
  title: string;
  category: Category;
  categoryLabel: string;
  /** "YYYY-MM-DD" (한국 날짜). 날짜가 확정되지 않았으면 null */
  releaseAt: string | null;
  /** "HH:mm". 공연 티켓오픈처럼 시각이 의미 있을 때만 */
  releaseTime?: string;
  /** 사람이 읽는 예정 시기. 예: "2026년 11월", "2026년 4분기" */
  releaseWindow?: string;
  datePrecision?: DatePrecision;
  dateLabel: string;
  status: ReleaseStatus;
  tags: string[];
  interestIds: string[];
  /** 비어 있으면 글자 타일로 그린다(이미지 없는 카드 정책) */
  thumbnail: string;
  gallery: string[];
  galleryPositions?: string[];
  meta: ReleaseMeta[];
  sourceName: string;
  sourceUrl?: string;
  description?: string;
  /** "YYYY-MM-DD" */
  lastVerifiedAt?: string;
  waitingCount?: number;
  /** 아티스트·브랜드 */
  entityName?: string | null;
  /** 콘텐츠 종류. 예: 앨범, 콘서트 */
  contentKind?: string;
  /** 세부 형식. 예: 미니 앨범, EP */
  contentFormat?: string | null;
}

export interface TroveUser {
  id: string;
  name: string;
  email: string;
  provider: "email" | "google";
}

export interface UserSettings {
  defaultAlerts: AlertPreset[];
  weeklyDigest: boolean;
  notificationPermission: NotificationPermission | "unsupported";
}

export interface TroveState {
  onboardingComplete: boolean;
  interests: string[];
  favorites: string[];
  alerts: Record<string, AlertPreset[]>;
  /** 알림 센터를 마지막으로 본 시각(ISO). 그 뒤에 울린 알림만 배지로 센다 */
  notificationsSeenAt: string | null;
  user: TroveUser | null;
  settings: UserSettings;
}

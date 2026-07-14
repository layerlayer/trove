export type Category = "music" | "game" | "lifestyle" | "movie";

export type AlertPreset = "D-7" | "D-1" | "D-Day" | "DATE_CONFIRMED" | "DATE_CHANGED";

export type ReleaseStatus = "confirmed" | "tentative" | "delayed" | "released";

export type DatePrecision = "exact_day" | "month" | "year" | "tba";

export interface Interest {
  id: string;
  label: string;
  image: string;
  keywords: string[];
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
  releaseAt: string | null;
  releaseWindow?: string;
  datePrecision?: DatePrecision;
  dateLabel: string;
  status: ReleaseStatus;
  tags: string[];
  interestIds: string[];
  thumbnail: string;
  gallery: string[];
  galleryPositions?: string[];
  meta: ReleaseMeta[];
  sourceName: string;
  sourceUrl?: string;
  description?: string;
  lastVerifiedAt?: string;
  waitingCount?: number;
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
  unreadNotifications: number;
  user: TroveUser | null;
  settings: UserSettings;
}

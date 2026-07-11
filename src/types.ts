export type Category = "music" | "game" | "lifestyle" | "movie";

export type AlertPreset = "D-7" | "D-1" | "D-Day";

export type ReleaseStatus = "confirmed" | "tentative" | "delayed";

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
  releaseAt: string;
  dateLabel: string;
  status: ReleaseStatus;
  tags: string[];
  interestIds: string[];
  thumbnail: string;
  gallery: string[];
  galleryPositions?: string[];
  meta: ReleaseMeta[];
  sourceName: string;
}

export interface TroveState {
  onboardingComplete: boolean;
  interests: string[];
  favorites: string[];
  alerts: Record<string, AlertPreset[]>;
  unreadNotifications: number;
}

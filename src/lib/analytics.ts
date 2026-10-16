const ANALYTICS_KEY = "trove-analytics-v1";

export type AnalyticsEventName =
  | "home_view"
  | "feed_more"
  | "category_followed"
  | "entity_view"
  | "entity_followed"
  | "notifications_view"
  | "info_view"
  | "discover_search"
  | "category_selected"
  | "item_view"
  | "add_to_trove"
  | "remove_from_trove"
  | "reminder_enabled"
  | "signup_started"
  | "signup_completed"
  | "notification_permission_granted"
  | "release_source_clicked";

interface AnalyticsEvent {
  name: AnalyticsEventName;
  at: string;
  properties?: Record<string, string | number | boolean>;
}

export function track(
  name: AnalyticsEventName,
  properties?: AnalyticsEvent["properties"],
) {
  try {
    const current = JSON.parse(window.localStorage.getItem(ANALYTICS_KEY) ?? "[]") as AnalyticsEvent[];
    const next = [...current.slice(-199), { name, at: new Date().toISOString(), properties }];
    window.localStorage.setItem(ANALYTICS_KEY, JSON.stringify(next));
  } catch {
    // Analytics should never interrupt the product flow.
  }
}

/** MVP 데이터 초기화에서 사용 기록도 함께 지운다(개인정보 처리방침의 약속) */
export function clearAnalytics() {
  try {
    window.localStorage.removeItem(ANALYTICS_KEY);
  } catch {
    // 저장소가 막혀 있어도 초기화는 계속된다
  }
}

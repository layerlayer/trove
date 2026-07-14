const ANALYTICS_KEY = "trove-analytics-v1";

export type AnalyticsEventName =
  | "home_view"
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

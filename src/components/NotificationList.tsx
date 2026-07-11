import { BellRing, CalendarClock, Sparkles } from "lucide-react";

const notifications = [
  {
    icon: CalendarClock,
    title: "GD 정규 4집이 3일 남았어요",
    body: "발매 당일에도 한 번 더 알려드릴게요.",
    time: "방금",
  },
  {
    icon: BellRing,
    title: "악뮤 콘서트 일정이 확정됐어요",
    body: "기다리던 일정이 공식 출처에서 확인됐어요.",
    time: "2시간 전",
  },
  {
    icon: Sparkles,
    title: "새로운 기다림을 발견했어요",
    body: "취향이 비슷한 사람들이 에어조던을 저장하고 있어요.",
    time: "어제",
  },
];

export function NotificationList() {
  return (
    <div className="notification-list">
      {notifications.map(({ icon: Icon, title, body, time }) => (
        <article className="notification-item" key={title}>
          <span className="notification-item__icon">
            <Icon size={20} />
          </span>
          <div className="notification-item__content">
            <strong>{title}</strong>
            <p>{body}</p>
            <time>{time}</time>
          </div>
        </article>
      ))}
    </div>
  );
}

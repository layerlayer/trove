import { Bell, Check, Gem } from "lucide-react";
import type { ReleaseItem } from "../types";
import { dDayLabel, formatDate } from "../lib/date";

interface ReleaseListItemProps {
  item: ReleaseItem;
  saved: boolean;
  hasAlerts?: boolean;
  onOpen: () => void;
  onSave: () => void;
  onAlerts?: () => void;
}

export function ReleaseListItem({
  item,
  saved,
  hasAlerts = false,
  onOpen,
  onSave,
  onAlerts,
}: ReleaseListItemProps) {
  const dateText = item.releaseAt ? formatDate(item.releaseAt) : item.releaseWindow ?? "출시일 미정";

  return (
    <article className="release-list-item">
      <button className="release-list-item__main" type="button" onClick={onOpen}>
        <span className="release-list-item__image-wrap">
          <img src={item.thumbnail} alt="" />
          <b>{dDayLabel(item.releaseAt)}</b>
        </span>
        <span className="release-list-item__copy">
          <small>{item.categoryLabel}</small>
          <strong>{item.title}</strong>
          <span>{dateText}</span>
        </span>
      </button>
      <div className="release-list-item__actions">
        {onAlerts ? (
          <button
            className={hasAlerts ? "is-active" : ""}
            type="button"
            aria-label={hasAlerts ? `${item.title} 알림 수정` : `${item.title} 알림 설정`}
            onClick={onAlerts}
          >
            <Bell size={18} fill={hasAlerts ? "currentColor" : "none"} />
          </button>
        ) : null}
        <button
          className={saved ? "is-active" : ""}
          type="button"
          aria-label={saved ? `${item.title} Trove에서 빼기` : `${item.title} Trove에 담기`}
          aria-pressed={saved}
          onClick={onSave}
        >
          {saved ? <Check size={18} strokeWidth={3} /> : <Gem size={18} />}
        </button>
      </div>
    </article>
  );
}

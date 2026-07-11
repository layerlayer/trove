import { Bell, Menu } from "lucide-react";

interface AppHeaderProps {
  brand?: boolean;
  unreadCount: number;
  onNotifications: () => void;
  onMenu?: () => void;
}

export function AppHeader({
  brand = false,
  unreadCount,
  onNotifications,
  onMenu,
}: AppHeaderProps) {
  return (
    <header className={`app-header ${brand ? "app-header--brand" : "app-header--actions"}`}>
      {brand ? <span className="app-header__brand">Trove</span> : <span />}
      <div className="app-header__right">
        <button
          className="icon-button app-header__notification"
          type="button"
          aria-label="알림 보기"
          onClick={onNotifications}
        >
          <Bell size={27} strokeWidth={1.8} />
          {unreadCount > 0 ? (
            <span className="notification-badge">{unreadCount}</span>
          ) : null}
        </button>
        {onMenu ? (
          <button className="icon-button" type="button" aria-label="메뉴 열기" onClick={onMenu}>
            <Menu size={29} strokeWidth={1.8} />
          </button>
        ) : null}
      </div>
    </header>
  );
}

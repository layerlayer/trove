import { Gem, Home, Search, UserCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

type NavId = "home" | "discover" | "trove" | "profile";

interface BottomNavProps {
  active: NavId;
  onComingSoon: (label: string) => void;
}

const navItems = [
  { id: "home" as const, label: "Home", icon: Home },
  { id: "discover" as const, label: "Discover", icon: Search },
  { id: "trove" as const, label: "Trove", icon: Gem },
  { id: "profile" as const, label: "Profile", icon: UserCircle },
];

export function BottomNav({ active, onComingSoon }: BottomNavProps) {
  const navigate = useNavigate();

  const handleNavigation = (id: NavId, label: string) => {
    if (id === "home") navigate("/home");
    else if (id === "trove") navigate("/calendar");
    else onComingSoon(label);
  };

  return (
    <nav className="bottom-nav" aria-label="주요 메뉴">
      {navItems.map(({ id, label, icon: Icon }) => {
        const selected = active === id;
        return (
          <button
            key={id}
            className={`bottom-nav__item ${selected ? "is-active" : ""}`}
            type="button"
            aria-current={selected ? "page" : undefined}
            onClick={() => handleNavigation(id, label)}
          >
            <Icon size={25} strokeWidth={selected ? 2.6 : 1.8} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

import { BatteryFull, Signal, Wifi } from "lucide-react";

export function StatusBar() {
  return (
    <div className="status-bar" aria-hidden="true">
      <span className="status-bar__time">9:41</span>
      <span className="status-bar__icons">
        <Signal size={15} strokeWidth={2.4} />
        <Wifi size={15} strokeWidth={2.4} />
        <BatteryFull size={20} strokeWidth={2} />
      </span>
    </div>
  );
}

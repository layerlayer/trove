const DAY_MS = 86_400_000;

export function toLocalIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysFromToday(days: number): string {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  today.setDate(today.getDate() + days);
  return toLocalIso(today);
}

export function parseLocalDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function daysUntil(iso: string): number {
  const target = parseLocalDate(iso);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / DAY_MS);
}

export function dDayLabel(iso: string): string {
  const days = daysUntil(iso);
  if (days === 0) return "D-Day";
  if (days < 0) return `D+${Math.abs(days)}`;
  return `D-${days}`;
}

export function formatDate(iso: string, separator = "."): string {
  const date = parseLocalDate(iso);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join(separator);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

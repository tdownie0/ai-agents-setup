export function formatCurrency(value: number, fractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPct(value: number, withSign = false): string {
  const sign = withSign && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatWindow(window: string): string {
  return window.charAt(0).toUpperCase() + window.slice(1);
}

export function formatSignedCurrency(value: number, fractionDigits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatCurrency(Math.abs(value), fractionDigits)}`;
}

export function pnlClassName(value: number): string {
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-red-600";
  return "text-muted-foreground";
}

const DAY_MS = 86_400_000;

export function formatAgeInDays(openedDate: string, asOfDate: string): string {
  const opened = Date.parse(openedDate);
  const asOf = Date.parse(asOfDate);
  if (Number.isNaN(opened) || Number.isNaN(asOf)) return "—";
  const days = Math.round((asOf - opened) / DAY_MS);
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}

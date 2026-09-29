/**
 * CLI flag parsing for the market-data trailing fetch window.
 *
 * Kept free of I/O (no `process.env`, no database, no network) so the date
 * arithmetic is directly unit-testable in isolation from the entrypoint.
 */

/** The trailing-window units the CLI accepts, in flag-precedence order. */
const WINDOW_UNITS = ["days", "weeks", "months", "years"] as const;
type WindowUnit = (typeof WINDOW_UNITS)[number];

interface FetchWindow {
  from: Date;
  to: Date;
}

function parsePositiveValue(raw: string, unit: WindowUnit): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`invalid --${unit} value: "${raw}"`);
  }
  return parsed;
}

/** Read `--unit N` or `--unit=N` for one unit; null when the flag is absent. */
function readUnitAmount(argv: readonly string[], unit: WindowUnit): number | null {
  const inline = `--${unit}=`;
  for (const arg of argv) {
    if (arg.startsWith(inline)) {
      return parsePositiveValue(arg.slice(inline.length), unit);
    }
  }
  const flagIndex = argv.indexOf(`--${unit}`);
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    return parsePositiveValue(argv[flagIndex + 1], unit);
  }
  return null;
}

/**
 * Subtract `amount` of `unit` from `to`, returning a new Date.
 *
 * Calendar units clamp at the target boundary: JS `setMonth`/`setFullYear`
 * overflow *forward* when the day-of-month does not exist in the target
 * month (2026-03-31 − 1 month would land on 2026-03-03, a 4-day window), so
 * the day is pinned to 1 before shifting and then clamped to the target
 * month's true last day (2026-03-31 − 1 month → 2026-02-28). Leap days clamp
 * the same way (2024-02-29 − 1 year → 2023-02-28).
 */
export function subtractUnit(to: Date, unit: WindowUnit, amount: number): Date {
  const result = new Date(to.getTime());
  switch (unit) {
    case "days":
      result.setDate(result.getDate() - amount);
      return result;
    case "weeks":
      result.setDate(result.getDate() - amount * 7);
      return result;
    case "months":
      return shiftCalendar(result, amount, "months");
    case "years":
      return shiftCalendar(result, amount, "years");
  }
}

/** Shift by whole months/years, clamping the day to the target month end. */
function shiftCalendar(date: Date, amount: number, unit: "months" | "years"): Date {
  const day = date.getDate();
  date.setDate(1);
  if (unit === "months") {
    date.setMonth(date.getMonth() - amount);
  } else {
    date.setFullYear(date.getFullYear() - amount);
  }
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return date;
}

/**
 * Resolve the trailing fetch window from CLI args.
 *
 * The first flag present in `WINDOW_UNITS` precedence order wins, so
 * `--days 5` beats a stray `--years 1` regardless of argument order. With no
 * flag at all the script's `defaultYears` applies, keeping today's
 * `market-data:update` / `market-data:backfill` behavior unchanged.
 *
 * `to` is the current instant — the window is always trailing up to now.
 */
export function resolveWindow(
  argv: readonly string[],
  defaultYears: number,
  now: Date = new Date(),
): FetchWindow {
  for (const unit of WINDOW_UNITS) {
    const amount = readUnitAmount(argv, unit);
    if (amount !== null) {
      return { from: subtractUnit(now, unit, amount), to: now };
    }
  }
  return { from: subtractUnit(now, "years", defaultYears), to: now };
}

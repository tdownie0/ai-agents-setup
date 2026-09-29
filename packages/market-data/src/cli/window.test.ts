/**
 * Unit tests for CLI trailing-window resolution.
 *
 * Pure/unit only — NO database, NO network, NO `process.argv` (the clock is
 * injected via `resolveWindow`'s `now` parameter). Dates are built with local
 * time constructors because `setDate`/`setMonth` operate in local time; that
 * keeps the assertions timezone-independent.
 */

import { describe, it, expect } from "vitest";
import { resolveWindow, subtractUnit } from "./window.js";

const NOW = new Date(2026, 8, 29); // 2026-09-29 local midnight

describe("subtractUnit", () => {
  it("subtracts days and weeks via setDate", () => {
    expect(subtractUnit(NOW, "days", 5)).toEqual(new Date(2026, 8, 24));
    expect(subtractUnit(NOW, "weeks", 2)).toEqual(new Date(2026, 8, 15));
  });

  it("clamps months at the target month end instead of overflowing forward", () => {
    const mar31 = new Date(2026, 2, 31);
    expect(subtractUnit(mar31, "months", 1)).toEqual(new Date(2026, 1, 28));
  });

  it("keeps mid-month months exact", () => {
    expect(subtractUnit(NOW, "months", 1)).toEqual(new Date(2026, 7, 29));
  });

  it("clamps leap days when shifting years", () => {
    const feb29 = new Date(2024, 1, 29);
    expect(subtractUnit(feb29, "years", 1)).toEqual(new Date(2023, 1, 28));
  });

  it("does not mutate the input date", () => {
    const input = new Date(2026, 2, 31);
    subtractUnit(input, "months", 1);
    expect(input).toEqual(new Date(2026, 2, 31));
  });
});

describe("resolveWindow", () => {
  it("falls back to defaultYears when no window flag is present", () => {
    expect(resolveWindow([], 5, NOW).from).toEqual(new Date(2021, 8, 29));
    expect(resolveWindow([], 30, NOW).from).toEqual(new Date(1996, 8, 29));
  });

  it("ignores unrelated arguments and still uses defaultYears", () => {
    expect(resolveWindow(["--other", "1"], 5, NOW).from).toEqual(new Date(2021, 8, 29));
  });

  it("accepts the inline --unit=N form", () => {
    expect(resolveWindow(["--days=5"], 30, NOW).from).toEqual(new Date(2026, 8, 24));
    expect(resolveWindow(["--months=1"], 30, NOW).from).toEqual(new Date(2026, 7, 29));
  });

  it("accepts the space-separated --unit N form", () => {
    expect(resolveWindow(["--days", "5"], 30, NOW).from).toEqual(new Date(2026, 8, 24));
    expect(resolveWindow(["--weeks", "2"], 30, NOW).from).toEqual(new Date(2026, 8, 15));
  });

  it("supports --years explicitly, overriding the default", () => {
    expect(resolveWindow(["--years=1"], 30, NOW).from).toEqual(new Date(2025, 8, 29));
  });

  it("anchors the window end at the injected now", () => {
    expect(resolveWindow(["--days=1"], 5, NOW).to).toEqual(NOW);
  });

  it("applies fixed unit precedence regardless of argument order", () => {
    expect(resolveWindow(["--days", "5", "--years", "1"], 30, NOW).from).toEqual(
      new Date(2026, 8, 24),
    );
    expect(resolveWindow(["--years", "1", "--days", "5"], 30, NOW).from).toEqual(
      new Date(2026, 8, 24),
    );
  });

  it("rejects non-positive and non-numeric amounts", () => {
    expect(() => resolveWindow(["--days=0"], 5, NOW)).toThrow(/invalid --days value/);
    expect(() => resolveWindow(["--months", "-3"], 5, NOW)).toThrow(/invalid --months value/);
    expect(() => resolveWindow(["--years=abc"], 5, NOW)).toThrow(/invalid --years value/);
  });
});

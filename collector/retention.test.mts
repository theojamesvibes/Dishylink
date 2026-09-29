import { describe, expect, it } from "vitest";
import { minuteCutoffSec, retentionDaysFromEnv, retentionMs } from "./retention.mts";

const DAY_MS = 86_400_000;

describe("retentionDaysFromEnv", () => {
  it("is null when unset, blank or not a positive number", () => {
    expect(retentionDaysFromEnv("X", {})).toBeNull();
    expect(retentionDaysFromEnv("X", { X: "" })).toBeNull();
    expect(retentionDaysFromEnv("X", { X: "  " })).toBeNull();
    expect(retentionDaysFromEnv("X", { X: "0" })).toBeNull();
    expect(retentionDaysFromEnv("X", { X: "-3" })).toBeNull();
    expect(retentionDaysFromEnv("X", { X: "ninety" })).toBeNull();
  });

  it("reads a positive day count, fractional or padded", () => {
    expect(retentionDaysFromEnv("X", { X: "90" })).toBe(90);
    expect(retentionDaysFromEnv("X", { X: " 7 " })).toBe(7);
    expect(retentionDaysFromEnv("X", { X: "0.5" })).toBe(0.5);
  });
});

describe("retentionMs", () => {
  it("falls back to the default when the variable is unusable", () => {
    expect(retentionMs("X", 2, {})).toBe(2 * DAY_MS);
    expect(retentionMs("X", 2, { X: "junk" })).toBe(2 * DAY_MS);
  });

  it("uses the variable when set", () => {
    expect(retentionMs("X", 2, { X: "90" })).toBe(90 * DAY_MS);
  });
});

describe("minuteCutoffSec", () => {
  const yearStart = Math.floor(new Date(2026, 0, 1).getTime() / 1000);

  it("is the year start when no day count is set (upstream behaviour)", () => {
    expect(minuteCutoffSec(yearStart, new Date(2026, 8, 29, 12), null)).toBe(yearStart);
    expect(minuteCutoffSec(yearStart, new Date(2026, 0, 2, 12), null)).toBe(yearStart);
  });

  it("never moves later than the year start", () => {
    // Late September, 90 days back is late June: the year start is earlier and wins.
    expect(minuteCutoffSec(yearStart, new Date(2026, 8, 29, 12), 90)).toBe(yearStart);
  });

  it("reaches into the previous year when the year start is too recent", () => {
    // 15 January 2026, 90 days back is mid-October 2025; the cutoff is 1 October.
    const cutoff = minuteCutoffSec(yearStart, new Date(2026, 0, 15, 12), 90);
    expect(cutoff).toBe(Math.floor(new Date(2025, 9, 1).getTime() / 1000));
  });

  it("snaps to the start of the month, so folding stays whole-month", () => {
    // 400 days before 20 December 2026 is 15 November 2025; the cutoff is
    // 1 November 2025, earlier than the year start, so it wins.
    const cutoff = minuteCutoffSec(yearStart, new Date(2026, 11, 20, 12), 400);
    expect(cutoff).toBe(Math.floor(new Date(2025, 10, 1).getTime() / 1000));
  });
});

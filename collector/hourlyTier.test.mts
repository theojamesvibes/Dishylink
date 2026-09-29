import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HourlyTier, hourKeyOf } from "./hourlyTier.mts";

interface Minute {
  minute: number;
  samples: number;
  value: number;
}
interface Hour {
  hour: number;
  samples: number;
  value: number;
}

function fold(minutes: Minute[]): Map<number, Hour> {
  const hours = new Map<number, Hour>();
  for (const row of minutes) {
    const hour = hourKeyOf(row.minute);
    const acc = hours.get(hour) ?? { hour, samples: 0, value: 0 };
    acc.samples += row.samples;
    acc.value += row.value;
    hours.set(hour, acc);
  }
  return hours;
}

const H0 = 1_800_000_000 - (1_800_000_000 % 3_600);
const minute = (sec: number, value = 1): Minute => ({ minute: sec, samples: 60, value });
const fullHour = (hour: number) => Array.from({ length: 60 }, (_, i) => minute(hour + i * 60));

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hourly-"));
  path = join(dir, "energy-hourly.ndjson");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("HourlyTier", () => {
  it("backfills every completed hour and leaves the current one alone", () => {
    const tier = new HourlyTier<Minute, Hour>(path, fold);
    const minutes = [...fullHour(H0), ...fullHour(H0 + 3_600), minute(H0 + 7_200)];
    expect(tier.backfill(minutes, H0 + 7_260)).toBe(2);
    expect(tier.readRange(0, Infinity).map((row) => row.hour)).toEqual([H0, H0 + 3_600]);
    expect(tier.readRange(0, Infinity)[0].samples).toBe(3_600);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("rolls a touched hour up once the clock leaves it, and only that hour", () => {
    const tier = new HourlyTier<Minute, Hour>(path, fold);
    const cache: Minute[] = [];
    for (const row of fullHour(H0)) {
      cache.push(row);
      tier.noteMinute(row);
      expect(tier.rollup(cache, row.minute + 30)).toBe(0); // still inside the hour
    }
    const next = minute(H0 + 3_600);
    cache.push(next);
    tier.noteMinute(next);
    expect(tier.rollup(cache, H0 + 3_660)).toBe(1);
    expect(tier.newestHour).toBe(H0);
    // The hour in progress stays open however often rollup is asked.
    expect(tier.rollup(cache, H0 + 3_700)).toBe(0);
    expect(tier.rollup(cache, H0 + 7_199)).toBe(0);
    // Once the clock leaves it, that one minute is its row.
    expect(tier.rollup(cache, H0 + 7_200)).toBe(1);
    expect(tier.readRange(H0 + 3_600, H0 + 7_200)[0].samples).toBe(60);
  });

  it("a late minute for a folded hour replaces the row with the fuller fold", () => {
    const tier = new HourlyTier<Minute, Hour>(path, fold);
    const cache = fullHour(H0).slice(0, 50);
    tier.backfill(cache, H0 + 3_700);
    expect(tier.readRange(H0, H0 + 1)[0].samples).toBe(3_000);
    // The recorder restarted mid-hour and the ring handed back the missing ten.
    for (const row of fullHour(H0).slice(50)) {
      cache.push(row);
      tier.noteMinute(row);
    }
    expect(tier.rollup(cache, H0 + 3_800)).toBe(1);
    expect(tier.readRange(H0, H0 + 1)[0].samples).toBe(3_600);
    // Rewritten whole, still one row.
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("re-reads its rows on construction and does not rewrite hours it already has", () => {
    new HourlyTier<Minute, Hour>(path, fold).backfill(fullHour(H0), H0 + 3_700);
    const again = new HourlyTier<Minute, Hour>(path, fold);
    expect(again.oldestHour).toBe(H0);
    expect(again.backfill(fullHour(H0), H0 + 3_700)).toBe(0);
  });
});

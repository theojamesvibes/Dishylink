import { describe, expect, it } from "vitest";
import {
  buildHistorySeries,
  foldLatencyMinutesToHours,
  foldMinutesToHours,
  historyRangeSpec,
  type HistoryInputs,
} from "./historySeries";
import type { MinuteBucket } from "./energyBuckets";
import { LATENCY_BIN_COUNT, type LatencyMinuteBucket } from "./latencyBuckets";

const NOW = new Date(2026, 8, 29, 12, 0, 30); // local noon, 30 s in
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const empty = (): HistoryInputs => ({
  minutes: [],
  hours: [],
  months: [],
  latencyMinutes: [],
  latencyHours: [],
  latencyMonths: [],
});

/** A full minute drawing `watts` at `bps` down, half that up. */
function minute(minuteSec: number, watts = 60, bps = 100_000_000): MinuteBucket {
  return {
    minute: minuteSec,
    wattSeconds: watts * 60,
    samples: 60,
    downlinkBits: bps * 60,
    uplinkBits: (bps / 2) * 60,
  };
}

function latencyMinute(minuteSec: number, meanMs: number, drop = 0): LatencyMinuteBucket {
  const bins = new Array<number>(LATENCY_BIN_COUNT).fill(0);
  bins[Math.min(Math.floor(meanMs / 10), LATENCY_BIN_COUNT - 1)] = 60;
  const source = { count: 60, sumMs: meanMs * 60, sumSqMs: meanMs * meanMs * 60, minMs: meanMs, maxMs: meanMs, bins };
  return {
    minute: minuteSec,
    samples: 60,
    dish: source,
    router: { count: 0, sumMs: 0, sumSqMs: 0, minMs: null, maxMs: null, bins: bins.map(() => 0) },
    dropSum: drop * 60,
    dropCount: 60,
  };
}

describe("historyRangeSpec", () => {
  it("fixed ranges end now and bucket to a few hundred points", () => {
    const day = historyRangeSpec("24h", NOW, empty());
    expect(day.endSec).toBe(NOW_SEC);
    expect(day.startSec).toBe(NOW_SEC - 86_400);
    expect((day.endSec - day.startSec) / day.bucketSec).toBe(720);
    const quarter = historyRangeSpec("90d", NOW, empty());
    expect((quarter.endSec - quarter.startSec) / quarter.bucketSec).toBe(720);
  });

  it("lifetime starts at the oldest row of any tier and widens whole hours", () => {
    const inputs = empty();
    inputs.months = [{ month: NOW_SEC - 400 * 86_400, wattSeconds: 0, samples: 0, downlinkBits: 0, uplinkBits: 0 }];
    inputs.hours = [{ hour: NOW_SEC - 100 * 86_400, wattSeconds: 0, samples: 0, downlinkBits: 0, uplinkBits: 0 }];
    const spec = historyRangeSpec("lifetime", NOW, inputs);
    expect(spec.startSec).toBe(NOW_SEC - 400 * 86_400);
    expect(spec.bucketSec % 3_600).toBe(0);
    expect((spec.endSec - spec.startSec) / spec.bucketSec).toBeLessThanOrEqual(720);
  });

  it("lifetime with nothing recorded is a day-wide empty window", () => {
    expect(historyRangeSpec("lifetime", NOW, empty()).startSec).toBe(NOW_SEC - 86_400);
  });
});

describe("foldMinutesToHours", () => {
  it("sums a completed hour's minutes under the hour's start", () => {
    const hourSec = Math.floor(NOW_SEC / 3_600) * 3_600 - 3_600;
    const minutes = Array.from({ length: 60 }, (_, index) => minute(hourSec + index * 60));
    const hours = foldMinutesToHours(minutes);
    expect([...hours.keys()]).toEqual([hourSec]);
    const row = hours.get(hourSec)!;
    expect(row.samples).toBe(3_600);
    expect(row.wattSeconds).toBe(60 * 3_600);
    expect(row.downlinkBits).toBe(100_000_000 * 3_600);
  });

  it("latency hours sum histograms and keep the extremes", () => {
    const hourSec = 1_700_000_400 - (1_700_000_400 % 3_600);
    const hours = foldLatencyMinutesToHours([
      latencyMinute(hourSec, 30),
      latencyMinute(hourSec + 60, 50, 0.5),
    ]);
    const row = hours.get(hourSec)!;
    expect(row.dish.count).toBe(120);
    expect(row.dish.minMs).toBe(30);
    expect(row.dish.maxMs).toBe(50);
    expect(row.dish.bins[3]).toBe(60);
    expect(row.dish.bins[5]).toBe(60);
    expect(row.dropSum).toBe(30);
    expect(row.dropCount).toBe(120);
  });
});

describe("buildHistorySeries", () => {
  it("turns minutes into per-bucket rates, power and latency", () => {
    const inputs = empty();
    const bucketStart = NOW_SEC - 120; // the newest 24h bucket... 
    const start = NOW_SEC - 86_400;
    const key = start + Math.floor((bucketStart - start) / 120) * 120;
    inputs.minutes = [minute(key, 40, 50_000_000), minute(key + 60, 60, 150_000_000)];
    inputs.latencyMinutes = [latencyMinute(key, 30), latencyMinute(key + 60, 50, 0.1)];
    const series = buildHistorySeries("24h", NOW, inputs);
    expect(series.bucketSec).toBe(120);
    expect(series.points).toHaveLength(1);
    const point = series.points[0];
    expect(point.t).toBe(key);
    expect(point.seconds).toBe(120);
    expect(point.powerW).toBe(50);
    expect(point.downBps).toBe(100_000_000);
    expect(point.upBps).toBe(50_000_000);
    expect(point.latencyMs).toBe(40);
    expect(point.dropPct).toBe(5);
    expect(point.latencyP95Ms).not.toBeNull();
  });

  it("prefers minutes over hours for an hour both cover, and skips rows outside the window", () => {
    const inputs = empty();
    const hourSec = Math.floor((NOW_SEC - 7_200) / 3_600) * 3_600;
    inputs.minutes = [minute(hourSec, 100)];
    // An hour row for the same hour claiming a very different draw must be ignored…
    inputs.hours = [
      { hour: hourSec, wattSeconds: 999 * 3_600, samples: 3_600, downlinkBits: 0, uplinkBits: 0 },
      // …while an older hour nothing else covers is used.
      { hour: hourSec - 3_600, wattSeconds: 20 * 3_600, samples: 3_600, downlinkBits: 0, uplinkBits: 0 },
      // Outside the window entirely.
      { hour: NOW_SEC - 40 * 86_400, wattSeconds: 1, samples: 3_600, downlinkBits: 0, uplinkBits: 0 },
    ];
    const series = buildHistorySeries("1m", NOW, inputs);
    expect(series.points.map((point) => point.powerW)).toEqual([20, 100]);
  });

  it("lifetime emits archived months as month-wide points before the first hour", () => {
    const inputs = empty();
    const firstHour = NOW_SEC - 30 * 86_400 - ((NOW_SEC - 30 * 86_400) % 3_600);
    inputs.hours = [{ hour: firstHour, wattSeconds: 30 * 3_600, samples: 3_600, downlinkBits: 0, uplinkBits: 0 }];
    const marchStart = Math.floor(new Date(2026, 2, 1).getTime() / 1000);
    const aprilStart = Math.floor(new Date(2026, 3, 1).getTime() / 1000);
    inputs.months = [
      { month: marchStart, wattSeconds: 25 * 31 * 86_400, samples: 31 * 86_400, downlinkBits: 0, uplinkBits: 0 },
      // A month that overlaps the hour tier is not repeated as a point.
      { month: Math.floor(new Date(NOW.getFullYear(), NOW.getMonth(), 1).getTime() / 1000), wattSeconds: 1, samples: 60, downlinkBits: 0, uplinkBits: 0 },
    ];
    const series = buildHistorySeries("lifetime", NOW, inputs);
    expect(series.startSec).toBe(marchStart);
    const march = series.points[0];
    expect(march.t).toBe(marchStart);
    expect(march.span).toBe(aprilStart - marchStart);
    expect(march.powerW).toBe(25);
    expect(series.points).toHaveLength(2);
    expect(series.points[1].powerW).toBe(30);
  });

  it("a bucket with nothing recorded is absent, not zero", () => {
    const inputs = empty();
    inputs.minutes = [minute(NOW_SEC - 3_600)];
    const series = buildHistorySeries("1w", NOW, inputs);
    expect(series.points).toHaveLength(1);
    expect(series.points[0].seconds).toBe(60);
  });
});

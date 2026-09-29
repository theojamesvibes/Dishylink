import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnergyStore } from "./energyStore.mts";
import { LatencyStore } from "./latencyStore.mts";
import { appendJsonLines } from "./jsonLinesFile.mts";
import { LATENCY_BIN_COUNT } from "../core/latencyBuckets.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const nowSec = () => Math.floor(Date.now() / 1000);
/** The most recent hour that has fully completed, and the one before it. */
const completedHour = () => Math.floor(nowSec() / 3_600) * 3_600 - 3_600;

describe("EnergyStore hourly tier", () => {
  it("folds an hour on append once the clock leaves it", () => {
    vi.useFakeTimers();
    try {
      const hour = completedHour() - 3_600;
      vi.setSystemTime(new Date((hour + 30) * 1000));
      const store = new EnergyStore(join(dir, "energy.ndjson"));
      for (let index = 0; index < 60; index++) {
        vi.setSystemTime(new Date((hour + index * 60 + 30) * 1000));
        store.append({ minute: hour + index * 60, wattSeconds: 3_000, samples: 60, downlinkBits: 6_000, uplinkBits: 600 });
      }
      // Still inside the hour: nothing folded yet.
      expect(store.readHours(hour, hour + 3_600)).toEqual([]);
      vi.setSystemTime(new Date((hour + 3_600 + 30) * 1000));
      store.append({ minute: hour + 3_600, wattSeconds: 3_000, samples: 60, downlinkBits: 0, uplinkBits: 0 });
      expect(store.readHours(hour, hour + 3_600)).toEqual([
        { hour, wattSeconds: 180_000, samples: 3_600, downlinkBits: 360_000, uplinkBits: 36_000 },
      ]);
      expect(existsSync(join(dir, "energy-hourly.ndjson"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfills the hourly file from a minute log written before the tier existed", () => {
    const path = join(dir, "energy.ndjson");
    const hour = completedHour();
    const rows = Array.from({ length: 30 }, (_, index) => ({
      minute: hour + index * 60,
      wattSeconds: 1_200,
      samples: 60,
      downlinkBits: 0,
      uplinkBits: 0,
    }));
    appendJsonLines(path, rows);
    expect(existsSync(join(dir, "energy-hourly.ndjson"))).toBe(false);
    const store = new EnergyStore(path);
    expect(store.readHours(hour, hour + 3_600)).toEqual([
      { hour, wattSeconds: 36_000, samples: 1_800, downlinkBits: 0, uplinkBits: 0 },
    ]);
    expect(store.lastWrittenMinute).toBe(hour + 29 * 60);
    expect(existsSync(join(dir, "energy-hourly.ndjson"))).toBe(true);
  });

  it("serves a recent range from memory identically to the log", () => {
    const path = join(dir, "energy.ndjson");
    const store = new EnergyStore(path);
    const minute = nowSec() - (nowSec() % 60) - 600;
    store.append({ minute, wattSeconds: 60, samples: 60, downlinkBits: 1, uplinkBits: 1 });
    expect(store.readRange(minute - 60, minute + 60)).toEqual([
      { minute, wattSeconds: 60, samples: 60, downlinkBits: 1, uplinkBits: 1 },
    ]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    // A fresh instance reads the same row back into its cache.
    expect(new EnergyStore(path).readRange(minute - 60, minute + 60)).toHaveLength(1);
  });
});

describe("LatencyStore hourly tier", () => {
  it("folds a completed hour's histograms", () => {
    const store = new LatencyStore(join(dir, "latency.ndjson"));
    const hour = completedHour() - 3_600;
    const bins = new Array<number>(LATENCY_BIN_COUNT).fill(0);
    bins[4] = 60;
    const source = () => ({ count: 60, sumMs: 2_700, sumSqMs: 121_500, minMs: 45, maxMs: 45, bins: [...bins] });
    const none = () => ({ count: 0, sumMs: 0, sumSqMs: 0, minMs: null, maxMs: null, bins: bins.map(() => 0) });
    for (let index = 0; index < 60; index++) {
      store.append({ minute: hour + index * 60, samples: 60, dish: source(), router: none(), dropSum: 0, dropCount: 60 });
    }
    store.append({ minute: hour + 3_600, samples: 60, dish: source(), router: none(), dropSum: 0, dropCount: 60 });
    const [row] = store.readHours(hour, hour + 3_600);
    expect(row.hour).toBe(hour);
    expect(row.samples).toBe(3_600);
    expect(row.dish.count).toBe(3_600);
    expect(row.dish.bins[4]).toBe(3_600);
    expect(row.dish.maxMs).toBe(45);
    expect(row.dropCount).toBe(3_600);
  });
});

// Long-range chart series folded from the persisted per-minute and per-hour
// stores, for the windows the 1 Hz sample buffer cannot reach (it holds six
// hours). Pure over the rows it is handed: the historian fetches minutes, hours
// and archived months for the range and this turns them into evenly spaced
// points a chart can draw — average throughput, power draw, latency and packet
// loss per bucket, a few hundred buckets per range so a response stays small
// however long the recorder has been running.
//
// Three tiers feed a range. Minutes serve the short ranges (a day, a week) and
// the newest hours of every range, since an hour is only rolled up once it has
// completed. Hours serve a month and beyond. Archived months, which are all
// that remains of minutes past detail retention, serve the oldest stretch of
// "lifetime" as one point per month. A point says how wide it is, so a reader
// can tell a monthly average from a two-minute one.

import type { MinuteBucket, MonthBucket } from "./energyBuckets";
import type { LatencyMinuteBucket, LatencyMonthBucket } from "./latencyBuckets";
import { percentile } from "./latencySummary";

export type HistoryRange = "24h" | "1w" | "1m" | "90d" | "lifetime";

export const HISTORY_RANGES: HistoryRange[] = ["24h", "1w", "1m", "90d", "lifetime"];

/** Bucket width per range, chosen so a full range is about 700 points. */
const BUCKET_SEC: Record<Exclude<HistoryRange, "lifetime">, number> = {
  "24h": 120,
  "1w": 900,
  "1m": 3_600,
  "90d": 10_800,
};

const RANGE_SEC: Record<Exclude<HistoryRange, "lifetime">, number> = {
  "24h": 24 * 3_600,
  "1w": 7 * 86_400,
  "1m": 30 * 86_400,
  "90d": 90 * 86_400,
};

/** Most points a lifetime range is folded into; its bucket widens to fit. */
const LIFETIME_MAX_POINTS = 720;

/** One archived hour, folded from that hour's minutes once the hour completed. */
export interface HourBucket {
  /** Epoch seconds at the start of the hour. */
  hour: number;
  wattSeconds: number;
  /** Seconds actually recorded in the hour, ≤ 3600. */
  samples: number;
  downlinkBits: number;
  uplinkBits: number;
}

/** The latency store's hourly row — a month row's stats keyed by hour. */
export interface LatencyHourBucket extends Omit<LatencyMonthBucket, "month"> {
  hour: number;
}

export interface HistoryPoint {
  /** Epoch seconds at the start of the bucket. */
  t: number;
  /** Bucket width in seconds — the stretch this point averages over. */
  span: number;
  /** Seconds of the bucket actually recorded; below `span` means a gap inside it. */
  seconds: number;
  downBps: number | null;
  upBps: number | null;
  powerW: number | null;
  /** Mean dish pop-ping latency over the bucket's readings. */
  latencyMs: number | null;
  latencyP95Ms: number | null;
  /** Mean packet loss, 0–100. */
  dropPct: number | null;
}

export interface HistorySeries {
  range: HistoryRange;
  startSec: number;
  endSec: number;
  /** Nominal bucket width; archived months are wider and say so per point. */
  bucketSec: number;
  points: HistoryPoint[];
}

/** Everything the historian hands over for one range. Rows may overlap in
 *  time across tiers; each tier is used only where a finer one has nothing. */
export interface HistoryInputs {
  minutes: MinuteBucket[];
  hours: HourBucket[];
  months: MonthBucket[];
  latencyMinutes: LatencyMinuteBucket[];
  latencyHours: LatencyHourBucket[];
  latencyMonths: LatencyMonthBucket[];
}

export function hourKeyOf(minuteSec: number): number {
  return Math.floor(minuteSec / 3_600) * 3_600;
}

/** Local start of the month after the one `monthSec` starts, epoch seconds. */
function nextMonthSec(monthSec: number): number {
  const date = new Date(monthSec * 1000);
  date.setMonth(date.getMonth() + 1);
  return Math.floor(date.getTime() / 1000);
}

/** Group expired minute rows into one row per completed hour. Pure — the
 *  caller decides which hours are complete. */
export function foldMinutesToHours(buckets: MinuteBucket[]): Map<number, HourBucket> {
  const hours = new Map<number, HourBucket>();
  for (const bucket of buckets) {
    const hour = hourKeyOf(bucket.minute);
    const row = hours.get(hour) ?? {
      hour,
      wattSeconds: 0,
      samples: 0,
      downlinkBits: 0,
      uplinkBits: 0,
    };
    row.wattSeconds += bucket.wattSeconds;
    row.samples += bucket.samples;
    row.downlinkBits += bucket.downlinkBits ?? 0;
    row.uplinkBits += bucket.uplinkBits ?? 0;
    hours.set(hour, row);
  }
  return hours;
}

function emptyLatencyHour(hour: number, binCount: number): LatencyHourBucket {
  const source = () => ({
    count: 0,
    sumMs: 0,
    sumSqMs: 0,
    minMs: null,
    maxMs: null,
    bins: new Array<number>(binCount).fill(0),
  });
  return { hour, samples: 0, dish: source(), router: source(), dropSum: 0, dropCount: 0 };
}

function addLatencyStats(
  into: LatencyHourBucket["dish"],
  from: LatencyHourBucket["dish"],
): LatencyHourBucket["dish"] {
  const bins = into.bins.slice();
  for (let index = 0; index < bins.length; index++) bins[index] += from.bins[index] ?? 0;
  return {
    count: into.count + from.count,
    sumMs: into.sumMs + from.sumMs,
    sumSqMs: into.sumSqMs + from.sumSqMs,
    minMs:
      into.minMs === null ? from.minMs : from.minMs === null ? into.minMs : Math.min(into.minMs, from.minMs),
    maxMs:
      into.maxMs === null ? from.maxMs : from.maxMs === null ? into.maxMs : Math.max(into.maxMs, from.maxMs),
    bins,
  };
}

/** The latency counterpart: sum an hour's histograms and running sums. */
export function foldLatencyMinutesToHours(
  buckets: LatencyMinuteBucket[],
): Map<number, LatencyHourBucket> {
  const hours = new Map<number, LatencyHourBucket>();
  for (const bucket of buckets) {
    const hour = hourKeyOf(bucket.minute);
    const row = hours.get(hour) ?? emptyLatencyHour(hour, bucket.dish.bins.length);
    hours.set(hour, {
      hour,
      samples: row.samples + bucket.samples,
      dish: addLatencyStats(row.dish, bucket.dish),
      router: addLatencyStats(row.router, bucket.router),
      dropSum: row.dropSum + bucket.dropSum,
      dropCount: row.dropCount + bucket.dropCount,
    });
  }
  return hours;
}

/** The range's window and bucket width. Lifetime starts at the oldest row of
 *  any tier and widens its bucket (whole hours) to stay under the point cap. */
export function historyRangeSpec(
  range: HistoryRange,
  now: Date,
  inputs: HistoryInputs,
): { startSec: number; endSec: number; bucketSec: number } {
  const endSec = Math.floor(now.getTime() / 1000);
  if (range !== "lifetime") {
    return { startSec: endSec - RANGE_SEC[range], endSec, bucketSec: BUCKET_SEC[range] };
  }
  const firsts = [
    inputs.minutes[0]?.minute,
    inputs.hours[0]?.hour,
    inputs.months[0]?.month,
    inputs.latencyMinutes[0]?.minute,
    inputs.latencyHours[0]?.hour,
    inputs.latencyMonths[0]?.month,
  ].filter((value): value is number => typeof value === "number");
  // Nothing recorded yet: a day-wide empty window rather than a zero-width one.
  const startSec = firsts.length === 0 ? endSec - 86_400 : Math.min(...firsts);
  const bucketSec = Math.max(3_600, Math.ceil((endSec - startSec) / LIFETIME_MAX_POINTS / 3_600) * 3_600);
  return { startSec, endSec, bucketSec };
}

interface Accumulator {
  t: number;
  span: number;
  seconds: number;
  wattSeconds: number;
  downlinkBits: number;
  uplinkBits: number;
  latencyCount: number;
  latencySumMs: number;
  bins: number[];
  dropSum: number;
  dropCount: number;
}

function emptyAccumulator(t: number, span: number): Accumulator {
  return {
    t,
    span,
    seconds: 0,
    wattSeconds: 0,
    downlinkBits: 0,
    uplinkBits: 0,
    latencyCount: 0,
    latencySumMs: 0,
    bins: [],
    dropSum: 0,
    dropCount: 0,
  };
}

function toPoint(acc: Accumulator): HistoryPoint {
  const rate = (bits: number) => (acc.seconds > 0 ? Math.round(bits / acc.seconds) : null);
  return {
    t: acc.t,
    span: acc.span,
    seconds: acc.seconds,
    downBps: rate(acc.downlinkBits),
    upBps: rate(acc.uplinkBits),
    powerW: acc.seconds > 0 ? Math.round((acc.wattSeconds / acc.seconds) * 10) / 10 : null,
    latencyMs:
      acc.latencyCount > 0 ? Math.round((acc.latencySumMs / acc.latencyCount) * 10) / 10 : null,
    latencyP95Ms: acc.bins.length > 0 ? percentile(acc.bins, 0.95) : null,
    dropPct: acc.dropCount > 0 ? Math.round((acc.dropSum / acc.dropCount) * 1000) / 10 : null,
  };
}

/**
 * Fold the tiers into one series of points over [startSec, endSec).
 *
 * Fixed-width buckets are keyed by their start. A tier's row lands in the
 * bucket its own start falls in — minute and hour rows are never wider than a
 * bucket, so that is exact. Archived months are the exception: each is its own
 * point, as wide as the month, and is used only before the first hour row, so
 * no stretch is counted twice. Within the fixed buckets, hour rows are used
 * only for hours no minute row covers, and vice versa: minutes are the finer
 * source for the newest hours, hours for everything older.
 */
export function buildHistorySeries(
  range: HistoryRange,
  now: Date,
  inputs: HistoryInputs,
): HistorySeries {
  const { startSec, endSec, bucketSec } = historyRangeSpec(range, now, inputs);
  const buckets = new Map<number, Accumulator>();
  const bucketFor = (rowSec: number): Accumulator | null => {
    if (rowSec < startSec || rowSec >= endSec) return null;
    const key = startSec + Math.floor((rowSec - startSec) / bucketSec) * bucketSec;
    let acc = buckets.get(key);
    if (!acc) {
      acc = emptyAccumulator(key, Math.min(bucketSec, endSec - key));
      buckets.set(key, acc);
    }
    return acc;
  };

  // Hours that a minute row covers are served by minutes; those hour rows are
  // skipped so an hour is never counted twice.
  const minuteHours = new Set<number>();
  for (const minute of inputs.minutes) minuteHours.add(hourKeyOf(minute.minute));
  for (const minute of inputs.latencyMinutes) minuteHours.add(hourKeyOf(minute.minute));

  const firstHour = Math.min(
    inputs.hours[0]?.hour ?? Infinity,
    inputs.latencyHours[0]?.hour ?? Infinity,
    [...minuteHours].reduce((min, hour) => Math.min(min, hour), Infinity),
  );

  for (const minute of inputs.minutes) {
    const acc = bucketFor(minute.minute);
    if (!acc) continue;
    acc.seconds += minute.samples;
    acc.wattSeconds += minute.wattSeconds;
    acc.downlinkBits += minute.downlinkBits ?? 0;
    acc.uplinkBits += minute.uplinkBits ?? 0;
  }
  for (const hour of inputs.hours) {
    if (minuteHours.has(hour.hour)) continue;
    const acc = bucketFor(hour.hour);
    if (!acc) continue;
    acc.seconds += hour.samples;
    acc.wattSeconds += hour.wattSeconds;
    acc.downlinkBits += hour.downlinkBits;
    acc.uplinkBits += hour.uplinkBits;
  }

  const addLatency = (
    acc: Accumulator,
    row: { dish: LatencyMonthBucket["dish"]; dropSum: number; dropCount: number },
  ) => {
    acc.latencyCount += row.dish.count;
    acc.latencySumMs += row.dish.sumMs;
    if (acc.bins.length === 0) acc.bins = new Array<number>(row.dish.bins.length).fill(0);
    for (let index = 0; index < acc.bins.length; index++) acc.bins[index] += row.dish.bins[index] ?? 0;
    acc.dropSum += row.dropSum;
    acc.dropCount += row.dropCount;
  };
  for (const minute of inputs.latencyMinutes) {
    const acc = bucketFor(minute.minute);
    if (acc) addLatency(acc, minute);
  }
  for (const hour of inputs.latencyHours) {
    if (minuteHours.has(hour.hour)) continue;
    const acc = bucketFor(hour.hour);
    if (acc) addLatency(acc, hour);
  }

  // Archived months: one point each, only for months that ended before the
  // first hour row, since anything later is already served in finer detail.
  const monthPoints = new Map<number, Accumulator>();
  const monthAccumulator = (month: number): Accumulator | null => {
    const monthEnd = nextMonthSec(month);
    if (monthEnd > firstHour || month < startSec || month >= endSec) return null;
    let acc = monthPoints.get(month);
    if (!acc) {
      acc = emptyAccumulator(month, monthEnd - month);
      monthPoints.set(month, acc);
    }
    return acc;
  };
  for (const month of inputs.months) {
    const acc = monthAccumulator(month.month);
    if (!acc) continue;
    // A month row's `samples` sums its minutes' sampled seconds, like an hour's.
    acc.seconds += month.samples;
    acc.wattSeconds += month.wattSeconds;
    acc.downlinkBits += month.downlinkBits;
    acc.uplinkBits += month.uplinkBits;
  }
  for (const month of inputs.latencyMonths) {
    const acc = monthAccumulator(month.month);
    if (acc) addLatency(acc, month);
  }

  const points = [...monthPoints.values(), ...buckets.values()]
    .filter((acc) => acc.seconds > 0 || acc.latencyCount > 0 || acc.dropCount > 0)
    .sort((a, b) => a.t - b.t)
    .map(toPoint);
  return { range, startSec, endSec, bucketSec, points };
}

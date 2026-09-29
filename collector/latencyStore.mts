// Persistent per-minute latency store, dependency-free (JSON Lines append log).
//
// One line per *completed* wall-clock minute holding that minute's latency
// histogram and sums (see core/latencyBuckets). Mirrors the energy store's
// shape and lifecycle: current-year minutes in detail, older minutes folded
// into one row per month before the minutes go, so a year of latency quality
// stays answerable without re-fetching the dish.
//
// Retention follows the calendar, the way Starlink's own usage page does:
// per-minute detail for the current year only. Older minutes are not deleted —
// they are folded into one row per month before the minutes go. A year of
// minutes is ~525k lines; the rollup answers "how was March?" with one.

import {
  appendJsonLines,
  ensureParentDirectory,
  readJsonLines,
  writeJsonLinesAtomically,
} from "./jsonLinesFile.mts";
import { minuteCutoffSec, retentionDaysFromEnv } from "./retention.mts";
import { HourlyTier } from "./hourlyTier.mts";
import { foldLatencyMinutesToHours, type LatencyHourBucket } from "../core/historySeries.ts";
import { RECENT_MINUTES_SEC } from "./minuteCache.mts";
import {
  foldLatencyMinutesToMonths,
  latencyMonthKeyOf,
  latencyYearStartSec,
  addLatencyMonthBucket,
  type LatencyMinuteBucket,
  type LatencyMonthBucket,
} from "../core/latencyBuckets.ts";

// The fold primitives and bucket shapes are shared with the extension, so they
// live in core; re-exported here because this store and the historian have
// always reached for them by this name.
export {
  foldLatencyMinutesToMonths,
  latencyMonthKeyOf,
  latencyYearStartSec,
  addLatencyMonthBucket,
  type LatencyMinuteBucket,
  type LatencyMonthBucket,
};

export class LatencyStore {
  private maxWrittenMinute = -1;
  /** Sibling log holding one row per archived month. */
  private readonly monthlyPath: string;
  /** Sibling log holding one row per completed hour, kept for good. */
  private readonly hourly: HourlyTier<LatencyMinuteBucket, LatencyHourBucket>;
  /** The newest minutes in memory; see EnergyStore for why. */
  private recent: LatencyMinuteBucket[] = [];

  constructor(private readonly filePath: string) {
    this.monthlyPath = filePath.replace(/\.ndjson$/, "") + "-monthly.ndjson";
    ensureParentDirectory(filePath);
    this.hourly = new HourlyTier(
      filePath.replace(/\.ndjson$/, "") + "-hourly.ndjson",
      foldLatencyMinutesToHours,
    );
    const all = this.readAll();
    const nowSec = Math.floor(Date.now() / 1000);
    this.hourly.backfill(all, nowSec);
    this.compact();
    for (const bucket of all) {
      if (bucket.minute > this.maxWrittenMinute) this.maxWrittenMinute = bucket.minute;
    }
    this.recent = all
      .filter((bucket) => bucket.minute >= nowSec - RECENT_MINUTES_SEC)
      .sort((a, b) => a.minute - b.minute);
  }

  /**
   * Keep per-minute detail for the current calendar year; fold everything older
   * into monthly rows first, so a year rollover summarises last year rather than
   * erasing it. Idempotent: a month already archived is not written twice.
   */
  compact(): number {
    const all = this.readAll();
    const now = new Date();
    const cutoffSec = minuteCutoffSec(
      latencyYearStartSec(now),
      now,
      retentionDaysFromEnv("HISTORIAN_MINUTE_RETENTION_DAYS"),
    );
    const kept = all.filter((bucket) => bucket.minute >= cutoffSec);
    const expired = all.filter((bucket) => bucket.minute < cutoffSec);
    if (expired.length === 0) return 0;

    // Already-archived months are excluded before folding, not after: this log
    // is append-only, so a month written twice would read back as two rows
    // instead of one.
    const archived = new Set(this.readMonths().map((row) => row.month));
    const notYetArchived = expired.filter(
      (bucket) => !archived.has(latencyMonthKeyOf(bucket.minute)),
    );
    const folded = foldLatencyMinutesToMonths(notYetArchived);
    appendJsonLines(
      this.monthlyPath,
      [...folded.values()].sort((a, b) => a.month - b.month),
    );

    writeJsonLinesAtomically(this.filePath, kept);
    return expired.length;
  }

  /** Archived monthly summaries, oldest first. Cheap: one row per month. */
  readMonths(): LatencyMonthBucket[] {
    return readJsonLines<LatencyMonthBucket>(this.monthlyPath).sort((a, b) => a.month - b.month);
  }

  /** Newest minute already persisted; incoming samples at/below this are ignored to avoid double-counting on restart. */
  get lastWrittenMinute(): number {
    return this.maxWrittenMinute;
  }

  append(bucket: LatencyMinuteBucket): void {
    appendJsonLines(this.filePath, [bucket]);
    if (bucket.minute > this.maxWrittenMinute) this.maxWrittenMinute = bucket.minute;
    const nowSec = Math.floor(Date.now() / 1000);
    this.recent.push(bucket);
    while (this.recent.length > 0 && this.recent[0].minute < nowSec - RECENT_MINUTES_SEC) {
      this.recent.shift();
    }
    this.hourly.noteMinute(bucket);
    this.hourly.rollup(this.recent, nowSec);
  }

  private readAll(): LatencyMinuteBucket[] {
    return readJsonLines<LatencyMinuteBucket>(this.filePath);
  }

  /** Persisted buckets whose minute falls in [startSec, endSec). Served from
   *  memory when the range lies within the recent minutes, else from disk. */
  readRange(startSec: number, endSec: number): LatencyMinuteBucket[] {
    const cacheFloorSec = Math.floor(Date.now() / 1000) - RECENT_MINUTES_SEC;
    const source = startSec >= cacheFloorSec ? this.recent : this.readAll();
    return source.filter((bucket) => bucket.minute >= startSec && bucket.minute < endSec);
  }

  /** Completed hours in [startSec, endSec), oldest first. Kept for good. */
  readHours(startSec: number, endSec: number): LatencyHourBucket[] {
    return this.hourly.readRange(startSec, endSec);
  }
}

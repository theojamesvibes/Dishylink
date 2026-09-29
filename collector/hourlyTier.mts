// The hourly tier of a per-minute store: one row per completed hour, kept for
// good, so a chart reaching back months or years reads a few thousand rows
// instead of every minute the recorder ever wrote.
//
// A sibling JSON Lines log next to the minute file (`<store>-hourly.ndjson`),
// held whole in memory: a year is under nine thousand rows. Rows are folded
// from the minute rows, so nothing here is a new measurement — only a coarser
// view of ones already on disk, which is why the file can be rebuilt from the
// minutes at any time and is on first start (a store upgraded from a build
// without this tier backfills every hour its minutes still cover).
//
// An hour is folded once it has completed on the clock. A minute for an
// already-folded hour can still turn up — the recorder restarted inside the
// hour and the dish's ring buffer handed back the minutes it missed — so a
// re-fold that finds more recorded seconds than the row holds replaces the
// row, rewriting the file whole. That is rare and the file is small.
//
// Generic over the minute and hour shapes, so the energy and latency stores
// share one lifecycle and differ only in how an hour is summed.

import { appendJsonLines, readJsonLines, writeJsonLinesAtomically } from "./jsonLinesFile.mts";

interface MinuteRow {
  minute: number;
  samples: number;
}

interface HourRow {
  hour: number;
  samples: number;
}

export class HourlyTier<M extends MinuteRow, H extends HourRow> {
  private readonly rows = new Map<number, H>();
  /** Hours minutes have arrived for since the last fold. */
  private readonly touched = new Set<number>();

  constructor(
    private readonly filePath: string,
    private readonly fold: (minutes: M[]) => Map<number, H>,
  ) {
    for (const row of readJsonLines<H>(filePath)) this.rows.set(row.hour, row);
  }

  /** Newest hour a row exists for, or null when the tier is empty. */
  get newestHour(): number | null {
    let newest: number | null = null;
    for (const hour of this.rows.keys()) if (newest === null || hour > newest) newest = hour;
    return newest;
  }

  /** Oldest hour a row exists for, or null when the tier is empty. */
  get oldestHour(): number | null {
    let oldest: number | null = null;
    for (const hour of this.rows.keys()) if (oldest === null || hour < oldest) oldest = hour;
    return oldest;
  }

  /** Rows whose hour falls in [startSec, endSec), oldest first. */
  readRange(startSec: number, endSec: number): H[] {
    const rows: H[] = [];
    for (const row of this.rows.values()) {
      if (row.hour >= startSec && row.hour < endSec) rows.push(row);
    }
    return rows.sort((a, b) => a.hour - b.hour);
  }

  /** Note a minute just written, so its hour is folded once it completes. */
  noteMinute(minute: M): void {
    this.touched.add(hourKeyOf(minute.minute));
  }

  /**
   * Fold every touched hour that has completed by `nowSec`, from the minute
   * rows given (which must include all of that hour's minutes). Returns how
   * many rows were written. Untouched hours are left alone; pass every hour
   * the minutes cover as touched (see `backfill`) to rebuild from scratch.
   */
  rollup(minutes: M[], nowSec: number): number {
    const currentHour = hourKeyOf(nowSec);
    const due = [...this.touched].filter((hour) => hour < currentHour);
    if (due.length === 0) return 0;
    const dueSet = new Set(due);
    const folded = this.fold(minutes.filter((row) => dueSet.has(hourKeyOf(row.minute))));
    const appended: H[] = [];
    let replaced = 0;
    for (const hour of due) {
      this.touched.delete(hour);
      const row = folded.get(hour);
      if (!row) continue;
      const existing = this.rows.get(hour);
      if (!existing) {
        this.rows.set(hour, row);
        appended.push(row);
      } else if (row.samples > existing.samples) {
        this.rows.set(hour, row);
        replaced++;
      }
    }
    if (replaced > 0) {
      writeJsonLinesAtomically(
        this.filePath,
        [...this.rows.values()].sort((a, b) => a.hour - b.hour),
      );
    } else if (appended.length > 0) {
      appendJsonLines(
        this.filePath,
        appended.sort((a, b) => a.hour - b.hour),
      );
    }
    return appended.length + replaced;
  }

  /** Fold every completed hour the minute rows cover that has no row yet, or
   *  a thinner one. Run at start-up over the whole minute log. */
  backfill(minutes: M[], nowSec: number): number {
    for (const row of minutes) this.touched.add(hourKeyOf(row.minute));
    return this.rollup(minutes, nowSec);
  }
}

export function hourKeyOf(sec: number): number {
  return Math.floor(sec / 3_600) * 3_600;
}

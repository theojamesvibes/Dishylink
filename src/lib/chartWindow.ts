// The time windows the main charts offer, and where each one's data comes from.
//
// Up to six hours a chart draws the 1 Hz samples held in memory (the dish's
// ring, backfilled from the recorder's snapshot). Past that the samples do not
// exist, and the chart draws the recorder's persisted history instead: per-
// minute averages for a day or a week, per-hour for a month and beyond, one
// point per archived month for the oldest stretch of a lifetime. A window is
// still a number of minutes so the pickers, the chart and the clip helpers keep
// one currency; "lifetime" is the one window with no fixed width, so it is
// Infinity and the caller sizes the chart from the history it gets back.

import type { HistoryRange } from "@core/historySeries";

export const LIFETIME_WINDOW_MINUTES = Infinity;

/** Longest window the live sample buffer can fill (the recorder keeps 6 h). */
export const LIVE_WINDOW_MAX_MINUTES = 360;

export const CHART_WINDOWS: { label: string; minutes: number }[] = [
  { label: "15M", minutes: 15 },
  { label: "1H", minutes: 60 },
  { label: "6H", minutes: 360 },
  { label: "24H", minutes: 1_440 },
  { label: "1W", minutes: 7 * 1_440 },
  { label: "1M", minutes: 30 * 1_440 },
  { label: "90D", minutes: 90 * 1_440 },
  { label: "Lifetime", minutes: LIFETIME_WINDOW_MINUTES },
];

/** ToggleGroup values are strings; minutes stay the source of truth.
 *  String(Infinity) is "Infinity" and Number("Infinity") is Infinity, so the
 *  lifetime window survives the round trip. */
export const CHART_WINDOW_OPTIONS = CHART_WINDOWS.map((window) => ({
  label: window.label,
  value: String(window.minutes),
}));

const HISTORY_RANGE_FOR_WINDOW = new Map<number, HistoryRange>([
  [1_440, "24h"],
  [7 * 1_440, "1w"],
  [30 * 1_440, "1m"],
  [90 * 1_440, "90d"],
  [LIFETIME_WINDOW_MINUTES, "lifetime"],
]);

/** The recorder range a window is drawn from, or null for a live-sample window. */
export function historyRangeForWindow(windowMinutes: number): HistoryRange | null {
  if (windowMinutes <= LIVE_WINDOW_MAX_MINUTES) return null;
  return HISTORY_RANGE_FOR_WINDOW.get(windowMinutes) ?? null;
}

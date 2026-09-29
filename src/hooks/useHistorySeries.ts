// The recorder's long-range series (/api/history) as chart samples, for the
// windows past the six hours of live samples. Each point is one bucket's
// averages, stamped at the bucket's midpoint so the chart's own per-pixel
// bucketing places it where it belongs. Router fields are null: the recorder
// folds only the dish's series into hours, and a chart asked for the router's
// line over a month is told there is nothing rather than shown zeros.

import { useMemo } from "react";
import type { TelemetrySample } from "@core/telemetry";
import type { HistoryRange, HistorySeries } from "@core/historySeries";
import { usePersistedHistory } from "./usePersistedHistory";

export interface HistorySeriesState {
  samples: TelemetrySample[];
  /** Where the range starts, for sizing a chart whose window has no fixed width. */
  startMs: number | null;
  /** Widest bucket in the series; a gap has to be wider than this to be real. */
  maxSpanMs: number;
  /** kWh over the recorded seconds of the range. */
  energyKWh: number;
  /** Recorded seconds over the range's seconds, 0–1. */
  coverageFraction: number;
  loading: boolean;
  unavailable: boolean;
}

const EMPTY: TelemetrySample[] = [];

export function useHistorySeries(range: HistoryRange | null): HistorySeriesState {
  const history = usePersistedHistory<HistorySeries>(
    `/api/history?range=${range ?? "24h"}`,
    range !== null,
  );
  const data = range !== null ? history.data : null;
  return useMemo(() => {
    if (!data) {
      return {
        samples: EMPTY,
        startMs: null,
        maxSpanMs: 0,
        energyKWh: 0,
        coverageFraction: 0,
        loading: history.loading,
        unavailable: history.unavailable,
      };
    }
    let maxSpanSec = data.bucketSec;
    let wattSeconds = 0;
    let recordedSeconds = 0;
    const samples = data.points.map((point) => {
      if (point.span > maxSpanSec) maxSpanSec = point.span;
      if (point.powerW !== null) wattSeconds += point.powerW * point.seconds;
      recordedSeconds += point.seconds;
      return {
        timestampMs: (point.t + point.span / 2) * 1000,
        latencyMs: point.latencyMs,
        dropRate: point.dropPct === null ? 0 : point.dropPct / 100,
        downlinkBps: point.downBps ?? 0,
        uplinkBps: point.upBps ?? 0,
        powerW: point.powerW ?? 0,
        routerLatencyMs: null,
        routerPingSuccessPercent: null,
      };
    });
    const rangeSeconds = Math.max(data.endSec - data.startSec, 1);
    return {
      samples,
      startMs: data.startSec * 1000,
      maxSpanMs: maxSpanSec * 1000,
      energyKWh: wattSeconds / 3_600_000,
      coverageFraction: Math.min(recordedSeconds / rangeSeconds, 1),
      loading: history.loading,
      unavailable: history.unavailable,
    };
  }, [data, history.loading, history.unavailable]);
}

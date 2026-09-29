// How far back each store keeps its rows, and where that is allowed to change.
//
// Upstream's windows are fixed: per-minute energy and latency for the calendar
// year (then one row a month), events, alerts and thermal for 48 hours, sky
// snapshots for a week. They suit a dashboard glanced at daily. A recorder run
// for long-term statistics wants more, so each window can be widened from the
// environment — widened only: a value that is unset, empty or not a positive
// number leaves upstream's behaviour exactly as it was.
//
//   HISTORIAN_MINUTE_RETENTION_DAYS      per-minute energy + latency rows
//   HISTORIAN_EVENT_RETENTION_DAYS       outage events, alerts, thermal episodes
//   HISTORIAN_OBSTRUCTION_RETENTION_DAYS hourly sky-obstruction snapshots

const DAY_MS = 86_400_000;

/** A positive number of days from the named variable, or null for "not set". */
export function retentionDaysFromEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : null;
}

/** A store's window in milliseconds: the variable if set, else the default. */
export function retentionMs(
  name: string,
  defaultDays: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (retentionDaysFromEnv(name, env) ?? defaultDays) * DAY_MS;
}

/**
 * The minute before which per-minute rows are folded into monthly summaries.
 *
 * Upstream keeps the calendar year, so on 2 January the week view has one week
 * behind it. With a day count the cutoff is the earlier of the year start and
 * `days` ago — never later, so nothing upstream would have kept is dropped.
 *
 * The rolling cutoff is snapped back to the local start of its month. Folding
 * writes one row per month and skips months already archived, so a cutoff in the
 * middle of a month would archive its first half and then silently discard the
 * second when that expired. Whole months keep the fold honest.
 */
export function minuteCutoffSec(yearStartSec: number, now: Date, days: number | null): number {
  if (days === null) return yearStartSec;
  const monthStart = new Date(now.getTime() - days * DAY_MS);
  monthStart.setHours(0, 0, 0, 0);
  monthStart.setDate(1);
  return Math.min(yearStartSec, Math.floor(monthStart.getTime() / 1000));
}

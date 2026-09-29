// How far back the minute stores keep rows in memory.
//
// Eight days: a week-long chart window plus a day of slack, so the 1W history
// range and every shorter one are answered from memory, and an hour's minutes
// are still at hand when the hour is folded. Beyond this the minute log is
// read from disk as it always was.
export const RECENT_MINUTES_SEC = 8 * 86_400;

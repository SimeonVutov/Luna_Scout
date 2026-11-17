import type { TimeRange } from "../../api/types";

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const clockFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23" });

/** "3 Dec 2026" for one day, "3 Dec 2026 – 9 Dec 2026" for several. */
export function rangeLabel(range: TimeRange) {
  const first = snapshotAt(range, 0);
  const last = snapshotAt(range, snapshotCount(range) - 1);
  return first.toISOString().slice(0, 10) === last.toISOString().slice(0, 10)
    ? dateLabel(first)
    : `${dateLabel(first)} – ${dateLabel(last)}`;
}

export function rangeForDates(first: string, last: string): TimeRange {
  const start = Date.parse(`${first}T00:00:00Z`);
  const lastDay = Date.parse(`${last}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(lastDay) || lastDay < start) {
    throw new Error("Choose a valid start and end day.");
  }
  return {
    start_utc: new Date(start).toISOString(),
    end_utc: new Date(lastDay + dayMs).toISOString(),
    snapshot_minutes: 60,
  };
}

export function todayRange(): TimeRange {
  const today = new Date().toISOString().slice(0, 10);
  return rangeForDates(today, today);
}

export function finalDay(range: TimeRange) {
  return new Date(Date.parse(range.end_utc) - dayMs).toISOString().slice(0, 10);
}

export function snapshotCount(range: TimeRange) {
  return Math.ceil((Date.parse(range.end_utc) - Date.parse(range.start_utc)) / (range.snapshot_minutes * 60_000));
}

export function snapshotAt(range: TimeRange, index: number) {
  return new Date(Date.parse(range.start_utc) + index * range.snapshot_minutes * 60_000);
}

export function dateLabel(date: Date) {
  return dayFormat.format(date);
}

export function clockLabel(date: Date) {
  return clockFormat.format(date);
}

import type { Bounds, LongestWindow, Visibility, VisibilityWindow } from "../../api/types";
import { clockLabel, dateLabel } from "../timeline/time";

export const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
export const energy = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
export const ratio = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });
export const wholePercent = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 0 });

export const earthLabel: Record<Visibility, string> = { clear: "Visible", blocked: "Blocked", unknown: "Unresolved" };
export const sunLabel: Record<Visibility, string> = { clear: "Visible", blocked: "Hidden", unknown: "Unresolved" };

/** A value, or "low–high" when terrain coverage leaves it uncertain. */
export function bound(value: Bounds | null | undefined, format: Intl.NumberFormat, unit = "") {
  if (!value) return "—";
  const lower = format.format(value.lower);
  const upper = format.format(value.upper);
  return lower === upper ? lower + unit : `${lower}–${upper}${unit}`;
}

/** The middle of a bounded value, used for ranking and charts. */
export function middle(value: Bounds | null | undefined) {
  return value ? (value.lower + value.upper) / 2 : null;
}

export function windowTime(iso: string) {
  const time = new Date(iso);
  return `${dateLabel(time)} ${clockLabel(time)}`;
}

export function formatDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function longestLabel(window: LongestWindow | null | undefined) {
  if (!window) return "None";
  return `${window.truncated ? "≥ " : ""}${decimal.format(window.hours)} h`;
}

export type Countdown = { state: Visibility; text: string | null };

/**
 * The state at `at` and the time until it changes, from exact centre windows.
 * `text` is null when the state lasts to the end of the selected date range.
 */
export function countdown(
  windows: VisibilityWindow[] | null | undefined,
  at: Date,
  rangeEnd: string,
  nouns: { ends: string; begins: string },
): Countdown | null {
  if (!windows) return null;
  const moment = at.valueOf();
  const current = windows.find((window) => Date.parse(window.start_utc) <= moment && moment < Date.parse(window.end_utc));
  if (!current) return null;

  const end = Date.parse(current.end_utc);
  if (end >= Date.parse(rangeEnd) || current.visibility === "unknown") return { state: current.visibility, text: null };
  const noun = current.visibility === "clear" ? nouns.ends : nouns.begins;
  return { state: current.visibility, text: `${noun} in ${formatDuration(end - moment)}` };
}

/** "5 min ago", "3 h ago": how long ago something started. */
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** The UTC days a run covers, such as "15 Nov 2026" or "15 Nov – 17 Nov 2026". */
export function rangeLabel(startIso: string, endIso: string) {
  const first = new Date(startIso);
  const last = new Date(Date.parse(endIso) - 1);
  const short = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const full = dateLabel(first);
  return first.toISOString().slice(0, 10) === last.toISOString().slice(0, 10) ? full : `${short.format(first)} – ${dateLabel(last)}`;
}

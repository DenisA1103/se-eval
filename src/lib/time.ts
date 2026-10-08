/**
 * Zeitfenster der Sprints.
 *
 * Ein Sprint umfasst alle Ereignisse ab `start` 00:00 Uhr (Zeitzone Europe/Berlin) bis zum Stichtag.
 * Die Zeitzone wird über Intl korrekt einschließlich Sommer-/Winterzeit bestimmt.
 */
import type { SprintConfig } from "../config.js";

export const TIMEZONE = "Europe/Berlin";

/** Offset einer Zeitzone zu einem Zeitpunkt in Minuten (z. B. +120 für MESZ). */
export function tzOffsetMinutes(date: Date, timeZone = TIMEZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Mitternacht eines Kalendertags (JJJJ-MM-TT) in der angegebenen Zeitzone als Zeitstempel (ms). */
export function localMidnight(day: string, timeZone = TIMEZONE): number {
  const utcGuess = Date.parse(`${day}T00:00:00Z`);
  // Offset am Ziel bestimmen; zweimal, falls der Tag selbst eine Umstellung enthält
  let ts = utcGuess - tzOffsetMinutes(new Date(utcGuess), timeZone) * 60_000;
  ts = utcGuess - tzOffsetMinutes(new Date(ts), timeZone) * 60_000;
  return ts;
}

export interface Window {
  from: number;
  to: number;
}

export function sprintWindow(sprint: SprintConfig): Window {
  return { from: localMidnight(sprint.start), to: Date.parse(sprint.stichtag) };
}

export function inWindow(ts: number, w: Window): boolean {
  return ts >= w.from && ts <= w.to;
}

/** Kalendertag (JJJJ-MM-TT) eines Zeitstempels in der Zeitzone. */
export function localDay(ts: number, timeZone = TIMEZONE): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

export const HOUR = 3_600_000;

/**
 * Zeitfenster der Sprints.
 *
 * Ein Sprint umfasst alle Ereignisse ab `start` 00:00 Uhr (Zeitzone Europe/Berlin) bis zum Stichtag.
 * Beginnt ein Sprint am Tag, an dem ein anderer Sprint seinen Stichtag hat (Freitag 12:00), beginnt
 * sein Fenster erst nach diesem Stichtag. So zählt kein Ereignis in zwei Sprints.
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

/**
 * Zeitfenster eines Sprints für Ereignisse mit Zeitstempel (Commits, Pull Requests).
 * `allSprints`: alle konfigurierten Sprints, damit sich aufeinanderfolgende Fenster nicht überlappen.
 */
export function sprintWindow(sprint: SprintConfig, allSprints: readonly SprintConfig[]): Window {
  const to = Date.parse(sprint.stichtag);
  let from = localMidnight(sprint.start);
  for (const other of allSprints) {
    if (other.id === sprint.id) continue;
    const otherEnd = Date.parse(other.stichtag);
    // Stichtag eines anderen Sprints liegt im eigenen Fenster → erst danach beginnen (1 ms später, da inWindow inklusiv ist)
    if (otherEnd >= from && otherEnd < to) from = Math.max(from, otherEnd + 1);
  }
  return { from, to };
}

/**
 * Gehört ein Kalendertag (tagesgenaue Zeiterfassung) zu einem Sprint?
 * Ein Tageseintrag lässt sich nicht am Stichtag 12:00 teilen. Regel: Der Stichtag-Tag zählt zum Sprint,
 * der an diesem Tag beginnt; beginnt an diesem Tag keiner (z. B. Code-Freeze), zählt er zum endenden Sprint.
 * Damit gehört jeder Tag zu höchstens einem Sprint.
 */
export function dayInSprint(day: string, sprint: SprintConfig, allSprints: readonly SprintConfig[]): boolean {
  const t = localMidnight(day);
  const startDay = localMidnight(sprint.start);
  const endDay = localMidnight(localDay(Date.parse(sprint.stichtag)));
  if (t < startDay || t > endDay) return false;
  if (t === endDay && t !== startDay) {
    return !allSprints.some((o) => o.id !== sprint.id && localMidnight(o.start) === endDay);
  }
  return true;
}

export function inWindow(ts: number, w: Window): boolean {
  return ts >= w.from && ts <= w.to;
}

/** Kalendertag (JJJJ-MM-TT) eines Zeitstempels in der Zeitzone. */
export function localDay(ts: number, timeZone = TIMEZONE): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

export const HOUR = 3_600_000;

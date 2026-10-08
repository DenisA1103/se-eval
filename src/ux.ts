/**
 * Auswertung der UX-Tests einer Phase (nach dem Code-Freeze).
 *
 * Design laut Evaluationsplan: Within-Subject (jede Person testet beide Apps), Reihenfolge abwechselnd,
 * Apps verblindet als "A"/"B". Mitglieder der Teams testen nur die fremde App und werden getrennt
 * ausgewiesen (gruppe = team), Hauptstichprobe ist gruppe = extern.
 *
 *   data/ux/<phase>/ergebnisse.csv  proband;gruppe;app;reihenfolge;aufgabe;erfolg;zeit_s;fehler
 *                                   erfolg: 1 = gelöst, 0,5 = mit Hilfe/teilweise, 0 = nicht gelöst/Abbruch
 *   data/ux/<phase>/sus.csv          proband;gruppe;app;f1;…;f10   (1 = stimme gar nicht zu … 5 = stimme voll zu)
 *
 * SUS nach Brooke (1996): ungerade Items (Wert − 1), gerade Items (5 − Wert), Summe × 2,5 → 0–100.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EvalConfig } from "./config.js";
import { Problems, parseNumber, readCsv } from "./lib/csv.js";
import { mean, median, ratio, roundOrNull } from "./lib/stats.js";

/** Abbruchgrenze je Aufgabe in Sekunden (5 min laut Plan) */
export const TASK_TIME_LIMIT_S = 300;

export interface UxAppMetrics {
  app: string;
  team: string | null;
  group: string;
  participants: number;
  taskSuccessPercent: number | null;
  /** Median der Bearbeitungszeit über alle Versuche, Abbrüche mit 300 s gezählt */
  timeOnTaskMedianS: number | null;
  /** Median nur über vollständig gelöste Aufgaben */
  timeOnTaskSuccessMedianS: number | null;
  errorsPerTaskMean: number | null;
  perTask: { task: string; successPercent: number | null; timeMedianS: number | null; attempts: number }[];
  sus: { n: number; mean: number | null; median: number | null; min: number | null; max: number | null };
  /** Anzahl Personen, die diese App als erste getestet haben */
  firstInOrder: number;
}

export interface UxResult {
  phase: string;
  generatedAt: string;
  apps: UxAppMetrics[];
  warnings: string[];
}

export function susScore(items: number[]): number {
  if (items.length !== 10) throw new Error("SUS braucht genau 10 Antworten");
  let s = 0;
  items.forEach((v, i) => {
    s += i % 2 === 0 ? v - 1 : 5 - v;
  });
  return s * 2.5;
}

export function evaluateUx(cfg: EvalConfig, dataRoot: string, phase: string): UxResult {
  const dir = join(dataRoot, "ux", phase);
  const resultsFile = join(dir, "ergebnisse.csv");
  const susFile = join(dir, "sus.csv");
  if (!existsSync(resultsFile)) throw new Error(`UX-Daten fehlen: ${resultsFile}`);
  const p = new Problems();
  const warnings: string[] = [];
  const labelToTeam = new Map<string, string>();
  for (const [teamId, t] of Object.entries(cfg.teams)) {
    const label = t.uxLabel[phase];
    if (label) labelToTeam.set(label.toUpperCase(), teamId);
  }

  const rows = readCsv(resultsFile, ["proband", "gruppe", "app", "reihenfolge", "aufgabe", "erfolg", "zeit_s", "fehler"]);
  const attempts = rows.map((r) => {
    const success = parseNumber(r.erfolg);
    const time = parseNumber(r.zeit_s);
    const errors = parseNumber(r.fehler);
    const order = parseNumber(r.reihenfolge);
    if (success === null || ![0, 0.5, 1].includes(success)) p.add("ergebnisse.csv", r, `erfolg "${r.erfolg}" ungültig (1, 0,5 oder 0)`);
    if (time === null || time < 0) p.add("ergebnisse.csv", r, `zeit_s "${r.zeit_s}" ungültig`);
    if (errors === null || errors < 0) p.add("ergebnisse.csv", r, `fehler "${r.fehler}" ungültig`);
    if (order !== 1 && order !== 2) p.add("ergebnisse.csv", r, "reihenfolge muss 1 oder 2 sein");
    if (!["extern", "team"].includes((r.gruppe ?? "").toLowerCase())) p.add("ergebnisse.csv", r, 'gruppe muss "extern" oder "team" sein');
    if (!r.proband) p.add("ergebnisse.csv", r, "proband fehlt");
    return {
      proband: r.proband ?? "",
      group: (r.gruppe ?? "").toLowerCase(),
      app: (r.app ?? "").toUpperCase(),
      order: order ?? 0,
      task: r.aufgabe ?? "",
      success: success ?? 0,
      // Abbruchgrenze: längere Zeiten werden auf das Limit gekappt
      time: Math.min(time ?? 0, TASK_TIME_LIMIT_S),
      errors: errors ?? 0,
    };
  });

  const susRows = existsSync(susFile) ? readCsv(susFile, ["proband", "gruppe", "app", ...Array.from({ length: 10 }, (_, i) => `f${i + 1}`)]) : [];
  if (!existsSync(susFile)) warnings.push("sus.csv fehlt: SUS nicht ausgewertet");
  const sus = susRows.map((r) => {
    const items = Array.from({ length: 10 }, (_, i) => parseNumber(r[`f${i + 1}`]));
    if (items.some((v) => v === null || !Number.isInteger(v) || v < 1 || v > 5)) p.add("sus.csv", r, "Antworten f1–f10 müssen ganze Zahlen von 1 bis 5 sein");
    return {
      proband: r.proband ?? "",
      group: (r.gruppe ?? "").toLowerCase(),
      app: (r.app ?? "").toUpperCase(),
      score: items.every((v) => v !== null) ? susScore(items as number[]) : 0,
    };
  });
  p.throwIfAny();

  // Doppelte Proband-App-Aufgabe-Kombinationen deuten auf Tippfehler hin
  const seen = new Set<string>();
  for (const a of attempts) {
    const k = `${a.proband}|${a.app}|${a.task}`;
    if (seen.has(k)) warnings.push(`Doppelter Eintrag: ${a.proband}, App ${a.app}, Aufgabe ${a.task}`);
    seen.add(k);
  }

  const apps: UxAppMetrics[] = [];
  const keys = [...new Set(attempts.map((a) => `${a.app}|${a.group}`))].sort();
  for (const key of keys) {
    const [app, group] = key.split("|") as [string, string];
    const list = attempts.filter((a) => a.app === app && a.group === group);
    const participants = new Set(list.map((a) => a.proband));
    const tasks = [...new Set(list.map((a) => a.task))].sort((x, y) => x.localeCompare(y, "de", { numeric: true }));
    const susList = sus.filter((s) => s.app === app && s.group === group).map((s) => s.score);
    const firstInOrder = new Set(list.filter((a) => a.order === 1).map((a) => a.proband)).size;
    apps.push({
      app,
      team: labelToTeam.get(app) ?? null,
      group,
      participants: participants.size,
      taskSuccessPercent: ratio(list.reduce((s, a) => s + a.success, 0) * 100, list.length, 1),
      timeOnTaskMedianS: roundOrNull(median(list.map((a) => a.time)), 1),
      timeOnTaskSuccessMedianS: roundOrNull(median(list.filter((a) => a.success === 1).map((a) => a.time)), 1),
      errorsPerTaskMean: roundOrNull(mean(list.map((a) => a.errors)), 2),
      perTask: tasks.map((t) => {
        const tl = list.filter((a) => a.task === t);
        return {
          task: t,
          successPercent: ratio(tl.reduce((s, a) => s + a.success, 0) * 100, tl.length, 1),
          timeMedianS: roundOrNull(median(tl.map((a) => a.time)), 1),
          attempts: tl.length,
        };
      }),
      sus: {
        n: susList.length,
        mean: roundOrNull(mean(susList), 1),
        median: roundOrNull(median(susList), 1),
        min: susList.length ? Math.min(...susList) : null,
        max: susList.length ? Math.max(...susList) : null,
      },
      firstInOrder,
    });
    if (!labelToTeam.has(app)) warnings.push(`App "${app}" ist keinem Team zugeordnet (teams.<id>.uxLabel.${phase})`);
    if (group === "extern" && participants.size < 5) warnings.push(`App ${app}: nur ${participants.size} externe Proband:innen (Plan: ≥ 5)`);
  }
  return { phase, generatedAt: new Date().toISOString(), apps, warnings };
}


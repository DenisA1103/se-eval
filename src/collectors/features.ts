/**
 * Collectors "features" und "effort": Auswertung der manuell erfassten Daten.
 *
 * Features (gemeinsame Zähleinheit aus der Dozenten-Vorgabe, am Starttag kalibriert):
 *   data/features.csv           id;titel;groesse          (S=1, M=2, L=3 Punkte; für beide Teams gleich)
 *   data/<team>/abnahme.csv     sprint;feature_id;checks_bestanden;checks_gesamt;notiz
 *   Status je Feature und Sprint: alle Checks bestanden = fertig (1), mindestens einer = teilweise (0,5),
 *   keiner = offen (0). Gilt jeweils der letzte Eintrag bis einschließlich des Sprints.
 *
 * Aufwand:
 *   data/<team>/zeiterfassung.csv   datum;person;stunden;feature;taetigkeit   (15-Minuten-Raster)
 *   Plausibilitätsabgleich mit Git-Aktivität: Auffälligkeiten werden markiert, nicht korrigiert.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type EvalConfig, type SprintConfig, sprintsUpTo } from "../config.js";
import { Problems, parseDay, parseNumber, readCsv } from "../lib/csv.js";
import { runOrThrow } from "../lib/exec.js";
import { ratio, round, sum } from "../lib/stats.js";
import { localDay, localMidnight, sprintWindow } from "../lib/time.js";
import { parseLog } from "./git.js";
import { type Collector, type CollectorContext, ok, skipped } from "./types.js";

export const WEIGHTS: Record<string, number> = { S: 1, M: 2, L: 3 };

export interface Feature {
  id: string;
  title: string;
  size: string;
  points: number;
}

export interface FeatureStatus {
  id: string;
  points: number;
  status: "fertig" | "teilweise" | "offen";
  value: number;
}

export interface FeatureMetrics {
  scopePoints: number;
  features: number;
  completedPoints: number;
  /** Fertig = 1, teilweise = 0,5 */
  weightedPoints: number;
  completionPercent: number | null;
  throughputPoints: number;
  burnUp: { sprint: string; completedPoints: number; weightedPoints: number; scopePoints: number }[];
  statuses: FeatureStatus[];
}

export function loadFeatures(dataRoot: string): Feature[] {
  const file = join(dataRoot, "features.csv");
  const rows = readCsv(file, ["id", "titel", "groesse"]);
  const p = new Problems();
  const seen = new Set<string>();
  const features: Feature[] = [];
  for (const r of rows) {
    const id = (r.id ?? "").toUpperCase();
    const size = (r.groesse ?? "").toUpperCase();
    if (!id) p.add("features.csv", r, "id fehlt");
    else if (seen.has(id)) p.add("features.csv", r, `id ${id} doppelt`);
    if (!(size in WEIGHTS)) p.add("features.csv", r, `groesse "${r.groesse}" ungültig (S, M oder L)`);
    seen.add(id);
    features.push({ id, title: r.titel ?? "", size, points: WEIGHTS[size] ?? 0 });
  }
  if (features.length === 0) p.add("features.csv", null, "keine Features eingetragen");
  p.throwIfAny();
  return features;
}

interface Acceptance {
  sprint: string;
  id: string;
  passed: number;
  total: number;
}

export function loadAcceptance(file: string, features: Feature[], cfg: EvalConfig): Acceptance[] {
  const rows = readCsv(file, ["sprint", "feature_id", "checks_bestanden", "checks_gesamt"]);
  const p = new Problems();
  const ids = new Set(features.map((f) => f.id));
  const sprintIds = new Set(cfg.sprints.map((s) => s.id));
  const result: Acceptance[] = [];
  for (const r of rows) {
    const id = (r.feature_id ?? "").toUpperCase();
    const passed = parseNumber(r.checks_bestanden);
    const total = parseNumber(r.checks_gesamt);
    if (!sprintIds.has(r.sprint ?? "")) p.add("abnahme.csv", r, `unbekannter Sprint "${r.sprint}"`);
    if (!ids.has(id)) p.add("abnahme.csv", r, `unbekanntes Feature "${r.feature_id}"`);
    if (total === null || !Number.isInteger(total) || total < 1) p.add("abnahme.csv", r, "checks_gesamt muss eine ganze Zahl ≥ 1 sein");
    if (passed === null || !Number.isInteger(passed) || passed < 0 || (total !== null && passed > total)) {
      p.add("abnahme.csv", r, "checks_bestanden muss eine ganze Zahl zwischen 0 und checks_gesamt sein");
    }
    result.push({ sprint: r.sprint ?? "", id, passed: passed ?? 0, total: total ?? 1 });
  }
  p.throwIfAny();
  return result;
}

/** Status aller Features zum Ende eines Sprints (letzter Eintrag bis einschließlich dieses Sprints). */
export function statusAt(features: Feature[], acceptance: Acceptance[], sprintOrder: string[]): FeatureStatus[] {
  const allowed = new Set(sprintOrder);
  const rank = new Map(sprintOrder.map((s, i) => [s, i]));
  return features.map((f) => {
    const entries = acceptance
      .filter((a) => a.id === f.id && allowed.has(a.sprint))
      .sort((a, b) => rank.get(a.sprint)! - rank.get(b.sprint)!);
    const last = entries[entries.length - 1];
    let status: FeatureStatus["status"] = "offen";
    if (last && last.passed === last.total) status = "fertig";
    else if (last && last.passed > 0) status = "teilweise";
    const value = status === "fertig" ? 1 : status === "teilweise" ? 0.5 : 0;
    return { id: f.id, points: f.points, status, value };
  });
}

export function computeFeatureMetrics(features: Feature[], acceptance: Acceptance[], cfg: EvalConfig, sprintId: string): FeatureMetrics {
  const sprints = sprintsUpTo(cfg, sprintId).map((s) => s.id);
  const scopePoints = sum(features.map((f) => f.points));
  const burnUp = sprints.map((_, i) => {
    const st = statusAt(features, acceptance, sprints.slice(0, i + 1));
    return {
      sprint: sprints[i]!,
      completedPoints: sum(st.filter((s) => s.status === "fertig").map((s) => s.points)),
      weightedPoints: round(sum(st.map((s) => s.points * s.value)), 1),
      scopePoints,
    };
  });
  const current = burnUp[burnUp.length - 1]!;
  const previous = burnUp.length > 1 ? burnUp[burnUp.length - 2]! : null;
  return {
    scopePoints,
    features: features.length,
    completedPoints: current.completedPoints,
    weightedPoints: current.weightedPoints,
    completionPercent: ratio(current.completedPoints * 100, scopePoints, 1),
    throughputPoints: current.completedPoints - (previous?.completedPoints ?? 0),
    burnUp,
    statuses: statusAt(features, acceptance, sprints),
  };
}

export const featuresCollector: Collector<FeatureMetrics> = {
  name: "features",
  description: "Feature-Punkte (S/M/L) aus Abnahmechecks: fertig, Fertigstellungsgrad, Durchsatz, Burn-up",
  needsInstall: false,
  async collect(ctx) {
    const dataRoot = join(ctx.dataDir, "..");
    if (!existsSync(join(dataRoot, "features.csv"))) return skipped("data/features.csv fehlt (Feature-Liste vom Starttag)");
    const acceptanceFile = join(ctx.dataDir, "abnahme.csv");
    if (!existsSync(acceptanceFile)) return skipped(`data/${ctx.teamId}/abnahme.csv fehlt`);
    const features = loadFeatures(dataRoot);
    const acceptance = loadAcceptance(acceptanceFile, features, ctx.config);
    const metrics = computeFeatureMetrics(features, acceptance, ctx.config, ctx.sprint.id);
    const warnings: string[] = [];
    const inSprint = new Set(acceptance.filter((a) => a.sprint === ctx.sprint.id).map((a) => a.id));
    const notChecked = features.filter((f) => !inSprint.has(f.id)).length;
    if (notChecked > 0) warnings.push(`${notChecked} Feature(s) ohne Abnahmeeintrag in diesem Sprint (Status aus Vorsprint übernommen bzw. offen)`);
    return ok(metrics, {}, warnings);
  },
};

// ======================= Aufwand =======================

interface TimeEntry {
  day: string;
  person: string;
  hours: number;
  feature: string;
  activity: string;
}

export interface EffortMetrics {
  sprintHours: number;
  phaseHoursCumulative: number;
  perPerson: { person: string; hours: number }[];
  perActivity: { activity: string; hours: number }[];
  /** Fertige Feature-Punkte je Personenstunde (kumuliert über die Phase) */
  pointsPerPersonHour: number | null;
  /** Neu fertige Punkte dieses Sprints je Personenstunde dieses Sprints */
  sprintPointsPerPersonHour: number | null;
  plausibility: {
    daysWithHoursWithoutCommits: { person: string; day: string; hours: number }[];
    daysWithCommitsWithoutHours: { person: string; day: string; commits: number }[];
    unknownPersons: string[];
  };
}

export function loadTimeEntries(file: string): TimeEntry[] {
  const rows = readCsv(file, ["datum", "person", "stunden", "feature", "taetigkeit"]);
  const p = new Problems();
  const entries: TimeEntry[] = [];
  const perPersonDay = new Map<string, number>();
  for (const r of rows) {
    const day = parseDay(r.datum);
    const hours = parseNumber(r.stunden);
    if (!day) p.add("zeiterfassung.csv", r, `Datum "${r.datum}" ungültig (JJJJ-MM-TT oder TT.MM.JJJJ)`);
    if (!r.person) p.add("zeiterfassung.csv", r, "person fehlt");
    if (hours === null || hours <= 0) p.add("zeiterfassung.csv", r, `stunden "${r.stunden}" ungültig`);
    else if (Math.abs(hours * 4 - Math.round(hours * 4)) > 1e-9) p.add("zeiterfassung.csv", r, `stunden ${hours} nicht im 15-Minuten-Raster`);
    if (day && r.person && hours) {
      const k = `${r.person}|${day}`;
      perPersonDay.set(k, (perPersonDay.get(k) ?? 0) + hours);
      if (perPersonDay.get(k)! > 16) p.add("zeiterfassung.csv", r, `mehr als 16 Stunden am ${day} für ${r.person}`);
    }
    entries.push({ day: day ?? "", person: (r.person ?? "").trim(), hours: hours ?? 0, feature: (r.feature ?? "").toUpperCase(), activity: (r.taetigkeit ?? "").trim() });
  }
  p.throwIfAny();
  return entries;
}

function inSprintDays(day: string, sprint: SprintConfig): boolean {
  const t = localMidnight(day);
  const w = sprintWindow(sprint);
  return t >= w.from && t <= w.to;
}

export const effortCollector: Collector<EffortMetrics> = {
  name: "effort",
  description: "Personenstunden aus der Zeiterfassung, Punkte je Personenstunde, Plausibilitätsabgleich mit Git",
  needsInstall: false,
  async collect(ctx) {
    const file = join(ctx.dataDir, "zeiterfassung.csv");
    if (!existsSync(file)) return skipped(`data/${ctx.teamId}/zeiterfassung.csv fehlt`);
    const entries = loadTimeEntries(file);
    const warnings: string[] = [];
    const phaseSprints = sprintsUpTo(ctx.config, ctx.sprint.id);
    const sprintEntries = entries.filter((e) => inSprintDays(e.day, ctx.sprint));
    const phaseEntries = entries.filter((e) => phaseSprints.some((s) => inSprintDays(e.day, s)));
    const outside = entries.length - entries.filter((e) => ctx.config.sprints.some((s) => inSprintDays(e.day, s))).length;
    if (outside > 0) warnings.push(`${outside} Zeiteintrag/-einträge liegen außerhalb aller Sprints und werden nicht gezählt`);

    const group = (list: TimeEntry[], key: (e: TimeEntry) => string) => {
      const m = new Map<string, number>();
      for (const e of list) m.set(key(e), (m.get(key(e)) ?? 0) + e.hours);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const sprintHours = round(sum(sprintEntries.map((e) => e.hours)), 2);
    const phaseHours = round(sum(phaseEntries.map((e) => e.hours)), 2);

    // Feature-Punkte für die Effizienz (falls vorhanden)
    let completed: number | null = null;
    let throughput: number | null = null;
    try {
      const dataRoot = join(ctx.dataDir, "..");
      const features = loadFeatures(dataRoot);
      const fm = computeFeatureMetrics(features, loadAcceptance(join(ctx.dataDir, "abnahme.csv"), features, ctx.config), ctx.config, ctx.sprint.id);
      completed = fm.completedPoints;
      throughput = fm.throughputPoints;
    } catch {
      warnings.push("Feature-Daten nicht verfügbar: Punkte je Personenstunde nicht berechnet");
    }

    const plausibility = await plausibilityCheck(ctx, sprintEntries);
    if (plausibility.unknownPersons.length > 0) {
      warnings.push(`Personen in der Zeiterfassung ohne Commits/Namensabgleich: ${plausibility.unknownPersons.join(", ")} (Mailmap-Namen verwenden)`);
    }

    return ok<EffortMetrics>(
      {
        sprintHours,
        phaseHoursCumulative: phaseHours,
        perPerson: group(sprintEntries, (e) => e.person).map(([person, hours]) => ({ person, hours: round(hours, 2) })),
        perActivity: group(sprintEntries, (e) => e.activity || "(ohne Angabe)").map(([activity, hours]) => ({ activity, hours: round(hours, 2) })),
        pointsPerPersonHour: completed === null ? null : ratio(completed, phaseHours, 3),
        sprintPointsPerPersonHour: throughput === null ? null : ratio(throughput, sprintHours, 3),
        plausibility,
      },
      {},
      warnings,
    );
  },
};

/** Abgleich Zeiterfassung ↔ Git-Aktivität je Person und Tag (nur markieren, nicht korrigieren). */
async function plausibilityCheck(ctx: CollectorContext, entries: TimeEntry[]): Promise<EffortMetrics["plausibility"]> {
  const mailmap = join(ctx.dataDir, "mailmap");
  const gitArgs = existsSync(mailmap) ? ["-c", `mailmap.file=${mailmap}`] : [];
  // Alle Branches zum Messzeitpunkt einbeziehen: Arbeit auf noch nicht gemergten Branches ist auch Aufwand
  const res = await runOrThrow(
    "git",
    [...gitArgs, "log", "--use-mailmap", "--no-merges", `--format=\x1e%H\x1f%aN\x1f%aE\x1f%aI\x1f%cI\x1f%P\x1f%B`, ctx.commit, "--remotes"],
    { cwd: ctx.repoDir },
  );
  const w = sprintWindow(ctx.sprint);
  const commits = parseLog(res.stdout).filter((c) => c.authorTime >= w.from && c.authorTime <= w.to);
  const commitDays = new Map<string, number>();
  for (const c of commits) {
    const k = `${c.author}|${localDay(c.authorTime)}`;
    commitDays.set(k, (commitDays.get(k) ?? 0) + 1);
  }
  const hourDays = new Map<string, number>();
  for (const e of entries) hourDays.set(`${e.person}|${e.day}`, (hourDays.get(`${e.person}|${e.day}`) ?? 0) + e.hours);
  const gitPersons = new Set(commits.map((c) => c.author));
  const timePersons = new Set(entries.map((e) => e.person));
  const split = (k: string) => k.split("|") as [string, string];
  return {
    daysWithHoursWithoutCommits: [...hourDays.entries()]
      .filter(([k]) => !commitDays.has(k))
      .map(([k, hours]) => ({ person: split(k)[0], day: split(k)[1], hours: round(hours, 2) })),
    daysWithCommitsWithoutHours: [...commitDays.entries()]
      .filter(([k]) => !hourDays.has(k) && timePersons.has(split(k)[0]))
      .map(([k, n]) => ({ person: split(k)[0], day: split(k)[1], commits: n })),
    unknownPersons: [...timePersons].filter((p) => !gitPersons.has(p)),
  };
}

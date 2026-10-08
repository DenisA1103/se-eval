/**
 * Erzeugt den Vergleichsbericht results/bericht.md aus allen vorhandenen Ergebnisdateien.
 *
 * Aufbau je Phase: Snapshot-Übersicht, dann je Dimension eine Tabelle (Zeilen = Metriken,
 * Spalten = Team × Sprint). Nicht gemessene Werte werden mit Grund ausgewiesen.
 * Der Bericht ist rein deskriptiv (n = 1 Team je Arbeitsweise, keine kausalen Aussagen).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EvalConfig, LoadedConfig } from "../config.js";
import type { UxAppMetrics, UxResult } from "../ux.js";
import { TOOL_VERSION } from "../version.js";

type Json = Record<string, any>;

interface MetricDef {
  label: string;
  path: string;
  unit?: string;
  /** Hinweis zur Interpretation (erscheint als Fußnote) */
  hint?: string;
}

const SECTIONS: { title: string; collector: string; question: string; metrics: MetricDef[] }[] = [
  {
    title: "Statische Analyse",
    collector: "static",
    question: "F1 Wartbarkeit",
    metrics: [
      { label: "Codezeilen App (SLOC)", path: "sloc" },
      { label: "ESLint-Befunde je KLOC", path: "eslint.findingsPerKloc", hint: "neutrale Konfiguration, Inline-Deaktivierungen ignoriert" },
      { label: "Kognitive Komplexität Median", path: "complexity.median", hint: "über Funktionen mit Komplexität ≥ 1" },
      { label: "Kognitive Komplexität P90", path: "complexity.p90" },
      { label: "Funktionen über Schwelle (> 15)", path: "complexity.aboveThreshold" },
      { label: "tsc --strict Fehler je KLOC", path: "typescript.strictErrorsPerKloc" },
      { label: "Typ-Umgehungen je KLOC", path: "suppressions.perKloc", hint: "any, @ts-ignore, @ts-expect-error, @ts-nocheck, eslint-disable" },
      { label: "Duplizierte Zeilen", path: "duplication.percentLines", unit: "%" },
    ],
  },
  {
    title: "Testing",
    collector: "tests",
    question: "F2 Gründlichkeit",
    metrics: [
      { label: "Testfälle Unit", path: "testCases.unit" },
      { label: "Testfälle Integration", path: "testCases.integration" },
      { label: "Testfälle E2E (gezählt)", path: "testCases.e2e" },
      { label: "Anteil Testcode", path: "testCodeSharePercent", unit: "%" },
      { label: "Line Coverage", path: "coverage.linesPercent", unit: "%" },
      { label: "Branch Coverage", path: "coverage.branchesPercent", unit: "%" },
      { label: "App-Dateien ohne Coverage", path: "coverage.uncoveredFiles" },
      { label: "Fehlgeschlagene Tests (1. Lauf)", path: "results.failed" },
      { label: "Instabile Tests (flaky)", path: "results.flaky" },
    ],
  },
  {
    title: "Wirksamkeit der Tests (Mutation Testing)",
    collector: "mutation",
    question: "F2 Wirksamkeit",
    metrics: [
      { label: "Mutanten", path: "mutants" },
      { label: "Mutation Score gesamt", path: "scorePercent", unit: "%" },
      { label: "Mutation Score auf abgedecktem Code", path: "scoreCoveredPercent", unit: "%", hint: "für die 2×2-Matrix Coverage/Mutation Score" },
      { label: "Überlebende Mutanten", path: "survived" },
      { label: "Mutanten ohne Testabdeckung", path: "noCoverage" },
    ],
  },
  {
    title: "Features",
    collector: "features",
    question: "F4 Durchsatz",
    metrics: [
      { label: "Fertige Punkte (kumuliert)", path: "completedPoints" },
      { label: "Gewichtete Punkte inkl. teilweise", path: "weightedPoints" },
      { label: "Punkte gesamt (Scope)", path: "scopePoints" },
      { label: "Fertigstellungsgrad", path: "completionPercent", unit: "%" },
      { label: "Durchsatz (neu fertige Punkte im Sprint)", path: "throughputPoints" },
    ],
  },
  {
    title: "Aufwand",
    collector: "effort",
    question: "F4 Aufwand",
    metrics: [
      { label: "Personenstunden im Sprint", path: "sprintHours", unit: "h" },
      { label: "Personenstunden kumuliert (Phase)", path: "phaseHoursCumulative", unit: "h" },
      { label: "Fertige Punkte je Personenstunde (kumuliert)", path: "pointsPerPersonHour" },
      { label: "Neue Punkte je Personenstunde (Sprint)", path: "sprintPointsPerPersonHour" },
    ],
  },
  {
    title: "Git-Repository",
    collector: "git",
    question: "F5 Zusammenarbeit",
    metrics: [
      { label: "Commits (ohne Merges)", path: "commits" },
      { label: "Commits je Person und Tag", path: "commitsPerPersonPerDay" },
      { label: "Commit-Größe Median (Zeilen)", path: "commitSize.median" },
      { label: "Commit-Größe P90 (Zeilen)", path: "commitSize.p90" },
      { label: "Gemergte Branches (Merge-Commits)", path: "mainline.merges" },
      { label: "Branch-Lebensdauer Median", path: "mainline.branchLifetimeHours.median", unit: "h" },
      { label: "Commits auf main ohne Merge-Commit", path: "mainline.firstParentNonMerge", hint: "enthält auch Squash-/Rebase-Merges, siehe GitHub" },
      { label: "Feature-Durchlaufzeit Median", path: "features.leadTimeHoursMedian", unit: "h", hint: "erster Commit mit Feature-ID bis Integration in main; bei Squash-Merges ohne Branch-Historie nahe 0 h, dann die PR-Zeit bis Merge heranziehen" },
      { label: "Commits mit KI-Co-Autor", path: "aiCoAuthored.percent", unit: "%", hint: "nur beschreibend" },
    ],
  },
  {
    title: "Pull Requests (GitHub)",
    collector: "github",
    question: "F5 Zusammenarbeit",
    metrics: [
      { label: "Gemergte PRs", path: "prsMerged" },
      { label: "PRs mit Review", path: "reviewedPercent", unit: "%" },
      { label: "PRs mit Approval", path: "approvedPercent", unit: "%" },
      { label: "Kommentare je PR (Median)", path: "commentsPerPrMedian" },
      { label: "Zeit bis Merge Median", path: "timeToMergeHours.median", unit: "h" },
      { label: "Direkte Commits ohne PR", path: "directCommitsWithoutPr" },
    ],
  },
];

function get(obj: Json | null | undefined, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k] : undefined), obj);
}

function fmt(v: unknown, unit?: string): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "number") return `${v.toLocaleString("de-DE", { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;
  return String(v);
}

function readJson(path: string): Json | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : null;
}

/** Ergebnisse aller Teams und Sprints einer Phase einlesen. */
function loadPhase(baseDir: string, cfg: EvalConfig, phase: string) {
  const sprints = cfg.sprints.filter((s) => s.phase === phase);
  const columns: { teamId: string; sprintId: string; dir: string }[] = [];
  for (const teamId of Object.keys(cfg.teams)) {
    for (const s of sprints) {
      const dir = join(baseDir, "results", teamId, s.id);
      if (existsSync(join(dir, "manifest.json"))) columns.push({ teamId, sprintId: s.id, dir });
    }
  }
  return columns;
}

export function renderReport(loaded: LoadedConfig): string {
  const { config: cfg, baseDir } = loaded;
  const out: string[] = [];
  const phases = [...new Set(cfg.sprints.map((s) => s.phase))];
  out.push(`# Evaluationsbericht (automatisch erzeugt)`);
  out.push("");
  out.push(`Evaluationsplan v${cfg.planVersion} · se-eval ${TOOL_VERSION} · Konfiguration sha256:${loaded.hash.slice(0, 12)} · erzeugt ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}`);
  out.push("");
  out.push(
    "> Rein deskriptiver Vergleich (je Arbeitsweise ein Team, n = 1). Unterschiede sind keine Belege für kausale Effekte der Arbeitsweise. " +
      "Alle Zahlen sind aus den Rohdaten in `results/<team>/<sprint>/raw/` nachrechenbar.",
  );

  const allWarnings: string[] = [];
  for (const phase of phases) {
    const columns = loadPhase(baseDir, cfg, phase);
    out.push("", `## Phase ${phase}`, "");
    const teamsLine = Object.entries(cfg.teams)
      .map(([id, t]) => `**${t.name}** (${id}): ${t.arbeitsweise[phase] ?? "Arbeitsweise noch nicht festgelegt"}`)
      .join(" · ");
    out.push(teamsLine, "");
    if (columns.length === 0) {
      out.push("_Noch keine Messungen._");
      continue;
    }
    const head = columns.map((c) => {
      const aw = cfg.teams[c.teamId]?.arbeitsweise[phase];
      return `${c.teamId}${aw ? ` (${aw})` : ""} · ${c.sprintId}`;
    });
    // Snapshot-Übersicht
    out.push("### Snapshots", "");
    out.push(`| | ${head.join(" | ")} |`, `|---|${head.map(() => "---").join("|")}|`);
    const snaps = columns.map((c) => readJson(join(c.dir, "snapshot.json")));
    out.push(`| Commit | ${snaps.map((s) => (s ? `\`${String(s.commit).slice(0, 10)}\`` : "–")).join(" | ")} |`);
    out.push(`| Commit-Datum | ${snaps.map((s) => (s ? new Date(s.commitDate).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "–")).join(" | ")} |`);
    out.push(`| Stichtag | ${snaps.map((s) => (s ? new Date(s.stichtag).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "–")).join(" | ")} |`);

    for (const section of SECTIONS) {
      const results = columns.map((c) => readJson(join(c.dir, `${section.collector}.json`)));
      if (results.every((r) => r === null)) continue;
      out.push("", `### ${section.title} (${section.question})`, "");
      // Ganze Dimension nicht gemessen: eine Zeile statt einer Tabelle voller Platzhalter
      if (results.every((r) => r === null || r.status !== "ok")) {
        const reasons = [...new Set(results.filter(Boolean).map((r) => String(r!.reason ?? "").split("\n")[0]))];
        out.push(`_Nicht gemessen: ${reasons.join("; ")}_`);
        results.forEach((r, i) => {
          if (r) allWarnings.push(`${head[i]} · ${section.collector}: ${r.status === "skipped" ? "übersprungen" : "nicht gemessen"} – ${String(r.reason ?? "").split("\n")[0]}`);
        });
        continue;
      }
      out.push(`| Metrik | ${head.join(" | ")} |`, `|---|${head.map(() => "---:").join("|")}|`);
      const hints: string[] = [];
      for (const m of section.metrics) {
        const cells = results.map((r) => {
          if (!r) return "–";
          if (r.status !== "ok") return r.status === "skipped" ? "übersprungen" : "nicht gemessen";
          return fmt(get(r.metrics, m.path), m.unit);
        });
        let label = m.label;
        if (m.hint) {
          hints.push(m.hint);
          label += `<sup>${hints.length}</sup>`;
        }
        out.push(`| ${label} | ${cells.join(" | ")} |`);
      }
      if (hints.length) out.push("", hints.map((h, i) => `<sup>${i + 1}</sup> ${h}`).join(" · "));
      results.forEach((r, i) => {
        if (!r) return;
        const col = head[i];
        if (r.status !== "ok") allWarnings.push(`${col} · ${section.collector}: ${r.status === "skipped" ? "übersprungen" : "nicht gemessen"} – ${String(r.reason ?? "").split("\n")[0]}`);
        for (const w of (r.warnings as string[]) ?? []) allWarnings.push(`${col} · ${section.collector}: ${w}`);
      });
    }

    // Beitragsanteile je Person (letzter Sprint je Team)
    const lastPerTeam = new Map<string, (typeof columns)[number]>();
    for (const c of columns) lastPerTeam.set(c.teamId, c);
    const personRows: string[] = [];
    for (const [teamId, c] of lastPerTeam) {
      const git = readJson(join(c.dir, "git.json"));
      if (git?.status !== "ok") continue;
      for (const p of git.metrics.persons as Json[]) {
        personRows.push(`| ${teamId} · ${c.sprintId} | ${p.person} | ${p.commits} | ${fmt(p.commitSharePercent, "%")} | ${fmt(p.lineSharePercent, "%")} | ${p.activeDays} |`);
      }
    }
    if (personRows.length) {
      out.push("", "### Beitragsverteilung (letzter gemessener Sprint)", "");
      out.push("| Team · Sprint | Person | Commits | Anteil Commits | Anteil Zeilen | Aktive Tage |", "|---|---|---:|---:|---:|---:|", ...personRows);
    }

    // UX
    const ux = readJson(join(baseDir, "results", "ux", `${phase}.json`)) as UxResult | null;
    if (ux) out.push(...renderUx(ux, cfg));
  }

  if (allWarnings.length) {
    out.push("", "## Hinweise zur Messung", "", ...allWarnings.map((w) => `- ${w}`));
  }
  out.push("");
  return out.join("\n");
}

function renderUx(ux: UxResult, cfg: EvalConfig): string[] {
  const out = ["", "### Usability-Tests (F3)", ""];
  const name = (a: UxAppMetrics) => `App ${a.app}${a.team ? ` (${cfg.teams[a.team]?.name ?? a.team})` : ""} · ${a.group}`;
  out.push(`| Metrik | ${ux.apps.map(name).join(" | ")} |`, `|---|${ux.apps.map(() => "---:").join("|")}|`);
  const row = (label: string, f: (a: UxAppMetrics) => string) => out.push(`| ${label} | ${ux.apps.map(f).join(" | ")} |`);
  row("Proband:innen", (a) => fmt(a.participants));
  row("Task Success", (a) => fmt(a.taskSuccessPercent, "%"));
  row("Time-on-Task Median (alle, Abbruch = 300 s)", (a) => fmt(a.timeOnTaskMedianS, "s"));
  row("Time-on-Task Median (nur gelöst)", (a) => fmt(a.timeOnTaskSuccessMedianS, "s"));
  row("Fehler je Aufgabe (Mittel)", (a) => fmt(a.errorsPerTaskMean));
  row("SUS Mittelwert", (a) => fmt(a.sus.mean));
  row("SUS Median", (a) => fmt(a.sus.median));
  row("Als erste App getestet", (a) => fmt(a.firstInOrder));
  out.push("", "Zum Vergleich: Der SUS-Durchschnitt über viele Studien liegt bei etwa 68 (MeasuringU). Hauptstichprobe ist die Gruppe „extern“.");
  if (ux.warnings.length) out.push("", ...ux.warnings.map((w) => `- ${w}`));
  return out;
}

/** Listet vorhandene Ergebnisverzeichnisse (für die CLI-Ausgabe). */
export function listResults(baseDir: string): string[] {
  const root = join(baseDir, "results");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const team of readdirSync(root)) {
    const tdir = join(root, team);
    if (team === "ux" || !statSync(tdir).isDirectory()) continue;
    for (const sprint of readdirSync(tdir)) {
      if (existsSync(join(tdir, sprint, "manifest.json"))) out.push(`${team}/${sprint}`);
    }
  }
  return out;
}

/**
 * Laden und Validieren der Evaluationskonfiguration (eval.config.json).
 *
 * Die Konfiguration ist Teil des Messvertrags: Sie wird vor Projektstart von beiden Teams
 * bestätigt und danach nur noch über das Änderungsprotokoll geändert. Ihr SHA-256-Hash wird
 * in jedes Ergebnis geschrieben, damit nachvollziehbar bleibt, mit welcher Konfiguration
 * gemessen wurde.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT erwartet");
// Stichtag mit Uhrzeit und Zeitzonen-Offset, z. B. 2026-10-23T12:00:00+02:00
const isoDateTime = z
  .string()
  .refine((s) => /T\d{2}:\d{2}/.test(s) && /([+-]\d{2}:\d{2}|Z)$/.test(s) && !Number.isNaN(Date.parse(s)), {
    message: "Zeitpunkt mit Uhrzeit und Zeitzone erwartet, z. B. 2026-10-23T12:00:00+02:00",
  });

const ArbeitsweiseSchema = z.enum(["klassisch", "agentisch"]);

const TeamSchema = z.object({
  name: z.string().min(1),
  /** Git-URL oder lokaler Pfad des Projekt-Repos */
  repo: z.string().min(1),
  /** Optional "owner/repo" für die GitHub-API (PRs, Reviews) */
  github: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  /** Hauptbranch, auf dem der Snapshot genommen wird */
  branch: z.string().default("main"),
  /** Arbeitsweise je Phase, z. B. { "P1": "klassisch", "P2": "agentisch" } */
  arbeitsweise: z.record(z.string(), ArbeitsweiseSchema).default({}),
  /** Neutrale Bezeichnung der App im UX-Test (Verblindung), z. B. "A" */
  uxLabel: z.record(z.string(), z.string()).default({}),
});

const SprintSchema = z.object({
  id: z.string().regex(/^[\w-]+$/, "Sprint-ID nur aus Buchstaben, Ziffern, - und _"),
  phase: z.string().min(1),
  /** Erster Tag des Sprints (inklusive) */
  start: isoDate,
  /** Snapshot-Zeitpunkt: letzter Commit auf dem Hauptbranch vor diesem Zeitpunkt */
  stichtag: isoDateTime,
});

const ScopeSchema = z.object({
  /** App-Code (Gegenstand von statischer Analyse und Coverage) */
  app: z.array(z.string()).min(1),
  /** Testdateien (werden aus dem App-Code herausgerechnet) */
  tests: z.array(z.string()).min(1),
  /** Kernlogik für Mutation Testing (am Starttag gemeinsam festgelegt) */
  core: z.array(z.string()).default([]),
  /** Immer ausgeschlossen (generiert, Konfiguration, Typdeklarationen) */
  exclude: z.array(z.string()).default([]),
});

const TestTypesSchema = z.object({
  /** Muster für Integrationstests (Rest der Vitest-Tests gilt als Unit-Test) */
  integration: z.array(z.string()).default([]),
  /** Muster für End-to-End-Tests (z. B. Playwright) */
  e2e: z.array(z.string()).default([]),
});

const ConfigSchema = z.object({
  /** Version des Evaluationsplans, z. B. "1.0" */
  planVersion: z.string().min(1),
  teams: z.record(z.string().regex(/^[\w-]+$/), TeamSchema).refine((t) => Object.keys(t).length >= 1, {
    message: "Mindestens ein Team erforderlich",
  }),
  sprints: z.array(SprintSchema).min(1),
  scope: ScopeSchema,
  testTypes: TestTypesSchema.default({ integration: [], e2e: [] }),
  tests: z
    .object({
      /** Anzahl Wiederholungen der Testsuite zur Erkennung instabiler Tests */
      runs: z.number().int().min(1).max(10).default(3),
      timeoutMinutes: z.number().positive().default(15),
    })
    .default({ runs: 3, timeoutMinutes: 15 }),
  mutation: z
    .object({
      enabled: z.boolean().default(true),
      timeoutMinutes: z.number().positive().default(30),
      /** Gepinnte StrykerJS-Version, wird nur in die Arbeitskopie installiert */
      strykerVersion: z.string().default("10.0.0"),
      concurrency: z.number().int().positive().optional(),
    })
    .default({ enabled: true, timeoutMinutes: 30, strykerVersion: "10.0.0" }),
  static: z
    .object({
      /** Ab dieser kognitiven Komplexität gilt eine Funktion als zu komplex (Campbell 2018: 15) */
      complexityThreshold: z.number().int().positive().default(15),
      /** Mindestgröße eines Duplikats in Tokens (jscpd) */
      duplicateMinTokens: z.number().int().positive().default(50),
    })
    .default({ complexityThreshold: 15, duplicateMinTokens: 50 }),
  git: z
    .object({
      /** Dateien, die bei Zeilenzählungen ignoriert werden (Lockfiles, Generiertes) */
      exclude: z.array(z.string()).default([]),
      /** Regulärer Ausdruck für KI-Co-Autor-Trailer (case-insensitive) */
      aiCoAuthorPattern: z.string().default("claude|anthropic|copilot|cursor|chatgpt|openai|codex|gemini"),
      /** Regulärer Ausdruck für Feature-IDs in Branch-Namen und Commit-Nachrichten */
      featureIdPattern: z.string().default("F-\\d+"),
      /** Regulärer Ausdruck für Autor:innen, die nicht mitgezählt werden (Bots) */
      excludeAuthors: z.string().default("\\[bot\\]"),
    })
    .default({
      exclude: [],
      aiCoAuthorPattern: "claude|anthropic|copilot|cursor|chatgpt|openai|codex|gemini",
      featureIdPattern: "F-\\d+",
      excludeAuthors: "\\[bot\\]",
    }),
  /** Befehl zum Installieren der Abhängigkeiten in der Arbeitskopie */
  installCommand: z.array(z.string()).min(1).default(["npm", "ci", "--no-audit", "--no-fund"]),
});

export type EvalConfig = z.infer<typeof ConfigSchema>;
export type TeamConfig = z.infer<typeof TeamSchema>;
export type SprintConfig = z.infer<typeof SprintSchema>;

export interface LoadedConfig {
  config: EvalConfig;
  /** Absoluter Pfad der Konfigurationsdatei */
  path: string;
  /** Verzeichnis, relativ zu dem results/, data/ und work/ liegen */
  baseDir: string;
  /** SHA-256 über den Dateiinhalt */
  hash: string;
}

/** Lädt die Konfiguration und prüft sie. Wirft einen lesbaren Fehler bei ungültigen Werten. */
export function loadConfig(path: string): LoadedConfig {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`Konfigurationsdatei nicht gefunden: ${abs}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Konfigurationsdatei ist kein gültiges JSON: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(Wurzel)"}: ${i.message}`).join("\n");
    throw new Error(`Konfiguration ungültig:\n${issues}`);
  }
  validateSemantics(parsed.data);
  return {
    config: parsed.data,
    path: abs,
    baseDir: dirname(abs),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

/** Prüfungen, die über das Schema hinausgehen. */
function validateSemantics(cfg: EvalConfig): void {
  const ids = new Set<string>();
  for (const s of cfg.sprints) {
    if (ids.has(s.id)) throw new Error(`Sprint-ID doppelt: ${s.id}`);
    ids.add(s.id);
    if (Date.parse(s.stichtag) <= Date.parse(`${s.start}T00:00:00Z`) - 24 * 3600_000) {
      throw new Error(`Sprint ${s.id}: Stichtag liegt vor dem Start`);
    }
  }
  for (const pattern of [cfg.git.aiCoAuthorPattern, cfg.git.featureIdPattern, cfg.git.excludeAuthors]) {
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new Error(`Ungültiger regulärer Ausdruck in der Konfiguration: ${pattern}`);
    }
  }
}

export function getTeam(cfg: EvalConfig, teamId: string): TeamConfig {
  const team = cfg.teams[teamId];
  if (!team) throw new Error(`Unbekanntes Team "${teamId}". Bekannt: ${Object.keys(cfg.teams).join(", ")}`);
  return team;
}

export function getSprint(cfg: EvalConfig, sprintId: string): SprintConfig {
  const sprint = cfg.sprints.find((s) => s.id === sprintId);
  if (!sprint) throw new Error(`Unbekannter Sprint "${sprintId}". Bekannt: ${cfg.sprints.map((s) => s.id).join(", ")}`);
  return sprint;
}

/** Alle Sprints derselben Phase bis einschließlich des angegebenen Sprints (in Konfigurationsreihenfolge). */
export function sprintsUpTo(cfg: EvalConfig, sprintId: string): SprintConfig[] {
  const target = getSprint(cfg, sprintId);
  const result: SprintConfig[] = [];
  for (const s of cfg.sprints) {
    if (s.phase === target.phase) result.push(s);
    if (s.id === sprintId) break;
  }
  return result;
}

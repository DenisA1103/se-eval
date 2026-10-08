/**
 * Gemeinsame Typen aller Collectors.
 *
 * Jeder Collector liefert ein CollectorResult. Fehler eines Collectors brechen den Lauf nicht ab:
 * Das Ergebnis wird mit status "failed" und Begründung gespeichert und im Bericht als
 * "nicht gemessen" ausgewiesen, statt still zu fehlen.
 */
import type { EvalConfig, SprintConfig, TeamConfig } from "../config.js";
import type { Scope } from "../lib/files.js";

export type CollectorStatus = "ok" | "failed" | "skipped";

export interface CollectorResult<M = Record<string, unknown>> {
  collector: string;
  status: CollectorStatus;
  /** Begründung bei failed/skipped */
  reason?: string;
  /** Hinweise, die beim Lesen der Zahlen beachtet werden müssen */
  warnings: string[];
  startedAt: string;
  durationMs: number;
  /** Versionen der eingesetzten Werkzeuge */
  tools: Record<string, string>;
  metrics: M | null;
}

export interface CollectorContext {
  config: EvalConfig;
  configHash: string;
  teamId: string;
  team: TeamConfig;
  sprint: SprintConfig;
  /** Arbeitskopie des Repos im Snapshot-Stand */
  repoDir: string;
  /** Ablage für Rohdaten dieses Laufs: results/<team>/<sprint>/raw */
  rawDir: string;
  /** Verzeichnis mit manuell gepflegten Daten: data/<team> */
  dataDir: string;
  /** Wurzel des Evaluationstools (für neutrale Konfigurationen) */
  toolDir: string;
  scope: Scope;
  /** Snapshot-Commit */
  commit: string;
  log: (msg: string) => void;
}

export interface Collector<M = Record<string, unknown>> {
  name: string;
  /** Kurze Beschreibung für die Hilfe */
  description: string;
  /** Benötigt der Collector installierte Abhängigkeiten (npm ci) in der Arbeitskopie? */
  needsInstall: boolean;
  collect(ctx: CollectorContext): Promise<Omit<CollectorResult<M>, "collector" | "startedAt" | "durationMs">>;
}

/** Hilfsfunktion für ein erfolgreiches Ergebnis. */
export function ok<M>(metrics: M, tools: Record<string, string> = {}, warnings: string[] = []) {
  return { status: "ok" as const, metrics, tools, warnings };
}

export function skipped(reason: string) {
  return { status: "skipped" as const, reason, metrics: null, tools: {}, warnings: [] };
}

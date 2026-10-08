/**
 * Ablauf einer Messung: Snapshot → Installation → Collectors → Ergebnisdateien.
 *
 * Jeder Collector läuft isoliert. Schlägt einer fehl, wird das mit Grund gespeichert und die übrigen
 * laufen weiter. Alle Ergebnisse enthalten Snapshot-Commit, Konfigurations-Hash und Werkzeugversionen,
 * damit jede Zahl nachgerechnet werden kann.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effortCollector, featuresCollector } from "./collectors/features.js";
import { gitCollector } from "./collectors/git.js";
import { githubCollector } from "./collectors/github.js";
import { mutationCollector } from "./collectors/mutation.js";
import { staticCollector } from "./collectors/static.js";
import { testsCollector } from "./collectors/tests.js";
import type { Collector, CollectorContext, CollectorResult } from "./collectors/types.js";
import { type LoadedConfig, getSprint, getTeam } from "./config.js";
import { run } from "./lib/exec.js";
import { resolveScope } from "./lib/files.js";
import { createSnapshot } from "./snapshot.js";
import { TOOL_DIR, TOOL_VERSION } from "./version.js";

export const COLLECTORS: Collector<any>[] = [
  staticCollector,
  testsCollector,
  mutationCollector,
  gitCollector,
  githubCollector,
  featuresCollector,
  effortCollector,
];

export interface MeasureOptions {
  teamId: string;
  sprintId: string;
  only?: string[];
  skip?: string[];
  refresh?: boolean;
  /** Arbeitskopie nach der Messung behalten (zur Fehlersuche) */
  keepWorkdir?: boolean;
  log: (msg: string) => void;
}

export interface Manifest {
  tool: { name: string; version: string };
  planVersion: string;
  configHash: string;
  team: string;
  sprint: string;
  commit: string;
  node: string;
  platform: string;
  startedAt: string;
  finishedAt: string;
  collectors: Record<string, { status: string; reason?: string }>;
}

export function selectCollectors(only?: string[], skip?: string[]): Collector<any>[] {
  const known = new Set(COLLECTORS.map((c) => c.name));
  for (const n of [...(only ?? []), ...(skip ?? [])]) {
    if (!known.has(n)) throw new Error(`Unbekannter Collector "${n}". Verfügbar: ${[...known].join(", ")}`);
  }
  return COLLECTORS.filter((c) => (!only || only.length === 0 || only.includes(c.name)) && !(skip ?? []).includes(c.name));
}

export async function measure(loaded: LoadedConfig, opts: MeasureOptions): Promise<Manifest> {
  const { config, baseDir } = loaded;
  const team = getTeam(config, opts.teamId);
  const sprint = getSprint(config, opts.sprintId);
  const collectors = selectCollectors(opts.only, opts.skip);
  const resultsDir = join(baseDir, "results", opts.teamId, sprint.id);
  const rawDir = join(resultsDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.log(`[${opts.teamId}/${sprint.id}] ${m}`);

  const { info, repoDir } = await createSnapshot({
    baseDir,
    teamId: opts.teamId,
    team,
    sprint,
    resultsDir,
    refresh: opts.refresh ?? false,
    log,
  });

  const scope = resolveScope(repoDir, config.scope);
  writeFileSync(join(rawDir, "scope.json"), JSON.stringify(scope, null, 2));
  log(`Scope: ${scope.app.length} App-Dateien, ${scope.tests.length} Testdateien, ${scope.core.length} Kernlogik-Dateien`);

  let installError: string | null = null;
  if (collectors.some((c) => c.needsInstall)) {
    const [cmd, ...args] = config.installCommand;
    log(`Installiere Abhängigkeiten (${config.installCommand.join(" ")}) …`);
    const res = await run(cmd!, args, { cwd: repoDir, timeoutMs: 15 * 60_000, logFile: join(rawDir, "install.log") });
    if (res.exitCode !== 0) installError = `Installation fehlgeschlagen (Exit ${res.exitCode}), siehe raw/install.log`;
  }

  const ctx: CollectorContext = {
    config,
    configHash: loaded.hash,
    teamId: opts.teamId,
    team,
    sprint,
    repoDir,
    rawDir,
    dataDir: join(baseDir, "data", opts.teamId),
    toolDir: TOOL_DIR,
    scope,
    commit: info.commit,
    log,
  };

  const statuses: Manifest["collectors"] = {};
  for (const c of collectors) {
    const t0 = Date.now();
    log(`Collector ${c.name} …`);
    let result: CollectorResult;
    try {
      if (c.needsInstall && installError) throw new Error(installError);
      const partial = await c.collect(ctx);
      result = { collector: c.name, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, ...partial };
    } catch (e) {
      result = {
        collector: c.name,
        status: "failed",
        reason: (e as Error).message,
        warnings: [],
        startedAt: new Date(t0).toISOString(),
        durationMs: Date.now() - t0,
        tools: {},
        metrics: null,
      };
    }
    const enriched = {
      ...result,
      team: opts.teamId,
      sprint: sprint.id,
      commit: info.commit,
      configHash: loaded.hash,
      planVersion: config.planVersion,
      toolVersion: TOOL_VERSION,
    };
    writeFileSync(join(resultsDir, `${c.name}.json`), JSON.stringify(enriched, null, 2) + "\n");
    statuses[c.name] = { status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
    log(`  → ${result.status}${result.reason ? `: ${result.reason.split("\n")[0]}` : ""} (${Math.round(result.durationMs / 1000)} s)`);
  }

  const manifest: Manifest = {
    tool: { name: "se-eval", version: TOOL_VERSION },
    planVersion: config.planVersion,
    configHash: loaded.hash,
    team: opts.teamId,
    sprint: sprint.id,
    commit: info.commit,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    collectors: statuses,
  };
  writeFileSync(join(resultsDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (!opts.keepWorkdir) rmSync(join(baseDir, "work", opts.teamId, sprint.id), { recursive: true, force: true });
  return manifest;
}

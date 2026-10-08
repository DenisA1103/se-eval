/**
 * Collector "mutation": Wirksamkeit der Tests per Mutation Testing (StrykerJS + Vitest-Runner).
 *
 * - Mutiert wird nur die Kernlogik (scope.core), die am Starttag gemeinsam festgelegt wird.
 * - StrykerJS wird in gepinnter Version nur in die Arbeitskopie installiert.
 * - coverageAnalysis "perTest": Für jeden Mutanten laufen nur die Tests, die ihn abdecken.
 * - Berichtet werden zwei Werte:
 *     Gesamt-Score             = (killed + timeout) / (killed + timeout + survived + noCoverage)
 *     Score auf abgedecktem Code = (killed + timeout) / (killed + timeout + survived)
 *   Für die 2×2-Matrix Coverage/Mutation Score im Evaluationsplan wird der zweite Wert verwendet,
 *   weil der Gesamt-Score ungetestete Mutanten als nicht erkannt zählt und dadurch mit der Coverage
 *   zwangsläufig korreliert.
 *
 * Voraussetzung von StrykerJS: Der Initiallauf der Tests muss grün sein. Ist er rot (oder enthält er
 * instabile Tests, die gerade fehlschlagen), ist der Score nicht messbar; das wird ausgewiesen.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { ratio } from "../lib/stats.js";
import { WRAPPER_CONFIG, writeWrapperConfig } from "./tests.js";
import { type Collector, ok, skipped } from "./types.js";

export interface MutationMetrics {
  mutants: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  errors: number;
  ignored: number;
  scorePercent: number | null;
  scoreCoveredPercent: number | null;
  files: number;
}

export const mutationCollector: Collector<MutationMetrics> = {
  name: "mutation",
  description: "StrykerJS (Vitest-Runner) auf der Kernlogik: Mutation Score gesamt und auf abgedecktem Code",
  needsInstall: true,
  async collect(ctx) {
    const { config, scope, repoDir, rawDir } = ctx;
    if (!config.mutation.enabled) return skipped("In der Konfiguration deaktiviert (mutation.enabled = false)");
    if (scope.core.length === 0) return skipped("Keine Kernlogik-Dateien gefunden (scope.core prüfen)");
    if (!existsSync(join(repoDir, "node_modules", "vitest"))) return skipped("Vitest ist im Repo nicht installiert");

    const v = config.mutation.strykerVersion;
    ctx.log(`Installiere StrykerJS ${v} in die Arbeitskopie …`);
    const install = await run(
      "npm",
      ["install", "--no-save", "--no-audit", "--no-fund", `@stryker-mutator/core@${v}`, `@stryker-mutator/vitest-runner@${v}`],
      { cwd: repoDir, timeoutMs: 10 * 60_000, logFile: join(rawDir, "mutation-install.log") },
    );
    if (install.exitCode !== 0) throw new Error("Installation von StrykerJS fehlgeschlagen, siehe raw/mutation-install.log");

    // Dieselbe neutrale Vitest-Konfiguration wie im Collector "tests"
    writeWrapperConfig(repoDir, config.scope, config.testTypes.e2e);
    const reportFile = join(rawDir, "mutation-report.json");
    const strykerConfig = {
      $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
      testRunner: "vitest",
      vitest: { configFile: WRAPPER_CONFIG },
      plugins: ["@stryker-mutator/vitest-runner"],
      mutate: [...scope.core],
      coverageAnalysis: "perTest",
      reporters: ["json", "clear-text"],
      jsonReporter: { fileName: reportFile },
      thresholds: { high: 80, low: 60, break: null },
      tempDirName: ".stryker-tmp",
      cleanTempDir: true,
      incremental: false,
      ...(config.mutation.concurrency ? { concurrency: config.mutation.concurrency } : {}),
    };
    const configFile = "se-eval.stryker.config.json";
    writeFileSync(join(repoDir, configFile), JSON.stringify(strykerConfig, null, 2));

    const warnings: string[] = [];
    const runStryker = async (attempt: number) => {
      ctx.log(`StrykerJS auf ${scope.core.length} Datei(en), Zeitlimit ${config.mutation.timeoutMinutes} min${attempt > 1 ? " (2. Versuch)" : ""} …`);
      return run(join(repoDir, "node_modules", ".bin", "stryker"), ["run", configFile], {
        cwd: repoDir,
        timeoutMs: config.mutation.timeoutMinutes * 60_000,
        logFile: join(rawDir, "mutation-stryker.log"),
      });
    };
    const dryRunFailed = (out: string) => /failed tests in the initial test run|initial test run failed/i.test(out);
    let res = await runStryker(1);
    // Ein roter Initiallauf kann an instabilen Tests liegen: genau ein weiterer Versuch
    if (!existsSync(reportFile) && dryRunFailed(res.stdout + res.stderr)) {
      warnings.push("Initiallauf beim ersten Versuch rot (instabile Tests?), Messung im zweiten Versuch");
      res = await runStryker(2);
    }
    if (res.timedOut) {
      throw new Error(`StrykerJS überschritt das Zeitlimit von ${config.mutation.timeoutMinutes} min (scope.core verkleinern oder Limit anheben)`);
    }
    if (!existsSync(reportFile)) {
      if (dryRunFailed(res.stdout + res.stderr)) {
        throw new Error("Nicht messbar: Der Initiallauf der Tests ist zweimal fehlgeschlagen (StrykerJS braucht eine grüne Suite)");
      }
      throw new Error(`StrykerJS lieferte keinen Bericht (Exit ${res.exitCode}), siehe raw/mutation-stryker.log`);
    }
    const metrics = summarizeMutationReport(JSON.parse(readFileSync(reportFile, "utf8")) as MutationReport);
    if (metrics.errors > 0) warnings.push(`${metrics.errors} Mutanten mit Compile-/Laufzeitfehler (nicht im Score enthalten)`);
    return ok(metrics, { "@stryker-mutator/core": v, "@stryker-mutator/vitest-runner": v }, warnings);
  },
};

export interface MutationReport {
  files: Record<string, { mutants: { status: string }[] }>;
}

/** Berechnet die Kennzahlen aus einem Bericht im mutation-testing-report-schema. */
export function summarizeMutationReport(report: MutationReport): MutationMetrics {
  const c = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0, CompileError: 0, RuntimeError: 0, Ignored: 0, Pending: 0 } as Record<string, number>;
  let mutants = 0;
  for (const file of Object.values(report.files)) {
    for (const m of file.mutants) {
      mutants++;
      c[m.status] = (c[m.status] ?? 0) + 1;
    }
  }
  const detected = (c.Killed ?? 0) + (c.Timeout ?? 0);
  const survived = c.Survived ?? 0;
  const noCoverage = c.NoCoverage ?? 0;
  return {
    mutants,
    killed: c.Killed ?? 0,
    survived,
    timeout: c.Timeout ?? 0,
    noCoverage,
    errors: (c.CompileError ?? 0) + (c.RuntimeError ?? 0),
    ignored: c.Ignored ?? 0,
    scorePercent: ratio(detected * 100, detected + survived + noCoverage),
    scoreCoveredPercent: ratio(detected * 100, detected + survived),
    files: Object.keys(report.files).length,
  };
}

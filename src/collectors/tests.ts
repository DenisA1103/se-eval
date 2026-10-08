/**
 * Collector "tests": Testumfang, Coverage und Stabilität der Testsuite.
 *
 * Messvertrag: Unit- und Integrationstests laufen mit Vitest, E2E-Tests (z. B. Playwright) liegen in
 * eigenen Ordnern und werden nur gezählt, nicht ausgeführt.
 *
 * Neutralität: Das Tool erzeugt in der Arbeitskopie eine eigene Vitest-Konfiguration, die die
 * Team-Konfiguration lädt (Aliase, Testumgebung, Setup-Dateien bleiben erhalten), aber
 *  - die Testauswahl auf die vereinbarten Muster (scope.tests) setzt,
 *  - die Coverage-Einstellungen vollständig ersetzt (alle App-Dateien, auch ungetestete;
 *    keine Team-Ausschlüsse; keine Schwellen, die den Lauf abbrechen).
 *
 * Die Suite läuft `tests.runs`-mal (Standard 3). Tests, deren Ergebnis zwischen den Läufen wechselt,
 * gelten als instabil (flaky). Fehlgeschlagene Tests werden gezählt und nicht herausgerechnet.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { matcher, slocOfFiles } from "../lib/files.js";
import { ratio, round } from "../lib/stats.js";
import ts from "typescript";
import { type Collector, ok, skipped } from "./types.js";

/** Reihenfolge entspricht der Suchreihenfolge von Vitest */
const VITEST_CONFIG_NAMES = [
  "vitest.config.ts", "vitest.config.mts", "vitest.config.cts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs",
  "vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs",
];
export const WRAPPER_CONFIG = "se-eval.vitest.config.mts";

export interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  success: boolean;
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { fullName: string; status: string; title: string }[];
  }[];
}

export interface TestMetrics {
  testCases: { unit: number; integration: number; e2e: number; total: number };
  testFiles: { vitest: number; e2e: number };
  /** Anteil Testcode an allen Codezeilen (App + Tests), in Prozent */
  testCodeSharePercent: number | null;
  slocTests: number;
  runs: number;
  results: {
    passed: number;
    failed: number;
    skipped: number;
    /** In mindestens einem Lauf fehlgeschlagen */
    failedAnyRun: number;
    /** In allen Läufen fehlgeschlagen */
    failedAllRuns: number;
    flaky: number;
    flakyTests: string[];
    /** Testdateien, die gar nicht geladen werden konnten (z. B. Syntaxfehler) */
    brokenFiles: number;
  };
  coverage: {
    linesPercent: number | null;
    branchesPercent: number | null;
    statementsPercent: number | null;
    functionsPercent: number | null;
    /** App-Dateien ohne eine einzige abgedeckte Zeile */
    uncoveredFiles: number;
  } | null;
}

export const testsCollector: Collector<TestMetrics> = {
  name: "tests",
  description: "Vitest: Testarten, Testcode-Anteil, Coverage (v8, neutral), Stabilität über mehrere Läufe",
  needsInstall: true,
  async collect(ctx) {
    const { repoDir, rawDir, config, scope } = ctx;
    const warnings: string[] = [];
    const isE2e = matcher(config.testTypes.e2e);
    const isIntegration = matcher(config.testTypes.integration);
    const e2eFiles = scope.tests.filter(isE2e);
    const vitestFiles = scope.tests.filter((f) => !isE2e(f));
    const slocTests = slocOfFiles(repoDir, scope.tests);
    const slocApp = slocOfFiles(repoDir, scope.app);
    const e2eCases = countE2eCases(repoDir, e2eFiles);

    const vitestBin = join(repoDir, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");
    if (vitestFiles.length === 0 || !existsSync(vitestBin)) {
      if (vitestFiles.length > 0) return skipped("Vitest ist im Repo nicht installiert (Messvertrag: Vitest als Test-Runner)");
      return ok<TestMetrics>(
        {
          testCases: { unit: 0, integration: 0, e2e: e2eCases, total: e2eCases },
          testFiles: { vitest: 0, e2e: e2eFiles.length },
          testCodeSharePercent: ratio(slocTests * 100, slocApp + slocTests),
          slocTests,
          runs: 0,
          results: { passed: 0, failed: 0, skipped: 0, failedAnyRun: 0, failedAllRuns: 0, flaky: 0, flakyTests: [], brokenFiles: 0 },
          coverage: null,
        },
        {},
        ["Keine Vitest-Tests vorhanden"],
      );
    }
    const vitestVersion = readPkgVersion(join(repoDir, "node_modules", "vitest", "package.json"));
    await ensureCoverageProvider(repoDir, vitestVersion, rawDir, warnings);
    writeWrapperConfig(repoDir, config.scope, config.testTypes.e2e);

    const runs = config.tests.runs;
    const timeoutMs = config.tests.timeoutMinutes * 60_000;
    const outcomes = new Map<string, string[]>();
    let firstRun: VitestJson | null = null;
    for (let i = 1; i <= runs; i++) {
      const out = join(rawDir, `vitest-run${i}.json`);
      const args = ["run", "--config", WRAPPER_CONFIG, "--reporter=json", `--outputFile=${out}`];
      // Coverage nur im ersten Lauf (spart Zeit, Ergebnis ist deterministisch)
      if (i === 1) args.push("--coverage.enabled=true");
      ctx.log(`Vitest-Lauf ${i}/${runs}${i === 1 ? " mit Coverage" : ""} …`);
      const res = await run(vitestBin, args, {
        cwd: repoDir,
        timeoutMs,
        env: { SE_EVAL_COVERAGE_DIR: join(rawDir, "coverage") },
        logFile: join(rawDir, "tests-vitest.log"),
      });
      if (res.timedOut) throw new Error(`Vitest-Lauf ${i} überschritt das Zeitlimit von ${config.tests.timeoutMinutes} min`);
      if (!existsSync(out)) throw new Error(`Vitest-Lauf ${i} lieferte keinen JSON-Bericht (Exit ${res.exitCode}), siehe raw/tests-vitest.log`);
      const json = JSON.parse(readFileSync(out, "utf8")) as VitestJson;
      if (i === 1) firstRun = json;
      for (const [key, status] of testOutcomes(json, repoDir)) {
        const list = outcomes.get(key) ?? [];
        list.push(status);
        outcomes.set(key, list);
      }
    }
    if (!firstRun) throw new Error("Kein Vitest-Lauf ausgewertet");

    // ---------- Testarten (aus dem ersten Lauf) ----------
    let unit = 0;
    let integration = 0;
    let brokenFiles = 0;
    for (const file of firstRun.testResults) {
      const rel = relativeToRepo(file.name, repoDir);
      if (file.assertionResults.length === 0 && file.status === "failed") brokenFiles++;
      const n = file.assertionResults.length;
      if (isIntegration(rel)) integration += n;
      else unit += n;
    }
    if (brokenFiles > 0) warnings.push(`${brokenFiles} Testdatei(en) konnten nicht ausgeführt werden (Lade-/Syntaxfehler)`);

    // ---------- Stabilität ----------
    let failedAny = 0;
    let failedAll = 0;
    const flakyTests: string[] = [];
    let incomplete = 0;
    for (const [key, statuses] of outcomes) {
      const relevant = statuses.filter((s) => s === "passed" || s === "failed");
      const failed = relevant.filter((s) => s === "failed").length;
      if (failed > 0) failedAny++;
      if (failed > 0 && failed === relevant.length && relevant.length === runs) failedAll++;
      if (failed > 0 && failed < relevant.length) flakyTests.push(key);
      if (statuses.length !== runs) incomplete++;
    }
    if (incomplete > 0) warnings.push(`${incomplete} Test(s) liefen nicht in allen ${runs} Läufen (z. B. abgebrochene Testdatei)`);

    // ---------- Coverage ----------
    const coverage = readCoverage(rawDir, scope.app.length, warnings);

    return ok<TestMetrics>(
      {
        testCases: { unit, integration, e2e: e2eCases, total: unit + integration + e2eCases },
        testFiles: { vitest: vitestFiles.length, e2e: e2eFiles.length },
        testCodeSharePercent: ratio(slocTests * 100, slocApp + slocTests),
        slocTests,
        runs,
        results: {
          passed: firstRun.numPassedTests,
          failed: firstRun.numFailedTests,
          skipped: firstRun.numPendingTests + firstRun.numTodoTests,
          failedAnyRun: failedAny,
          failedAllRuns: failedAll,
          flaky: flakyTests.length,
          flakyTests: flakyTests.slice(0, 50),
          brokenFiles,
        },
        coverage,
      },
      { vitest: vitestVersion, "@vitest/coverage-v8": readPkgVersion(join(repoDir, "node_modules", "@vitest", "coverage-v8", "package.json")) },
      warnings,
    );
  },
};

/**
 * Pfad relativ zum Repo. Vitest meldet echte Pfade (realpath); liegt das Arbeitsverzeichnis hinter
 * einem Symlink (unter macOS z. B. /var → /private/var), wird auch dieser Präfix erkannt.
 */
export function relativeToRepo(path: string, repoDir: string): string {
  const prefixes = [repoDir];
  try {
    prefixes.push(realpathSync(repoDir));
  } catch {
    // Verzeichnis existiert nicht (nur in Tests relevant)
  }
  for (const p of prefixes) if (path.startsWith(p + "/")) return path.slice(p.length + 1);
  return path;
}

/**
 * Ergebnis je Testfall eines Laufs. Gleichnamige Tests in derselben Datei werden durchnummeriert,
 * damit sie über die Läufe hinweg nicht vermischt werden (sonst falsche Flaky-Erkennung).
 */
export function testOutcomes(json: VitestJson, repoDir: string): [string, string][] {
  const result: [string, string][] = [];
  for (const file of json.testResults) {
    const seen = new Map<string, number>();
    for (const a of file.assertionResults) {
      const base = `${relativeToRepo(file.name, repoDir)} › ${a.fullName}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      result.push([n === 1 ? base : `${base} #${n}`, a.status]);
    }
  }
  return result;
}

function readPkgVersion(path: string): string {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
  } catch {
    return "unbekannt";
  }
}

/**
 * Installiert @vitest/coverage-v8 in passender Version in die Arbeitskopie, falls das Team es nicht
 * selbst eingebunden hat. Betrifft nur die Wegwerf-Kopie, nicht das Team-Repo.
 */
async function ensureCoverageProvider(repoDir: string, vitestVersion: string, rawDir: string, warnings: string[]) {
  const providerPkg = join(repoDir, "node_modules", "@vitest", "coverage-v8", "package.json");
  if (existsSync(providerPkg)) {
    const v = readPkgVersion(providerPkg);
    if (v !== vitestVersion) warnings.push(`@vitest/coverage-v8 ${v} passt nicht zu vitest ${vitestVersion}`);
    return;
  }
  const res = await run("npm", ["install", "--no-save", "--no-audit", "--no-fund", `@vitest/coverage-v8@${vitestVersion}`], {
    cwd: repoDir,
    timeoutMs: 5 * 60_000,
    logFile: join(rawDir, "tests-install-coverage.log"),
  });
  if (res.exitCode !== 0) throw new Error("Installation von @vitest/coverage-v8 fehlgeschlagen, siehe raw/tests-install-coverage.log");
  warnings.push(`@vitest/coverage-v8@${vitestVersion} wurde für die Messung nachinstalliert`);
}

/**
 * Schreibt die Wrapper-Konfiguration. Sie importiert die Team-Konfiguration (falls vorhanden), damit
 * Aliase, Plugins und Testumgebung erhalten bleiben, und überschreibt Testauswahl und Coverage.
 */
export function writeWrapperConfig(
  repoDir: string,
  scope: { app: string[]; tests: string[]; exclude: string[] },
  e2ePatterns: string[],
): void {
  const teamConfig = VITEST_CONFIG_NAMES.find((n) => existsSync(join(repoDir, n)));
  const importLine = teamConfig ? `import teamConfig from "./${teamConfig}";` : "const teamConfig = {};";
  const neutral = {
    include: scope.tests,
    exclude: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**", ...e2ePatterns, ...scope.exclude],
    coverage: {
      enabled: false, // wird per CLI nur im ersten Lauf aktiviert
      provider: "v8",
      include: scope.app,
      exclude: [...scope.tests, ...scope.exclude],
      reporter: ["json-summary", "json"],
      reportsDirectory: "coverage-se-eval",
      thresholds: {},
      clean: true,
    },
  };
  const text = `// Automatisch erzeugt von se-eval. Nicht ins Team-Repo übernehmen.
${importLine}

const neutral = ${JSON.stringify(neutral, null, 2)};

export default async (env) => {
  // Team-Konfiguration kann ein Objekt, eine Funktion oder ein Promise sein
  let base = typeof teamConfig === "function" ? await teamConfig(env) : await teamConfig;
  base = base ?? {};
  const test = { ...(base.test ?? {}) };
  // Eigene Projekt-/Workspace-Definitionen des Teams würden Testauswahl und Coverage umgehen
  delete test.projects;
  delete test.workspace;
  test.include = neutral.include;
  test.exclude = neutral.exclude;
  test.coverage = { ...neutral.coverage, reportsDirectory: process.env.SE_EVAL_COVERAGE_DIR ?? "coverage-se-eval" };
  test.watch = false;
  test.passWithNoTests = true;
  return { ...base, test };
};
`;
  writeFileSync(join(repoDir, WRAPPER_CONFIG), text);
}

function readCoverage(rawDir: string, appFileCount: number, warnings: string[]): TestMetrics["coverage"] {
  // Vitest schreibt den Bericht über SE_EVAL_COVERAGE_DIR direkt nach raw/coverage
  const summaryFile = join(rawDir, "coverage", "coverage-summary.json");
  if (!existsSync(summaryFile)) {
    warnings.push("Kein Coverage-Bericht erzeugt");
    return null;
  }
  type Entry = { lines: { pct: number; total: number; covered: number }; branches: { pct: number }; statements: { pct: number }; functions: { pct: number } };
  const summary = JSON.parse(readFileSync(summaryFile, "utf8")) as Record<string, Entry>;
  const total = summary.total;
  if (!total) return null;
  const files = Object.entries(summary).filter(([k]) => k !== "total");
  const uncoveredFiles = files.filter(([, e]) => e.lines.total > 0 && e.lines.covered === 0).length;
  if (files.length < appFileCount) {
    warnings.push(`Coverage enthält ${files.length} von ${appFileCount} App-Dateien (nicht instrumentierbare Dateien fehlen)`);
  }
  const pct = (v: number | undefined) => (typeof v === "number" && !Number.isNaN(v) ? round(v, 2) : null);
  return {
    linesPercent: pct(total.lines.pct),
    branchesPercent: pct(total.branches.pct),
    statementsPercent: pct(total.statements.pct),
    functionsPercent: pct(total.functions.pct),
    uncoveredFiles,
  };
}

/** Zählt E2E-Testfälle statisch (Aufrufe von test()/it(), ohne describe). */
export function countE2eCases(repoDir: string, files: string[]): number {
  let n = 0;
  for (const f of files) {
    if (!/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(f)) continue;
    const text = stripComments(readFileSync(join(repoDir, f), "utf8"), f);
    const matches = text.match(/(^|[^\w.$])(test|it)(\.(only|skip|fixme|fail|slow))?\s*\(\s*['"`]/gm);
    n += matches?.length ?? 0;
  }
  return n;
}

/** Entfernt Kommentare (über den TypeScript-Scanner, Strings bleiben unberührt). */
function stripComments(source: string, fileName: string): string {
  const variant = /\.(tsx|jsx)$/.test(fileName) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, source);
  let out = "";
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
    if (t === ts.SyntaxKind.SingleLineCommentTrivia || t === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out += scanner.getTokenText();
  }
  return out;
}

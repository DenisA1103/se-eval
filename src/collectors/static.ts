/**
 * Collector "static": statische Analyse des App-Codes (ohne Tests).
 *
 * - ESLint mit der NEUTRALEN Konfiguration des Tools (configs/eslint.neutral.config.mjs), nicht mit
 *   der Team-Konfiguration. `--no-inline-config` sorgt dafür, dass `eslint-disable`-Kommentare im
 *   Team-Code die neutralen Regeln nicht abschalten; die Kommentare werden separat gezählt.
 * - Kognitive Komplexität je Funktion (eslint-plugin-sonarjs, Campbell 2018).
 * - TypeScript-Compiler im Strict-Modus (Fehler im App-Code).
 * - Umgangene Typprüfung: `any` (per AST gezählt), @ts-ignore, @ts-expect-error, @ts-nocheck, eslint-disable.
 * - Duplikate mit jscpd.
 *
 * Alle Zählwerte werden zusätzlich je 1.000 Codezeilen (KLOC) normiert, damit unterschiedlich
 * große Codebasen vergleichbar sind.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { run } from "../lib/exec.js";
import { slocOfFiles, toPosix } from "../lib/files.js";
import { median, p90, perKloc, roundOrNull } from "../lib/stats.js";
import { TOOL_DIR } from "../version.js";
import { type Collector, ok, skipped } from "./types.js";

const require = createRequire(import.meta.url);

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line: number;
  fatal?: boolean;
}
interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

export interface StaticMetrics {
  sloc: number;
  files: number;
  eslint: {
    findings: number;
    findingsPerKloc: number | null;
    errors: number;
    warnings: number;
    parseErrors: number;
    topRules: { rule: string; count: number }[];
  };
  complexity: {
    /** Funktionen mit kognitiver Komplexität >= 1 (Funktionen ohne Verzweigung werden von sonarjs nicht gemeldet) */
    functionsMeasured: number;
    median: number | null;
    p90: number | null;
    max: number | null;
    aboveThreshold: number;
    aboveThresholdPerKloc: number | null;
    threshold: number;
  };
  typescript: { strictErrors: number; strictErrorsPerKloc: number | null; topCodes: { code: string; count: number }[] };
  suppressions: {
    any: number;
    tsIgnore: number;
    tsExpectError: number;
    tsNocheck: number;
    eslintDisable: number;
    total: number;
    perKloc: number | null;
  };
  duplication: { clones: number; duplicatedLines: number; percentLines: number | null; minTokens: number };
}

export const staticCollector: Collector<StaticMetrics> = {
  name: "static",
  description: "ESLint (neutrale Konfig), kognitive Komplexität, tsc --strict, Typ-Umgehungen, Duplikate",
  needsInstall: true,
  async collect(ctx) {
    const { repoDir, scope, rawDir, toolDir, config } = ctx;
    if (scope.app.length === 0) return skipped("Keine Dateien im App-Scope gefunden (scope.app prüfen)");
    const tsFiles = scope.app.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
    const warnings: string[] = [];
    if (tsFiles.length < scope.app.length) {
      warnings.push(`${scope.app.length - tsFiles.length} Nicht-TypeScript-Dateien im App-Scope werden von ESLint/tsc nicht geprüft`);
    }
    const sloc = slocOfFiles(repoDir, scope.app);

    // ---------- ESLint ----------
    const eslintBin = join(pkgDir("eslint"), "bin", "eslint.js");
    const eslintConfig = join(toolDir, "configs", "eslint.neutral.config.mjs");
    const fileListArgs = tsFiles; // explizite Dateiliste statt Globs: exakt der vereinbarte Scope
    const eslintRes = await run(
      process.execPath,
      [eslintBin, "-c", eslintConfig, "--no-inline-config", "--no-warn-ignored", "-f", "json", ...fileListArgs],
      {
        cwd: repoDir,
        env: { SE_EVAL_REPO_DIR: repoDir },
        timeoutMs: 15 * 60_000,
        logFile: join(rawDir, "static-eslint.log"),
      },
    );
    let eslintResults: EslintFileResult[];
    try {
      eslintResults = JSON.parse(eslintRes.stdout) as EslintFileResult[];
    } catch {
      throw new Error(`ESLint lieferte kein JSON (Exit ${eslintRes.exitCode}). Details: raw/static-eslint.log`);
    }
    writeFileSync(join(rawDir, "eslint.json"), JSON.stringify(eslintResults, null, 1));

    const complexities: number[] = [];
    const ruleCounts = new Map<string, number>();
    let errors = 0;
    let warningsCount = 0;
    let parseErrors = 0;
    for (const file of eslintResults) {
      for (const m of file.messages) {
        if (m.ruleId === "sonarjs/cognitive-complexity") {
          const match = /from (\d+) to/.exec(m.message);
          if (match) complexities.push(Number(match[1]));
          continue; // Komplexität ist eine Metrik, kein Befund
        }
        if (m.fatal || m.ruleId === null) {
          parseErrors++;
          continue;
        }
        ruleCounts.set(m.ruleId, (ruleCounts.get(m.ruleId) ?? 0) + 1);
        if (m.severity === 2) errors++;
        else warningsCount++;
      }
    }
    if (parseErrors > 0) warnings.push(`${parseErrors} Datei(en) konnten von ESLint nicht geparst werden (siehe raw/eslint.json)`);
    const findings = errors + warningsCount;
    const threshold = config.static.complexityThreshold;
    const above = complexities.filter((c) => c > threshold).length;

    // ---------- TypeScript strict ----------
    // Next.js ab 15.5 erzeugt globale Typen (z. B. LayoutProps, PageProps) unter .next/types.
    // In einer frischen Arbeitskopie fehlen sie und würden falsche Typfehler erzeugen.
    const nextBin = join(repoDir, "node_modules", ".bin", "next");
    if (existsSync(nextBin)) {
      const gen = await run(nextBin, ["typegen"], { cwd: repoDir, timeoutMs: 5 * 60_000, logFile: join(rawDir, "static-next-typegen.log") });
      if (gen.exitCode !== 0) warnings.push("`next typegen` fehlgeschlagen: Typfehler zu Next-Routen-Typen können fälschlich gezählt werden");
    }
    const tsc = await typecheckStrict(repoDir, tsFiles, join(rawDir, "static-tsc.log"));
    warnings.push(...tsc.warnings);

    // ---------- Typ-Umgehungen ----------
    const suppressions = countSuppressions(repoDir, tsFiles);

    // ---------- Duplikate ----------
    const duplication = await detectDuplicates(ctx, tsFiles);
    warnings.push(...duplication.warnings);

    const tools: Record<string, string> = {
      eslint: pkgVersion("eslint"),
      "typescript-eslint": pkgVersion("typescript-eslint"),
      "eslint-plugin-sonarjs": pkgVersion("eslint-plugin-sonarjs"),
      typescript: ts.version,
      jscpd: pkgVersion("jscpd"),
    };

    return ok<StaticMetrics>(
      {
        sloc,
        files: scope.app.length,
        eslint: {
          findings,
          findingsPerKloc: perKloc(findings, sloc),
          errors,
          warnings: warningsCount,
          parseErrors,
          topRules: [...ruleCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([rule, count]) => ({ rule, count })),
        },
        complexity: {
          functionsMeasured: complexities.length,
          median: roundOrNull(median(complexities)),
          p90: roundOrNull(p90(complexities)),
          max: complexities.length ? Math.max(...complexities) : null,
          aboveThreshold: above,
          aboveThresholdPerKloc: perKloc(above, sloc),
          threshold,
        },
        typescript: {
          strictErrors: tsc.errors,
          strictErrorsPerKloc: perKloc(tsc.errors, sloc),
          topCodes: tsc.topCodes,
        },
        suppressions: { ...suppressions, perKloc: perKloc(suppressions.total, sloc) },
        duplication: duplication.metrics,
      },
      tools,
      warnings,
    );
  },
};

/**
 * Installationsverzeichnis eines Pakets aus den node_modules des Tools. Über den Einstiegspunkt
 * aufgelöst, weil viele Pakete per "exports" den direkten Zugriff auf package.json verbieten.
 */
function pkgDir(name: string): string {
  // 1) package.json direkt (klappt, wenn "exports" es erlaubt oder fehlt)
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // weiter mit 2)
  }
  // 2) über den Einstiegspunkt nach oben bis zur passenden package.json
  try {
    let dir = dirname(require.resolve(name));
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate) && (JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name === name) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // weiter mit 3)
  }
  // 3) Pakete ohne Einstiegspunkt (z. B. reine CLI-Pakete) direkt im node_modules des Tools
  const direct = join(TOOL_DIR, "node_modules", name);
  if (existsSync(join(direct, "package.json"))) return direct;
  throw new Error(`Paket ${name} nicht gefunden (npm ci im Tool-Verzeichnis ausgeführt?)`);
}

function pkgVersion(name: string): string {
  try {
    return (JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unbekannt";
  }
}

/**
 * Typprüfung über die Compiler-API mit der tsconfig des Teams, aber erzwungenem `strict: true`.
 * Gezählt werden nur Fehler in Dateien des App-Scopes (Fehler in Tests oder Konfigurationsdateien
 * sind nicht Gegenstand der statischen Analyse).
 */
async function typecheckStrict(
  repoDir: string,
  appFiles: string[],
  logFile: string,
): Promise<{ errors: number; topCodes: { code: string; count: number }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const configPath = ts.findConfigFile(repoDir, ts.sys.fileExists, "tsconfig.json");
  let options: ts.CompilerOptions = {};
  let configFiles: string[] = [];
  if (configPath && toPosix(relative(repoDir, configPath)).startsWith("..") === false) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoDir);
    options = parsed.options;
    // Dateien der Team-tsconfig mitnehmen (z. B. next-env.d.ts für CSS-Module und Next-Typen)
    configFiles = parsed.fileNames;
  } else {
    warnings.push("Keine tsconfig.json im Repo gefunden; tsc läuft mit Standardoptionen + strict");
  }
  // Neutral erzwungene Optionen
  options = { ...options, strict: true, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined };
  const appPaths = appFiles.map((f) => join(repoDir, f));
  const rootNames = [...new Set([...configFiles, ...appPaths])];
  const program = ts.createProgram({ rootNames, options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const appSet = new Set(appPaths.map((p) => toPosix(p)));
  const codeCounts = new Map<string, number>();
  let errors = 0;
  const lines: string[] = [];
  for (const d of diagnostics) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const file = d.file ? toPosix(d.file.fileName) : null;
    const text = ts.flattenDiagnosticMessageText(d.messageText, " ");
    const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
    lines.push(`${file ? toPosix(relative(repoDir, file)) : "(global)"}${where ? `:${where.line + 1}` : ""} TS${d.code}: ${text}`);
    if (!file || !appSet.has(file)) continue;
    errors++;
    const code = `TS${d.code}`;
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }
  writeFileSync(logFile, lines.join("\n") + "\n");
  // Fehler wie "Cannot find module" deuten auf eine unvollständige Installation hin
  const missing = [...codeCounts.entries()].find(([c]) => c === "TS2307");
  if (missing) warnings.push(`${missing[1]}× TS2307 (Modul nicht gefunden): Installation/Pfad-Aliase prüfen, Wert ggf. verzerrt`);
  return {
    errors,
    topCodes: [...codeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code, count]) => ({ code, count })),
    warnings,
  };
}

/** Zählt `any`-Typannotationen per AST sowie Unterdrückungskommentare per Textsuche. */
export function countSuppressions(repoDir: string, files: string[]) {
  let any = 0;
  let tsIgnore = 0;
  let tsExpectError = 0;
  let tsNocheck = 0;
  let eslintDisable = 0;
  for (const f of files) {
    const text = readFileSync(join(repoDir, f), "utf8");
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, false, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) any++;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    // Kommentare: nur echte Kommentare zählen, nicht Vorkommen in Strings
    const comments = extractComments(text, f);
    for (const c of comments) {
      if (/@ts-ignore\b/.test(c)) tsIgnore++;
      if (/@ts-expect-error\b/.test(c)) tsExpectError++;
      if (/@ts-nocheck\b/.test(c)) tsNocheck++;
      if (/\beslint-disable(-next-line|-line)?\b/.test(c)) eslintDisable++;
    }
  }
  return { any, tsIgnore, tsExpectError, tsNocheck, eslintDisable, total: any + tsIgnore + tsExpectError + tsNocheck + eslintDisable };
}

/** Liefert alle Kommentare einer Datei (über den Scanner, damit Strings nicht fälschlich zählen). */
function extractComments(source: string, fileName: string): string[] {
  const variant = /\.(tsx|jsx)$/.test(fileName) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, source);
  const result: string[] = [];
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
    if (t === ts.SyntaxKind.SingleLineCommentTrivia || t === ts.SyntaxKind.MultiLineCommentTrivia) {
      result.push(scanner.getTokenText());
    }
  }
  return result;
}

/** Duplikaterkennung mit jscpd, nur über die Dateien des App-Scopes. */
async function detectDuplicates(
  ctx: Parameters<Collector["collect"]>[0],
  files: string[],
): Promise<{ metrics: StaticMetrics["duplication"]; warnings: string[] }> {
  const minTokens = ctx.config.static.duplicateMinTokens;
  const outDir = join(ctx.rawDir, "jscpd");
  const bin = join(pkgDir("jscpd"), "run-jscpd.js");
  // jscpd interpretiert Pfadargumente als Glob-Muster; Next.js-Routen wie app/[slug]/page.tsx würden
  // dadurch nicht gefunden. Deshalb werden die Scope-Dateien in ein Eingabeverzeichnis kopiert, in dem
  // Glob-Sonderzeichen ersetzt sind. Inhalt und Zeilen bleiben identisch.
  const inputDir = join(ctx.repoDir, "..", "jscpd-input"); // liegt in work/, wird mit der Arbeitskopie gelöscht
  rmSync(inputDir, { recursive: true, force: true });
  for (const f of files) {
    const target = join(inputDir, f.replace(/[[\]{}()*?!]/g, "_"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ctx.repoDir, f), target);
  }
  const res = await run(
    process.execPath,
    [bin, "-k", String(minTokens), "-f", "typescript,tsx", "--reporters", "json", "--output", outDir, "--no-colors", "--no-gitignore", inputDir],
    { cwd: ctx.repoDir, timeoutMs: 10 * 60_000, logFile: join(ctx.rawDir, "static-jscpd.log") },
  );
  const reportFile = join(outDir, "jscpd-report.json");
  if (!existsSync(reportFile)) {
    return {
      metrics: { clones: 0, duplicatedLines: 0, percentLines: null, minTokens },
      warnings: [`jscpd lieferte keinen Bericht (Exit ${res.exitCode}); Duplikate nicht gemessen`],
    };
  }
  const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
    statistics: { total: { clones: number; duplicatedLines: number; lines: number; percentage: number } };
  };
  const t = report.statistics.total;
  // Nenner selbst bestimmen: jscpd lässt Dateien unterhalb der Mindestgröße aus seiner Zeilensumme weg,
  // dadurch würden kleine Dateien den Anteil verfälschen. Gezählt werden physische Zeilen aller Scope-Dateien.
  const physicalLines = files.reduce((sum, f) => sum + readFileSync(join(ctx.repoDir, f), "utf8").split("\n").length, 0);
  return {
    metrics: {
      clones: t.clones,
      duplicatedLines: t.duplicatedLines,
      percentLines: physicalLines > 0 ? roundOrNull((t.duplicatedLines * 100) / physicalLines) : null,
      minTokens,
    },
    warnings: [],
  };
}

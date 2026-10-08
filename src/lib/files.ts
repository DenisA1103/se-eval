/**
 * Dateiauswahl über Glob-Muster und Zählung von Codezeilen.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";
import ts from "typescript";

/** Verzeichnisse, die nie durchsucht werden. */
const ALWAYS_SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".stryker-tmp", "reports"]);

/** Listet alle Dateien unter `root` relativ zu `root`, mit "/" als Trenner. */
export function listFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ALWAYS_SKIP.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        result.push(toPosix(relative(root, join(dir, entry.name))));
      }
    }
  };
  walk(root);
  return result.sort();
}

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** Erstellt eine Prüffunktion: Datei passt auf eines der `include`-Muster und auf keines der `exclude`-Muster. */
export function matcher(include: readonly string[], exclude: readonly string[] = []): (path: string) => boolean {
  const inc = include.length > 0 ? picomatch(include as string[], { dot: true }) : () => false;
  const exc = exclude.length > 0 ? picomatch(exclude as string[], { dot: true }) : () => false;
  return (p) => inc(p) && !exc(p);
}

export interface Scope {
  app: string[];
  tests: string[];
  core: string[];
}

/**
 * Teilt die Dateien eines Repos nach Messvertrag in App-Code, Testcode und Kernlogik auf.
 * App-Code und Kernlogik enthalten niemals Testdateien.
 */
export function resolveScope(
  root: string,
  scope: { app: string[]; tests: string[]; core: string[]; exclude: string[] },
): Scope {
  const files = listFiles(root);
  const isTest = matcher(scope.tests, scope.exclude);
  const isApp = matcher(scope.app, [...scope.exclude, ...scope.tests]);
  const isCore = matcher(scope.core, [...scope.exclude, ...scope.tests]);
  return {
    app: files.filter(isApp),
    tests: files.filter(isTest),
    core: files.filter(isCore),
  };
}

/**
 * Zählt Codezeilen ohne Leer- und Kommentarzeilen (Source Lines of Code).
 * Nutzt den TypeScript-Scanner, damit Kommentare in Strings oder Template-Literalen korrekt behandelt werden.
 * Funktioniert für .ts, .tsx, .js, .jsx, .mjs, .cjs.
 *
 * Bekannte Grenze: Der Scanner läuft ohne Parser-Kontext. In seltenen Fällen (Regex-Literale mit "//",
 * Leerzeilen innerhalb von Template-Literalen) weicht die Zählung um einzelne Zeilen ab. Da beide Repos
 * mit demselben Verfahren gezählt werden, beeinflusst das die Vergleichbarkeit nicht.
 */
export function countSloc(source: string, fileName = "file.tsx"): number {
  const variant = /\.(tsx|jsx)$/.test(fileName) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, variant, source);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    // Binäre Suche: Index der letzten Zeile, deren Start <= pos ist
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lines = new Set<number>();
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const start = scanner.getTokenStart();
    const end = scanner.getTokenEnd();
    const first = lineOf(start);
    const last = lineOf(Math.max(start, end - 1));
    for (let l = first; l <= last; l++) lines.add(l);
  }
  return lines.size;
}

/** Summe der Codezeilen über mehrere Dateien eines Repos. */
export function slocOfFiles(root: string, files: readonly string[]): number {
  let total = 0;
  for (const f of files) {
    const abs = join(root, f);
    if (statSync(abs).size > 2_000_000) continue; // sehr große Dateien sind fast immer generiert
    total += countSloc(readFileSync(abs, "utf8"), f);
  }
  return total;
}

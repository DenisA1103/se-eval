/**
 * Tests der Berechnungen. Jede Kennzahl im Bericht muss nachrechenbar sein; diese Tests sichern die
 * Formeln gegen Handrechnungen ab.
 */
import { describe, expect, it } from "vitest";
import { countSloc, matcher } from "../src/lib/files.js";
import { median, p90, perKloc, quantile, ratio } from "../src/lib/stats.js";
import { dayInSprint, localDay, localMidnight, sprintWindow, tzOffsetMinutes } from "../src/lib/time.js";
import { parseDay, parseNumber } from "../src/lib/csv.js";
import { susScore } from "../src/ux.js";
import { mutationPlausibilityWarnings, summarizeMutationReport } from "../src/collectors/mutation.js";
import { mergeCollectorStatuses } from "../src/measure.js";
import { branchNameFromMerge, normalizeRenamePath, parseLog, parseNumstat } from "../src/collectors/git.js";
import { countE2eCases } from "../src/collectors/tests.js";

describe("Statistik", () => {
  it("Median und P90 nach R-7", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    // P90 von 1..10: Position 0,9 * 9 = 8,1 → 9 + 0,1 * (10 - 9) = 9,1
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(9.1);
    expect(median([])).toBeNull();
    expect(quantile([5], 0.9)).toBe(5);
  });
  it("Quotienten ohne Division durch 0", () => {
    expect(ratio(1, 3)).toBe(0.33);
    expect(ratio(1, 0)).toBeNull();
    expect(perKloc(5, 2000)).toBe(2.5);
    expect(perKloc(5, 0)).toBeNull();
  });
});

describe("Codezeilen", () => {
  it("zählt keine Leer- und Kommentarzeilen", () => {
    const src = `// Kommentar
/* Block
   Kommentar */
const a = 1; // dahinter

function f() {
  return "// kein Kommentar";
}
`;
    expect(countSloc(src, "x.ts")).toBe(4);
  });
  it("zählt mehrzeilige Strings vollständig", () => {
    expect(countSloc("const s = `a\nb\nc`;\n", "x.ts")).toBe(3);
  });
});

describe("Glob-Auswahl", () => {
  it("schließt Tests aus dem App-Scope aus", () => {
    const isApp = matcher(["src/**/*.{ts,tsx}"], ["**/*.test.{ts,tsx}"]);
    expect(isApp("src/lib/a.ts")).toBe(true);
    expect(isApp("src/lib/a.test.ts")).toBe(false);
    expect(isApp("app/page.tsx")).toBe(false);
  });
  it("behandelt Next.js-Routen mit eckigen Klammern als Dateinamen", () => {
    const isApp = matcher(["app/**/*.tsx"]);
    expect(isApp("app/[slug]/page.tsx")).toBe(true);
  });
});

describe("Zeitfenster", () => {
  it("bestimmt Mitternacht in Berlin mit Sommer- und Winterzeit", () => {
    expect(new Date(localMidnight("2026-10-16")).toISOString()).toBe("2026-10-15T22:00:00.000Z");
    expect(new Date(localMidnight("2026-11-20")).toISOString()).toBe("2026-11-19T23:00:00.000Z");
    expect(tzOffsetMinutes(new Date("2026-07-01T12:00:00Z"))).toBe(120);
  });
  it("ordnet Zeitpunkte dem Berliner Kalendertag zu", () => {
    expect(localDay(Date.parse("2026-10-16T22:30:00Z"))).toBe("2026-10-17");
  });
  it("Sprintfenster vom Start bis zum Stichtag", () => {
    const s = { id: "s", phase: "P1", start: "2026-10-16", stichtag: "2026-10-23T12:00:00+02:00" };
    const w = sprintWindow(s, [s]);
    expect(w.to - w.from).toBe(7.5 * 24 * 3600_000);
  });

  // Aufeinanderfolgende Sprints: Stichtag Fr 12:00, nächster Sprint startet am selben Freitag
  const s1 = { id: "s1", phase: "P1", start: "2026-10-23", stichtag: "2026-10-30T12:00:00+01:00" };
  const s2 = { id: "s2", phase: "P1", start: "2026-10-30", stichtag: "2026-11-06T12:00:00+01:00" };
  const s3 = { id: "s3", phase: "P1", start: "2026-11-06", stichtag: "2026-11-13T12:00:00+01:00" };
  const all = [s1, s2, s3];

  it("Sprintfenster überlappen sich nicht: Freitagvormittag gehört zum endenden Sprint", () => {
    const w1 = sprintWindow(s1, all);
    const w2 = sprintWindow(s2, all);
    const fridayMorning = Date.parse("2026-10-30T10:00:00+01:00");
    const fridayAfternoon = Date.parse("2026-10-30T15:00:00+01:00");
    const atDeadline = Date.parse(s1.stichtag);
    expect(fridayMorning >= w1.from && fridayMorning <= w1.to).toBe(true);
    expect(fridayMorning >= w2.from && fridayMorning <= w2.to).toBe(false);
    expect(fridayAfternoon >= w2.from && fridayAfternoon <= w2.to).toBe(true);
    // Genau 12:00 zählt nur zum endenden Sprint
    expect(atDeadline <= w1.to && atDeadline >= w2.from).toBe(false);
    expect(w2.from).toBe(w1.to + 1);
  });

  it("ordnet jeden Tag der Zeiterfassung höchstens einem Sprint zu", () => {
    const days = ["2026-10-22", "2026-10-23", "2026-10-29", "2026-10-30", "2026-11-06", "2026-11-13", "2026-11-14"];
    const owner = days.map((d) => all.filter((s) => dayInSprint(d, s, all)).map((s) => s.id));
    expect(owner).toEqual([[], ["s1"], ["s1"], ["s2"], ["s3"], ["s3"], []]);
  });
});

describe("CSV-Werte", () => {
  it("akzeptiert Dezimalkomma und deutsches Datum", () => {
    expect(parseNumber("0,5")).toBe(0.5);
    expect(parseNumber("1.75")).toBe(1.75);
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("")).toBeNull();
    expect(parseDay("17.10.2026")).toBe("2026-10-17");
    expect(parseDay("2026-10-17")).toBe("2026-10-17");
    expect(parseDay("2026-02-30")).toBeNull();
  });
});

describe("SUS", () => {
  it("berechnet den Score nach Brooke (1996)", () => {
    expect(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, 1])).toBe(100);
    expect(susScore([1, 5, 1, 5, 1, 5, 1, 5, 1, 5])).toBe(0);
    expect(susScore([3, 3, 3, 3, 3, 3, 3, 3, 3, 3])).toBe(50);
    expect(() => susScore([1, 2, 3])).toThrow();
  });
});

describe("Mutation Score", () => {
  it("unterscheidet Gesamt-Score und Score auf abgedecktem Code", () => {
    const m = summarizeMutationReport({
      files: {
        "a.ts": { mutants: [{ status: "Killed" }, { status: "Killed" }, { status: "Survived" }, { status: "NoCoverage" }] },
        "b.ts": { mutants: [{ status: "Timeout" }, { status: "CompileError" }, { status: "Ignored" }] },
      },
    });
    // erkannt = 2 Killed + 1 Timeout = 3; gesamt: 3 / (3 + 1 + 1) = 60 %; abgedeckt: 3 / (3 + 1) = 75 %
    expect(m.scorePercent).toBe(60);
    expect(m.scoreCoveredPercent).toBe(75);
    expect(m.errors).toBe(1);
    expect(m.ignored).toBe(1);
  });

  it("warnt bei auffällig niedrigem Score auf abgedecktem Code (Messproblem), sonst nicht", () => {
    const mutants = (killed: number, survived: number) => ({
      files: { "a.ts": { mutants: [...Array(killed).fill({ status: "Killed" }), ...Array(survived).fill({ status: "Survived" })] } },
    });
    // Muster der Probemessung 29.10.: 51 von 2.067 abgedeckten Mutanten erkannt (2,47 %)
    expect(mutationPlausibilityWarnings(summarizeMutationReport(mutants(51, 2016)))).toHaveLength(1);
    expect(mutationPlausibilityWarnings(summarizeMutationReport(mutants(0, 112)))).toHaveLength(1);
    // realistische Werte und zu kleine Stichproben: keine Warnung
    expect(mutationPlausibilityWarnings(summarizeMutationReport(mutants(93, 19)))).toEqual([]);
    expect(mutationPlausibilityWarnings(summarizeMutationReport(mutants(0, 10)))).toEqual([]);
  });
});

describe("Git-Auswertung", () => {
  it("liest Commits mit Co-Autoren", () => {
    const out =
      "\x1eabc\x1fAnna\x1fAnna@X.org\x1f2026-10-17T11:00:00+02:00\x1f2026-10-17T11:00:00+02:00\x1fp1\x1ffeat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n" +
      "\x1edef\x1fBen\x1fben@x.org\x1f2026-10-18T09:00:00+02:00\x1f2026-10-18T09:00:00+02:00\x1fp1 p2\x1fMerge branch 'feature/F-01'\n";
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]!.email).toBe("anna@x.org");
    expect(commits[0]!.coAuthors).toEqual(["Claude <noreply@anthropic.com>"]);
    expect(commits[1]!.parents).toEqual(["p1", "p2"]);
  });
  it("liest numstat inklusive Binärdateien und Umbenennungen", () => {
    const m = parseNumstat("\x1eabc\n\n3\t1\tsrc/a.ts\n-\t-\tpublic/logo.png\n2\t0\tsrc/{old => new}/b.ts\n");
    expect(m.get("abc")).toEqual([
      { path: "src/a.ts", added: 3, deleted: 1 },
      { path: "public/logo.png", added: 0, deleted: 0 },
      { path: "src/new/b.ts", added: 2, deleted: 0 },
    ]);
    expect(normalizeRenamePath("a.ts => b.ts")).toBe("b.ts");
  });
  it("erkennt Branch-Namen in Merge-Nachrichten", () => {
    expect(branchNameFromMerge("Merge pull request #12 from team/feature/F-03-login")).toBe("feature/F-03-login");
    expect(branchNameFromMerge("Merge branch 'feature/F-01-cart'")).toBe("feature/F-01-cart");
    expect(branchNameFromMerge("Merge remote-tracking branch 'origin/fix'")).toBe("fix");
    expect(branchNameFromMerge("feat: nichts")).toBeNull();
  });
});

describe("E2E-Zählung", () => {
  it("zählt test()-Aufrufe, aber nicht describe oder test.describe", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "se-eval-"));
    writeFileSync(
      join(dir, "a.spec.ts"),
      `test.describe("x", () => {\n  test("eins", async () => {});\n  test.skip("zwei", async () => {});\n  it('drei', () => {});\n});\n// test("auskommentiert") zählt nicht\nconst latest = 1;\n`,
    );
    expect(countE2eCases(dir, ["a.spec.ts"])).toBe(3);
  });
});

describe("Manifest bei Teilmessungen", () => {
  const vorher = { commit: "abc", collectors: { static: { status: "ok" }, tests: { status: "ok" }, mutation: { status: "skipped" } } };

  it("behält die übrigen Collector bei gleichem Snapshot-Commit und ersetzt den neu gemessenen", () => {
    const merged = mergeCollectorStatuses(vorher, "abc", { mutation: { status: "ok" } });
    expect(merged).toEqual({ static: { status: "ok" }, tests: { status: "ok" }, mutation: { status: "ok" } });
    expect(Object.keys(merged)).toEqual(["static", "tests", "mutation"]);
  });

  it("verwirft alte Einträge bei anderem Commit oder ohne vorherige Messung", () => {
    expect(mergeCollectorStatuses(vorher, "def", { mutation: { status: "ok" } })).toEqual({ mutation: { status: "ok" } });
    expect(mergeCollectorStatuses(null, "abc", { git: { status: "ok" } })).toEqual({ git: { status: "ok" } });
  });
});

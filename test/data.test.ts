/**
 * Tests für Konfiguration, CSV-Validierung, Feature-Status und den GitHub-Collector (mit simulierter API).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EvalConfig, loadConfig, sprintsUpTo } from "../src/config.js";
import { computeFeatureMetrics, loadAcceptance, loadFeatures, loadTimeEntries } from "../src/collectors/features.js";
import { githubCollector } from "../src/collectors/github.js";
import type { CollectorContext } from "../src/collectors/types.js";
import { evaluateUx } from "../src/ux.js";

const tmp = () => mkdtempSync(join(tmpdir(), "se-eval-test-"));

function baseConfig(): Record<string, unknown> {
  return {
    planVersion: "1.0",
    teams: { a: { name: "A", repo: "../a", github: "org/a", uxLabel: { P1: "A" } }, b: { name: "B", repo: "../b", uxLabel: { P1: "B" } } },
    sprints: [
      { id: "s1", phase: "P1", start: "2026-10-16", stichtag: "2026-10-23T12:00:00+02:00" },
      { id: "s2", phase: "P1", start: "2026-10-23", stichtag: "2026-10-30T12:00:00+01:00" },
      { id: "x1", phase: "P2", start: "2026-11-20", stichtag: "2026-11-27T12:00:00+01:00" },
    ],
    scope: { app: ["src/**/*.ts"], tests: ["**/*.test.ts"] },
  };
}

function writeConfig(dir: string, cfg: Record<string, unknown>): string {
  const p = join(dir, "eval.config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

describe("Konfiguration", () => {
  it("setzt Standardwerte und berechnet einen Hash", () => {
    const loaded = loadConfig(writeConfig(tmp(), baseConfig()));
    expect(loaded.config.tests.runs).toBe(3);
    expect(loaded.config.static.complexityThreshold).toBe(15);
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("lehnt einen Stichtag ohne Zeitzone ab", () => {
    const cfg = baseConfig();
    (cfg.sprints as { stichtag: string }[])[0]!.stichtag = "2026-10-23T12:00:00";
    expect(() => loadConfig(writeConfig(tmp(), cfg))).toThrow(/Zeitzone/);
  });
  it("lehnt doppelte Sprint-IDs ab", () => {
    const cfg = baseConfig();
    (cfg.sprints as { id: string }[])[1]!.id = "s1";
    expect(() => loadConfig(writeConfig(tmp(), cfg))).toThrow(/doppelt/);
  });
  it("liefert die Sprints einer Phase bis zum gewählten Sprint", () => {
    const { config } = loadConfig(writeConfig(tmp(), baseConfig()));
    expect(sprintsUpTo(config, "s2").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(sprintsUpTo(config, "x1").map((s) => s.id)).toEqual(["x1"]);
  });
});

describe("Features und Abnahme", () => {
  const setup = () => {
    const dir = tmp();
    const { config } = loadConfig(writeConfig(dir, baseConfig()));
    writeFileSync(join(dir, "features.csv"), "id;titel;groesse\nF-01;Login;M\nF-02;Suche;L\nF-03;Profil;S\n");
    writeFileSync(
      join(dir, "abnahme.csv"),
      "sprint;feature_id;checks_bestanden;checks_gesamt;notiz\ns1;F-01;3;3;\ns1;F-02;1;4;\ns2;F-02;4;4;\ns2;F-03;0;2;\n",
    );
    return { dir, config };
  };
  it("berechnet Status, Durchsatz und Burn-up", () => {
    const { dir, config } = setup();
    const features = loadFeatures(dir);
    const acc = loadAcceptance(join(dir, "abnahme.csv"), features, config);
    const s1 = computeFeatureMetrics(features, acc, config, "s1");
    expect(s1.completedPoints).toBe(2); // F-01 fertig (M = 2)
    expect(s1.weightedPoints).toBe(3.5); // + F-02 teilweise (L = 3 × 0,5)
    const s2 = computeFeatureMetrics(features, acc, config, "s2");
    expect(s2.completedPoints).toBe(5); // F-01 + F-02
    expect(s2.throughputPoints).toBe(3); // im Sprint s2 neu fertig: F-02
    expect(s2.completionPercent).toBe(83.3);
    expect(s2.burnUp.map((b) => b.completedPoints)).toEqual([2, 5]);
  });
  it("meldet ungültige Abnahmezeilen mit Zeilennummer", () => {
    const { dir, config } = setup();
    writeFileSync(join(dir, "abnahme.csv"), "sprint;feature_id;checks_bestanden;checks_gesamt\ns1;F-09;5;3\n");
    expect(() => loadAcceptance(join(dir, "abnahme.csv"), loadFeatures(dir), config)).toThrow(/Zeile 2.*unbekanntes Feature/s);
  });
  it("lehnt ungültige Größen ab", () => {
    const dir = tmp();
    writeFileSync(join(dir, "features.csv"), "id,titel,groesse\nF-01,Login,XL\n");
    expect(() => loadFeatures(dir)).toThrow(/groesse/);
  });
});

describe("Zeiterfassung", () => {
  it("akzeptiert Excel-Format und prüft das 15-Minuten-Raster", () => {
    const dir = tmp();
    const f = join(dir, "z.csv");
    writeFileSync(f, "﻿Datum;Person;Stunden;Feature;Taetigkeit\n17.10.2026;Anna;1,25;F-01;Code\n");
    expect(loadTimeEntries(f)).toEqual([{ day: "2026-10-17", person: "Anna", hours: 1.25, feature: "F-01", activity: "Code" }]);
    writeFileSync(f, "datum;person;stunden;feature;taetigkeit\n2026-10-17;Anna;1,1;F-01;Code\n");
    expect(() => loadTimeEntries(f)).toThrow(/15-Minuten-Raster/);
  });
});

describe("UX-Auswertung", () => {
  it("rechnet Task Success, Time-on-Task und SUS je App und Gruppe", () => {
    const dir = tmp();
    const { config } = loadConfig(writeConfig(dir, baseConfig()));
    mkdirSync(join(dir, "ux", "P1"), { recursive: true });
    writeFileSync(
      join(dir, "ux", "P1", "ergebnisse.csv"),
      "proband;gruppe;app;reihenfolge;aufgabe;erfolg;zeit_s;fehler\n" +
        "P01;extern;A;1;T1;1;60;0\nP01;extern;A;1;T2;0;400;2\nP01;extern;B;2;T1;0,5;100;1\nP01;extern;B;2;T2;1;80;0\n",
    );
    writeFileSync(join(dir, "ux", "P1", "sus.csv"), "proband;gruppe;app;f1;f2;f3;f4;f5;f6;f7;f8;f9;f10\nP01;extern;A;3;3;3;3;3;3;3;3;3;3\n");
    const r = evaluateUx(config as EvalConfig, dir, "P1");
    const a = r.apps.find((x) => x.app === "A")!;
    expect(a.team).toBe("a");
    expect(a.taskSuccessPercent).toBe(50);
    expect(a.timeOnTaskMedianS).toBe(180); // 60 und 300 (gekappt)
    expect(a.sus.mean).toBe(50);
    const b = r.apps.find((x) => x.app === "B")!;
    expect(b.taskSuccessPercent).toBe(75);
    expect(r.warnings.some((w) => w.includes("nur 1 externe"))).toBe(true);
  });
});

describe("GitHub-Collector (simulierte API)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("zählt PRs im Sprint, Reviews und direkte Commits ohne PR", async () => {
    // Lokales Repo mit zwei Commits auf main: einer gehört zu PR #1 (Squash), einer nicht
    const repo = tmp();
    const git = (args: string[], date: string) =>
      execFileSync("git", args, {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@x", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      }).toString().trim();
    git(["init", "-q", "-b", "main"], "2026-10-17T10:00:00+02:00");
    git(["commit", "-q", "--allow-empty", "-m", "F-01 (#1)"], "2026-10-17T10:00:00+02:00");
    const prSha = git(["rev-parse", "HEAD"], "2026-10-17T10:00:00+02:00");
    git(["commit", "-q", "--allow-empty", "-m", "direkt"], "2026-10-18T10:00:00+02:00");
    const head = git(["rev-parse", "HEAD"], "2026-10-18T10:00:00+02:00");

    const responses: Record<string, unknown> = {
      "/repos/org/a/pulls?state=all&sort=created&direction=desc&per_page=100&page=1": [
        { number: 1, created_at: "2026-10-15T08:00:00Z", merged_at: "2026-10-17T08:00:00Z", merge_commit_sha: prSha, base: { ref: "main" }, user: { login: "anna" } },
        { number: 2, created_at: "2026-10-18T08:00:00Z", merged_at: null, merge_commit_sha: null, base: { ref: "main" }, user: { login: "ben" } },
      ],
      "/repos/org/a/pulls/1": { comments: 2, review_comments: 3, commits: 1 },
      "/repos/org/a/pulls/1/reviews?per_page=100": [{ user: { login: "ben" }, state: "APPROVED" }, { user: { login: "anna" }, state: "COMMENTED" }],
    };
    vi.stubGlobal("fetch", async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      if (!(path in responses)) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(responses[path]), { status: 200 });
    });

    const { config } = loadConfig(writeConfig(tmp(), baseConfig()));
    const ctx = {
      config,
      team: config.teams.a!,
      teamId: "a",
      sprint: config.sprints[0]!,
      repoDir: repo,
      rawDir: tmp(),
      commit: head,
    } as unknown as CollectorContext;
    const res = await githubCollector.collect(ctx);
    expect(res.status).toBe("ok");
    const m = res.metrics!;
    expect(m.prsMerged).toBe(1);
    expect(m.prsCreated).toBe(1); // PR #2 im Fenster erstellt; PR #1 vor Sprintbeginn
    expect(m.reviewedPercent).toBe(100); // Review von ben (≠ Autorin)
    expect(m.approvedPercent).toBe(100);
    expect(m.commentsPerPrMedian).toBe(5);
    expect(m.timeToMergeHours.median).toBe(48);
    expect(m.directCommitsWithoutPr).toBe(1);
  });
});

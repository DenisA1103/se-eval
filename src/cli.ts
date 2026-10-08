#!/usr/bin/env node
/**
 * Kommandozeile von se-eval.
 *
 *   se-eval init                      Konfiguration und Datenvorlagen anlegen
 *   se-eval check                     Konfiguration und manuell gepflegte Daten prüfen
 *   se-eval measure -t b -s p1-s1     Snapshot + alle Collectors für ein Team und einen Sprint
 *   se-eval ux -p P1                  UX-Tests einer Phase auswerten
 *   se-eval report                    Vergleichsbericht results/bericht.md erzeugen
 */
import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAcceptance, loadFeatures, loadTimeEntries } from "./collectors/features.js";
import { getTeam, loadConfig } from "./config.js";
import { COLLECTORS, measure, selectCollectors } from "./measure.js";
import { renderReport } from "./report/markdown.js";
import { evaluateUx } from "./ux.js";
import { TOOL_DIR, TOOL_VERSION } from "./version.js";

const program = new Command();
const log = (m: string) => console.error(m);

program
  .name("se-eval")
  .description("Evaluationstool: gleiche Messung für beide Teams (klassisch vs. agentisch)")
  .version(TOOL_VERSION)
  .option("-c, --config <datei>", "Pfad zur Konfiguration", "eval.config.json");

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

program
  .command("init")
  .description("eval.config.json und Vorlagen unter data/ anlegen (überschreibt nichts)")
  .argument("[verzeichnis]", "Zielverzeichnis", ".")
  .action((dir: string) => {
    const target = resolve(dir);
    const templates = join(TOOL_DIR, "templates");
    const copy = (from: string, to: string) => {
      if (existsSync(to)) return log(`  vorhanden, übersprungen: ${to}`);
      mkdirSync(join(to, ".."), { recursive: true });
      copyFileSync(from, to);
      log(`  angelegt: ${to}`);
    };
    copy(join(TOOL_DIR, "eval.config.example.json"), join(target, "eval.config.json"));
    copy(join(templates, "features.csv"), join(target, "data", "features.csv"));
    for (const team of ["team-a", "team-b"]) {
      for (const f of ["abnahme.csv", "zeiterfassung.csv", "mailmap"]) copy(join(templates, f), join(target, "data", team, f));
    }
    for (const f of ["ergebnisse.csv", "sus.csv"]) copy(join(templates, "ux", f), join(target, "data", "ux", "P1", f));
    log("Fertig. Als Nächstes eval.config.json anpassen (Repos, Sprints, Scope) und `se-eval check` ausführen.");
  });

program
  .command("check")
  .description("Konfiguration und CSV-Daten prüfen, ohne zu messen")
  .action(() => {
    const loaded = loadConfig(program.opts().config);
    const { config, baseDir } = loaded;
    log(`Konfiguration gültig (Plan v${config.planVersion}, sha256 ${loaded.hash.slice(0, 12)})`);
    let problems = 0;
    const attempt = (label: string, fn: () => unknown) => {
      try {
        fn();
        log(`  ✓ ${label}`);
      } catch (e) {
        problems++;
        log(`  ✗ ${label}\n    ${(e as Error).message.replace(/\n/g, "\n    ")}`);
      }
    };
    const dataRoot = join(baseDir, "data");
    let features: ReturnType<typeof loadFeatures> = [];
    attempt("data/features.csv", () => (features = loadFeatures(dataRoot)));
    for (const teamId of Object.keys(config.teams)) {
      getTeam(config, teamId);
      const dir = join(dataRoot, teamId);
      if (existsSync(join(dir, "abnahme.csv")) && features.length) attempt(`data/${teamId}/abnahme.csv`, () => loadAcceptance(join(dir, "abnahme.csv"), features, config));
      if (existsSync(join(dir, "zeiterfassung.csv"))) attempt(`data/${teamId}/zeiterfassung.csv`, () => loadTimeEntries(join(dir, "zeiterfassung.csv")));
      if (!existsSync(join(dir, "mailmap"))) log(`  ! data/${teamId}/mailmap fehlt (Personen werden über E-Mail-Adressen unterschieden)`);
    }
    const uxRoot = join(dataRoot, "ux");
    if (existsSync(uxRoot)) {
      for (const phase of readdirSync(uxRoot)) {
        if (existsSync(join(uxRoot, phase, "ergebnisse.csv"))) attempt(`data/ux/${phase}`, () => evaluateUx(config, dataRoot, phase));
      }
    }
    if (problems > 0) process.exitCode = 1;
  });

program
  .command("measure")
  .description("Snapshot zum Stichtag nehmen und messen")
  .requiredOption("-t, --team <id>", "Team-ID aus der Konfiguration oder 'all'")
  .requiredOption("-s, --sprint <id>", "Sprint-ID aus der Konfiguration")
  .option("--only <liste>", "nur diese Collectors (kommagetrennt)", list)
  .option("--skip <liste>", "diese Collectors auslassen (kommagetrennt)", list)
  .option("--refresh", "Snapshot-Commit neu bestimmen statt gespeicherten zu verwenden", false)
  .option("--keep-workdir", "Arbeitskopie unter work/ nach der Messung behalten", false)
  .action(async (opts: { team: string; sprint: string; only?: string[]; skip?: string[]; refresh: boolean; keepWorkdir: boolean }) => {
    const loaded = loadConfig(program.opts().config);
    selectCollectors(opts.only, opts.skip); // frühe Prüfung der Namen
    const teams = opts.team === "all" ? Object.keys(loaded.config.teams) : [opts.team];
    let failed = 0;
    for (const teamId of teams) {
      const manifest = await measure(loaded, { teamId, sprintId: opts.sprint, only: opts.only, skip: opts.skip, refresh: opts.refresh, keepWorkdir: opts.keepWorkdir, log });
      failed += Object.values(manifest.collectors).filter((c) => c.status === "failed").length;
      log(`Ergebnisse: results/${teamId}/${opts.sprint}/`);
    }
    if (failed > 0) {
      log(`${failed} Collector(s) fehlgeschlagen – Gründe stehen in den Ergebnisdateien und im Bericht.`);
      process.exitCode = 2;
    }
  });

program
  .command("ux")
  .description("UX-Tests einer Phase auswerten (data/ux/<phase>/)")
  .requiredOption("-p, --phase <phase>", "Phase, z. B. P1")
  .action((opts: { phase: string }) => {
    const { config, baseDir } = loadConfig(program.opts().config);
    const result = evaluateUx(config, join(baseDir, "data"), opts.phase);
    const dir = join(baseDir, "results", "ux");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${opts.phase}.json`), JSON.stringify(result, null, 2) + "\n");
    for (const w of result.warnings) log(`  ! ${w}`);
    log(`Ergebnis: results/ux/${opts.phase}.json`);
  });

program
  .command("report")
  .description("Vergleichsbericht results/bericht.md erzeugen")
  .option("-o, --output <datei>", "Zieldatei", "results/bericht.md")
  .action((opts: { output: string }) => {
    const loaded = loadConfig(program.opts().config);
    const md = renderReport(loaded);
    const target = resolve(loaded.baseDir, opts.output);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, md);
    log(`Bericht: ${target}`);
  });

program
  .command("collectors")
  .description("Verfügbare Collectors auflisten")
  .action(() => {
    for (const c of COLLECTORS) console.log(`${c.name.padEnd(10)} ${c.description}`);
  });

program.parseAsync().catch((e: Error) => {
  log(`Fehler: ${e.message}`);
  process.exitCode = 1;
});

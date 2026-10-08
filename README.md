# se-eval – Evaluationstool für den Vergleich klassisch vs. agentisch

Gemeinsames Messwerkzeug beider Teams im WPM „Software Engineering mit generativen KI-Agenten“ (HS Flensburg, WiSe 2026/27). Es setzt den abgestimmten Evaluationsplan um: **dieselben Messungen mit denselben Regeln auf beide Repos**, einschließlich des eigenen.

Ein Lauf nimmt den Stand eines Team-Repos zum Sprint-Stichtag, misst ihn und legt Rohdaten und Kennzahlen nachvollziehbar ab. Am Ende erzeugt `se-eval report` einen Vergleichsbericht.

> **Status:** Version 0.2.0, Probelauf gegen zwei Beispiel-Repos erfolgreich (siehe „Geprüft“). Vor dem Projektstart als `v1.0` taggen; danach Änderungen nur per Pull Request mit Zustimmung beider Teams (siehe „Änderungen am Tool“).

---

## Schnellstart

Voraussetzungen: Node.js ≥ 22.12, Git, npm.

```bash
git clone <dieses-repo> se-eval && cd se-eval
npm ci && npm run build

# Arbeitsordner für die Evaluation anlegen (außerhalb des Tool-Repos oder im Eval-Repo)
mkdir ../evaluation && cd ../evaluation
node ../se-eval/dist/cli.js init          # legt eval.config.json und data/-Vorlagen an
# eval.config.json anpassen: Repos, Sprints, Scope
node ../se-eval/dist/cli.js check         # prüft Konfiguration und CSV-Dateien
node ../se-eval/dist/cli.js measure -t all -s p1-s1
node ../se-eval/dist/cli.js report        # → results/bericht.md
```

Für private Repos: `export GITHUB_TOKEN=…` (Fine-grained Token, nur lesend: *Contents*, *Pull requests*). Der Token wird nie in Logs oder Ergebnisse geschrieben und ist für den Code der Team-Repos (Installation, Tests) unsichtbar: Umgebungsvariablen mit TOKEN, SECRET, PASSWORD, API_KEY o. Ä. im Namen werden vor jedem Fremdaufruf entfernt.

Hinter einem HTTP-Proxy: Node nutzt `HTTPS_PROXY` für die GitHub-API nicht automatisch; `export NODE_USE_ENV_PROXY=1` setzen (Node ≥ 22.21).

### Mit Docker (empfohlen für die offiziellen Messungen)

Gleiche Node-, Git- und Werkzeugversionen für beide Teams; fremder Code läuft nicht direkt auf dem eigenen Rechner.

```bash
docker build -t se-eval:0.2.0 .
docker run --rm -v "$PWD/../evaluation:/eval" -e GITHUB_TOKEN se-eval:0.2.0 measure -t all -s p1-s1
docker run --rm -v "$PWD/../evaluation:/eval" se-eval:0.2.0 report
```

> Das Docker-Image konnte in der Entwicklungsumgebung nicht gebaut werden (kein Zugriff auf Docker Hub). Vor der ersten Messung einmal bauen und gegen das Beispielprojekt laufen lassen.

---

## Befehle

| Befehl | Zweck |
|---|---|
| `init [verzeichnis]` | `eval.config.json` und Vorlagen unter `data/` anlegen (überschreibt nichts) |
| `check` | Konfiguration und alle CSV-Dateien prüfen, ohne zu messen |
| `measure -t <team\|all> -s <sprint>` | Snapshot nehmen und alle Collectors ausführen |
| `measure … --only static,tests` / `--skip mutation` | nur bestimmte Collectors |
| `measure … --refresh` | Snapshot-Commit neu bestimmen (sonst wird der gespeicherte wiederverwendet) |
| `measure … --keep-workdir` | Arbeitskopie unter `work/` zur Fehlersuche behalten |
| `ux -p <phase>` | UX-Tests einer Phase auswerten |
| `report` | Vergleichsbericht `results/bericht.md` erzeugen |
| `collectors` | verfügbare Collectors auflisten |

Globale Option: `-c, --config <datei>` (Standard `eval.config.json`). `results/`, `data/` und `work/` liegen neben der Konfigurationsdatei.

---

## Ablauf im Semester

| Wann | Was | Wer |
|---|---|---|
| bis 15.10. | Tool als `v1.0` taggen, Konfiguration mit beiden Teams bestätigen, Probelauf | beide |
| Starttag (16.10. / 20.11.) | `data/features.csv` (Feature-Liste, Größe S/M/L) und Abnahmechecks festlegen; `scope.core` (Kernlogik) festlegen; Arbeitsweise je Team in der Konfiguration eintragen; Mailmaps anlegen | beide |
| täglich | `data/<team>/zeiterfassung.csv` pflegen | jedes Team für sich |
| Sprint-Ende (Fr nach 12:00) | `data/<team>/abnahme.csv` für das **andere** Team ausfüllen, dann `measure -t all -s <sprint>` und `report` | bewertendes Team |
| nach Code-Freeze | UX-Tests durchführen, `data/ux/<phase>/` füllen, `ux -p <phase>`, `report` | beide |
| Abschluss | Bericht und `results/` an das andere Team zur Prüfung | beide |

---

## Messvertrag: Anforderungen an die Team-Repos

Damit beide Repos mit denselben Regeln messbar sind, gelten für **beide** Teams:

1. **Next.js mit TypeScript**, `package-lock.json` im Repo; `npm ci` läuft ohne manuelle Schritte durch (keine nötigen `.env`-Werte für Installation, Typprüfung oder Unit-Tests).
2. **Vitest** als Test-Runner für Unit- und Integrationstests. `@vitest/coverage-v8` in passender Version ist empfohlen (fehlt es, installiert das Tool es nur in der Arbeitskopie nach).
3. **Ordner- und Namenskonventionen** (in `scope`/`testTypes` der Konfiguration festgehalten):
   - Tests: `*.test.ts(x)` oder `*.spec.ts(x)`, `__tests__/` oder `tests/`
   - Integrationstests: `*.int.test.ts(x)` oder `tests/integration/`
   - E2E-Tests (z. B. Playwright): `e2e/` – werden gezählt, nicht ausgeführt
   - Kernlogik für Mutation Testing: am Starttag gemeinsam festgelegte Pfade (Vorschlag `src/lib/`, `lib/`)
4. **Hauptbranch `main`**. Feature-IDs (z. B. `F-03`) im Branch-Namen oder in der Commit-Nachricht, damit die Durchlaufzeit je Feature bestimmbar ist.
5. **Lesezugriff** für das andere Team auf Repo und Pull Requests.
6. Hinweis zu `create-next-app`: Das Standard-`@types/node@^20` kollidiert mit Vitest 5 (peer `^22 || >=24`). Lösung: `npm i -D @types/node@^22 vitest @vitest/coverage-v8`.

---

## Was gemessen wird

| Dimension (Leitfrage) | Werkzeug | Metriken | Vorgehen / Neutralität |
|---|---|---|---|
| Statische Analyse (F1) | ESLint 10 + typescript-eslint (type-checked) + eslint-plugin-sonarjs; TypeScript-Compiler; jscpd | Befunde je KLOC; kognitive Komplexität Median/P90/Anzahl > 15; `tsc --strict`-Fehler je KLOC; Typ-Umgehungen (`any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`) je KLOC; duplizierte Zeilen in % | Neutrale Konfiguration aus `configs/`, Team-Konfiguration wird ignoriert; `--no-inline-config` (Deaktivierungskommentare wirken nicht, werden aber gezählt); nur App-Code ohne Tests; `strict` erzwungen; `next typegen` vor der Typprüfung |
| Testing (F2) | Vitest + coverage-v8 | Testfälle Unit/Integration/E2E; Anteil Testcode; Line/Branch/Statement/Function Coverage; App-Dateien ohne Coverage; fehlgeschlagene und instabile Tests | Eigene Wrapper-Konfiguration: übernimmt Aliase/Umgebung des Teams, setzt aber Testauswahl und Coverage neutral (alle App-Dateien, keine Team-Ausschlüsse, keine Schwellen); Suite 3× für Flakiness; rote Tests zählen |
| Wirksamkeit (F2) | StrykerJS 10 + Vitest-Runner | Mutation Score gesamt und **auf abgedecktem Code**; überlebende/ungetestete Mutanten | Nur Kernlogik; `perTest`-Coverage; Zeitlimit; bei rotem Initiallauf ein zweiter Versuch, sonst „nicht messbar“ |
| Features (F4) | CSV `features.csv` + `abnahme.csv` | fertige und gewichtete Punkte, Fertigstellungsgrad, Durchsatz je Sprint, Burn-up | S=1/M=2/L=3; Status aus vorab geteilten Abnahmechecks: alle bestanden = fertig, mindestens einer = teilweise (0,5), keiner = offen |
| Aufwand (F4) | CSV `zeiterfassung.csv` | Personenstunden je Sprint/Phase/Person/Tätigkeit; fertige Punkte je Personenstunde | 15-Minuten-Raster wird geprüft; Abgleich mit Git-Aktivität (Tage mit Stunden ohne Commits und umgekehrt) wird markiert, nicht korrigiert |
| Git (F5) | `git log`, Mailmap | Commits, Commits je Person und Tag, aktive Tage, Commit-Größe Median/P90, Beitragsanteile, gemergte Branches und Lebensdauer, Feature-Durchlaufzeit, Anteil Commits mit KI-Co-Autor | Lockfiles/Generiertes ausgeschlossen (`git.exclude`); keine Produktivitätsaussage aus Commits/LOC |
| Pull Requests (F5) | GitHub-REST-API (lesend) | gemergte PRs, Anteil mit Review/Approval, Kommentare je PR, Zeit bis Merge, direkte Commits ohne PR | Review zählt nur, wenn nicht von der PR-Autorin selbst |
| Usability (F3) | CSV `ergebnisse.csv` + `sus.csv` | Task Success, Time-on-Task (Median, Abbruch = 300 s), Fehler je Aufgabe, SUS (Brooke 1996) | Getrennt nach Gruppe `extern` (Hauptstichprobe) und `team`; Reihenfolge-Balance ausgewiesen; Apps verblindet als A/B |

---

## Konfiguration (`eval.config.json`)

Vorlage: `eval.config.example.json`. Wichtigste Felder:

- `planVersion` – Version des Evaluationsplans; steht in jedem Ergebnis.
- `teams.<id>` – `name`, `repo` (URL oder lokaler Pfad), `github` (`owner/repo`, optional), `branch`, `arbeitsweise` je Phase, `uxLabel` je Phase (neutrale Bezeichnung im UX-Test).
- `sprints[]` – `id`, `phase`, `start` (JJJJ-MM-TT, 00:00 Uhr Berlin), `stichtag` (mit Uhrzeit **und** Zeitzone, z. B. `2026-10-23T12:00:00+02:00`; ab 25.10. gilt `+01:00`).
- `scope` – Glob-Muster für `app`, `tests`, `core`, `exclude`.
- `testTypes` – Muster für `integration` und `e2e`.
- `tests.runs`, `tests.timeoutMinutes`, `mutation.*`, `static.*`, `git.*`, `installCommand`.

Der SHA-256-Hash der Konfiguration steht in jedem Ergebnis. Ändert sich die Konfiguration nach Projektstart, muss das im Änderungsprotokoll stehen.

---

## Manuell gepflegte Daten (`data/`)

Alle CSV-Dateien dürfen Semikolon (Excel) oder Komma als Trenner haben, Dezimalkomma ist erlaubt, Zeilen mit `#` am Anfang sind Kommentare. `check` meldet Fehler mit Zeilennummer.

| Datei | Spalten |
|---|---|
| `data/features.csv` | `id;titel;groesse` (S/M/L) – für beide Teams gleich |
| `data/<team>/abnahme.csv` | `sprint;feature_id;checks_bestanden;checks_gesamt;notiz` – es gilt der letzte Eintrag bis einschließlich des Sprints |
| `data/<team>/zeiterfassung.csv` | `datum;person;stunden;feature;taetigkeit` – `person` wie in der Mailmap |
| `data/<team>/mailmap` | Git-Mailmap-Format: `Name <haupt@mail> <andere@mail>` |
| `data/ux/<phase>/ergebnisse.csv` | `proband;gruppe;app;reihenfolge;aufgabe;erfolg;zeit_s;fehler` – `gruppe` = extern/team, `erfolg` = 1/0,5/0 |
| `data/ux/<phase>/sus.csv` | `proband;gruppe;app;f1;…;f10` – Antworten 1–5 |

---

## Ergebnisablage

```
results/
  bericht.md                      Vergleichsbericht
  <team>/<sprint>/
    snapshot.json                 Snapshot-Commit, Stichtag, Stand von main zum Messzeitpunkt
    manifest.json                 Tool-Version, Konfig-Hash, Node/Plattform, Status je Collector
    static.json, tests.json, …    Kennzahlen je Collector inkl. Warnungen und Werkzeugversionen
    raw/                          Rohdaten (ESLint-JSON, Vitest-JSON, Coverage, Stryker-Bericht, Logs)
  ux/<phase>.json
```

`results/` gehört ins gemeinsame Evaluations-Repo (Lesezugriff für beide Teams). Ein erneuter `measure` für denselben Sprint misst denselben Commit (aus `snapshot.json`), auch wenn das Team inzwischen weiter committet hat.

---

## Neutralität und Reproduzierbarkeit

- **Snapshot:** letzter Commit auf `main` vor dem Stichtag, bestimmt mit `git rev-list --first-parent --before`. `--first-parent` verhindert, dass ein Commit aus einem Feature-Branch gewählt wird, der zum Stichtag noch nicht gemergt war.
- **Frische Arbeitskopie** je Messung (`git clone`, `npm ci`); nichts wird ins Team-Repo zurückgeschrieben.
- **Neutrale Konfigurationen** für ESLint, TypeScript, Vitest-Coverage und Stryker; Team-Einstellungen, die Ergebnisse verschönern könnten (Lint-Regeln aus, Coverage-Ausschlüsse, Schwellen), wirken nicht.
- **Gepinnte Versionen** (`package-lock.json`, StrykerJS-Version in der Konfiguration, Docker-Image).
- **Bots** (`dependabot[bot]` usw.) zählen nicht als Teammitglieder (`git.excludeAuthors`).
- **Geänderter Stichtag:** Wird ein Stichtag nach der ersten Messung geändert, verweigert das Tool die Wiederverwendung des alten Snapshots, bis mit `--refresh` neu bestimmt wird (gehört ins Änderungsprotokoll).
- **Fehler werden ausgewiesen**, nicht verschwiegen: Fällt ein Collector aus, steht „nicht gemessen“ mit Grund im Bericht.
- Probelauf: Zwei unabhängige Läufe auf denselben Snapshots ergaben einen identischen Bericht (bis auf den Zeitstempel).

---

## Bekannte Grenzen

- **Squash-/Rebase-Merges** sind lokal nicht von direkten Commits zu unterscheiden. „Commits auf main ohne Merge-Commit“ daher nur zusammen mit „Direkte Commits ohne PR“ (GitHub) interpretieren. Ebenso ist die Feature-Durchlaufzeit bei Squash-Merges ohne Branch-Historie nahe 0 h; dann die PR-Zeit bis Merge heranziehen.
- **Kognitive Komplexität:** eslint-plugin-sonarjs meldet nur Funktionen mit Komplexität ≥ 1. Median/P90 beziehen sich auf diese Funktionen; die Anzahl > 15 ist davon unberührt.
- **Mutation Testing** braucht einen grünen Initiallauf. Rote oder instabile Tests können den Score unmessbar machen (wird ausgewiesen).
- **E2E-Tests** werden nur statisch gezählt (Aufrufe von `test()`/`it()`), nicht ausgeführt.
- **Codezeilen** werden über den TypeScript-Scanner gezählt; in Randfällen (Regex mit `//`, Leerzeilen in Template-Strings) weicht die Zählung um einzelne Zeilen ab – für beide Repos gleich.
- **Claude-Code-Telemetrie (OpenTelemetry)** ist noch nicht angebunden; Aufwand kommt bisher nur aus der Zeiterfassung.
- **SonarQube** ist nicht eingebunden; Komplexität und Duplikate kommen aus eslint-plugin-sonarjs und jscpd.
- Alle Auswertungen sind **deskriptiv** (n = 1 Team je Arbeitsweise).

---

## Geprüft

- 32 Unit-Tests für Formeln, Parser und Review-Punkte (`npm test`), u. a. Median/P90 (R-7), SUS, Mutation Score, Zeitfenster mit Sommer-/Winterzeit, CSV-Validierung, GitHub-Collector gegen simulierte API, Schutz von Zugangsdaten, gleichnamige Tests, Symlink-Pfade, Bot-Commits, geänderter Stichtag.
- End-to-End-Probelauf gegen zwei Next.js-16-Beispiel-Repos mit konstruierten Eigenschaften (instabiler Test, schwache Assertions, Duplikat, `any`/`@ts-ignore`, Team-Konfiguration mit Coverage-Ausschluss und hoher Schwelle, Merge- vs. Squash-Historie, KI-Co-Autor, zweite E-Mail-Adresse). Die selbst berechneten Kennzahlen (Git, Features, Aufwand, UX, Mutation Score, Zeitfenster) gegen Handrechnung geprüft. Nachvollziehbar mit `beispiel/` (siehe dort).
- Gleicher Bericht auf Linux x64 und Linux arm64 (Apple-Silicon-VM); zwei unabhängige Läufe ergeben denselben Bericht.
- Next.js-Routen mit eckigen Klammern (`app/[slug]/page.tsx`) werden in allen Collectors erfasst.
- **Nicht** geprüft: GitHub-API gegen ein echtes Repo, Docker-Image-Build, Lauf direkt unter macOS (statt in einer Linux-VM).

## Entwicklung

```bash
npm ci
npm test            # Unit-Tests
npm run typecheck   # Typprüfung inkl. Tests
npm run dev -- --help   # CLI direkt aus den Quellen (tsx)
```

Aufbau: `src/cli.ts` (Befehle) → `src/measure.ts` (Ablauf) → `src/snapshot.ts` und `src/collectors/*.ts` (je Dimension ein Collector mit einheitlicher Schnittstelle) → `src/report/markdown.ts`. Ein neuer Collector implementiert `Collector` aus `src/collectors/types.ts` und wird in `COLLECTORS` (`src/measure.ts`) eingetragen.

## Änderungen am Tool

Vor Projektstart wird der Stand als `v1.0` getaggt. Danach gilt:

1. Änderungen nur per Pull Request, Review durch **beide** Teams.
2. Jede Änderung, die Messwerte beeinflussen kann, steht mit Datum und Begründung in `AENDERUNGEN.md`.
3. Bereits gemessene Sprints werden nach einer solchen Änderung für **beide** Teams neu gemessen.

## Entstehung

Das Tool wurde agentisch mit Claude Code entwickelt (Vorgabe des Dozenten: „könnt ihr vibecoden“) und vom Team geprüft. Es ist selbst nicht Gegenstand der Evaluation.
# se-eval

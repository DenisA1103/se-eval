# Evaluationsbericht (automatisch erzeugt)

Evaluationsplan v1.0-probelauf · se-eval 0.1.0 · Konfiguration sha256:94ee1588c059 · erzeugt 8.10.2026, 14:20:52

> Rein deskriptiver Vergleich (je Arbeitsweise ein Team, n = 1). Unterschiede sind keine Belege für kausale Effekte der Arbeitsweise. Alle Zahlen sind aus den Rohdaten in `results/<team>/<sprint>/raw/` nachrechenbar.

## Phase P1

**Beispielteam A** (team-a): agentisch · **Beispielteam B** (team-b): klassisch

### Snapshots

| | team-a (agentisch) · p1-s1 | team-b (klassisch) · p1-s1 |
|---|---|---|
| Commit | `f27c0622df` | `27a0cd62e0` |
| Commit-Datum | 22.10.2026, 13:00:00 | 23.10.2026, 09:00:00 |
| Stichtag | 23.10.2026, 12:00:00 | 23.10.2026, 12:00:00 |

### Statische Analyse (F1 Wartbarkeit)

| Metrik | team-a (agentisch) · p1-s1 | team-b (klassisch) · p1-s1 |
|---|---:|---:|
| Codezeilen App (SLOC) | 160 | 164 |
| ESLint-Befunde je KLOC<sup>1</sup> | 31,25 | 30,49 |
| Kognitive Komplexität Median<sup>2</sup> | 13 | 2 |
| Kognitive Komplexität P90 | 21,8 | 19,6 |
| Funktionen über Schwelle (> 15) | 1 | 1 |
| tsc --strict Fehler je KLOC | 0 | 0 |
| Typ-Umgehungen je KLOC<sup>3</sup> | 18,75 | 18,29 |
| Duplizierte Zeilen | 3,31 % | 3,23 % |

<sup>1</sup> neutrale Konfiguration, Inline-Deaktivierungen ignoriert · <sup>2</sup> über Funktionen mit Komplexität ≥ 1 · <sup>3</sup> any, @ts-ignore, @ts-expect-error, @ts-nocheck, eslint-disable

### Testing (F2 Gründlichkeit)

| Metrik | team-a (agentisch) · p1-s1 | team-b (klassisch) · p1-s1 |
|---|---:|---:|
| Testfälle Unit | 6 | 7 |
| Testfälle Integration | 0 | 0 |
| Testfälle E2E (gezählt) | 0 | 0 |
| Anteil Testcode | 18,78 % | 21,53 % |
| Line Coverage | 69,23 % | 65,85 % |
| Branch Coverage | 92 % | 85,18 % |
| App-Dateien ohne Coverage | 2 | 3 |
| Fehlgeschlagene Tests (1. Lauf) | 0 | 0 |
| Instabile Tests (flaky) | 1 | 0 |

### Wirksamkeit der Tests (Mutation Testing) (F2 Wirksamkeit)

| Metrik | team-a (agentisch) · p1-s1 | team-b (klassisch) · p1-s1 |
|---|---:|---:|
| Mutanten | 104 | 111 |
| Mutation Score gesamt | 18,27 % | 49,55 % |
| Mutation Score auf abgedecktem Code<sup>1</sup> | 22,09 % | 63,95 % |
| Überlebende Mutanten | 67 | 31 |
| Mutanten ohne Testabdeckung | 18 | 25 |

<sup>1</sup> für die 2×2-Matrix Coverage/Mutation Score

### Features (F4 Durchsatz)

| Metrik | team-a (agentisch) · p1-s1 | team-b (klassisch) · p1-s1 |
|---|---:|---:|
| Fertige Punkte (kumuliert) | 2 | 6 |
| Gewichtete Punkte inkl. teilweise | 3,5 | 6 |
| Punkte gesamt (Scope) | 6 | 6 |
| Fertigstellungsgrad | 33,3 % | 100 % |
| Durchsatz (neu fertige Punkte im Sprint) | 2 | 6 |

### Aufwand (F4 Aufwand)

| Metrik | team-a (agentisch) · p1-s1 | team-b (klassisch) · p1-s1 |
|---|---:|---:|
| Personenstunden im Sprint | 16,25 h | 19,25 h |
| Personenstunden kumuliert (Phase) | 16,25 h | 19,25 h |
| Fertige Punkte je Personenstunde (kumuliert) | 0,12 | 0,31 |
| Neue Punkte je Personenstunde (Sprint) | 0,12 | 0,31 |

### Git-Repository (F5 Zusammenarbeit)

| Metrik | team-a (agentisch) · p1-s1 | team-b (klassisch) · p1-s1 |
|---|---:|---:|
| Commits (ohne Merges) | 6 | 5 |
| Commits je Person und Tag | 0,27 | 0,33 |
| Commit-Größe Median (Zeilen) | 27,5 | 38 |
| Commit-Größe P90 (Zeilen) | 262 | 312,8 |
| Gemergte Branches (Merge-Commits) | 2 | 0 |
| Branch-Lebensdauer Median | 33 h | – |
| Commits auf main ohne Merge-Commit<sup>1</sup> | 2 | 5 |
| Feature-Durchlaufzeit Median<sup>2</sup> | 22 h | 0 h |
| Commits mit KI-Co-Autor<sup>3</sup> | 50 % | 0 % |

<sup>1</sup> enthält auch Squash-/Rebase-Merges, siehe GitHub · <sup>2</sup> erster Commit mit Feature-ID bis Integration in main; bei Squash-Merges ohne Branch-Historie nahe 0 h, dann die PR-Zeit bis Merge heranziehen · <sup>3</sup> nur beschreibend

### Pull Requests (GitHub) (F5 Zusammenarbeit)

_Nicht gemessen: Kein "github" (owner/repo) für das Team konfiguriert_

### Beitragsverteilung (letzter gemessener Sprint)

| Team · Sprint | Person | Commits | Anteil Commits | Anteil Zeilen | Aktive Tage |
|---|---|---:|---:|---:|---:|
| team-a · p1-s1 | Anna Beispiel | 3 | 50 % | 85,8 % | 2 |
| team-a · p1-s1 | Ben Muster | 2 | 33,3 % | 8,8 % | 2 |
| team-a · p1-s1 | Cem Probe | 1 | 16,7 % | 5,5 % | 1 |
| team-b · p1-s1 | Dana Klass | 3 | 60 % | 84,6 % | 3 |
| team-b · p1-s1 | Eli Hand | 2 | 40 % | 15,4 % | 2 |

### Usability-Tests (F3)

| Metrik | App A (Beispielteam A) · extern | App A (Beispielteam A) · team | App B (Beispielteam B) · extern | App B (Beispielteam B) · team |
|---|---:|---:|---:|---:|
| Proband:innen | 6 | 1 | 6 | 1 |
| Task Success | 66,7 % | 100 % | 77,8 % | 100 % |
| Time-on-Task Median (alle, Abbruch = 300 s) | 132 s | 61 s | 124,5 s | 60 s |
| Time-on-Task Median (nur gelöst) | 133 s | 61 s | 118 s | 60 s |
| Fehler je Aufgabe (Mittel) | 1,33 | 0 | 1,17 | 0 |
| SUS Mittelwert | 74,6 | 75 | 74,6 | 75 |
| SUS Median | 75 | 75 | 76,3 | 75 |
| Als erste App getestet | 3 | 1 | 3 | 1 |

Zum Vergleich: Der SUS-Durchschnitt über viele Studien liegt bei etwa 68 (MeasuringU). Hauptstichprobe ist die Gruppe „extern“.

## Hinweise zur Messung

- team-a (agentisch) · p1-s1 · mutation: Initiallauf beim ersten Versuch rot (instabile Tests?), Messung im zweiten Versuch
- team-a (agentisch) · p1-s1 · features: 1 Feature(s) ohne Abnahmeeintrag in diesem Sprint (Status aus Vorsprint übernommen bzw. offen)
- team-b (klassisch) · p1-s1 · git: Keine Mailmap (data/<team>/mailmap): Personen mit mehreren E-Mail-Adressen zählen mehrfach
- team-b (klassisch) · p1-s1 · git: Keine Merge-Commits auf main: Squash/Rebase-Merges sind lokal nicht von direkten Commits unterscheidbar (siehe Collector github)
- team-a (agentisch) · p1-s1 · github: übersprungen – Kein "github" (owner/repo) für das Team konfiguriert
- team-b (klassisch) · p1-s1 · github: übersprungen – Kein "github" (owner/repo) für das Team konfiguriert

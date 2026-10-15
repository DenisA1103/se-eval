# Änderungsprotokoll

Jede Änderung an Tool oder Konfiguration, die Messwerte beeinflussen kann, wird hier mit Datum, Begründung und Zustimmung beider Teams eingetragen. Betroffene Sprints werden für beide Teams neu gemessen.

| Datum | Version | Änderung | Begründung | Auswirkung auf Messwerte | Zustimmung |
|---|---|---|---|---|---|
| 2026-10-08 | 0.1.0 | Erste Fassung | Umsetzung des Evaluationsplans | – | ausstehend |
| 2026-10-08 | 0.2.0 | Code-Review: Zugangsdaten werden vor Fremdaufrufen entfernt; Git-Zugang ergänzt vorhandene GIT_CONFIG_*-Einträge; geänderter Stichtag erzwingt --refresh; gleichnamige Tests werden getrennt gezählt; Symlink-Pfade; Bot-Commits ausgeschlossen (git.excludeAuthors); Stryker-mutate über Globs (Next-Routen mit [ ]); klarere Meldung bei Netzwerk-/Proxyfehlern | Sicherheit, Korrektheit bei Randfällen | Beispiel-Repos: keine Änderung der Messwerte | ausstehend |
| 2026-10-15 | 1.0.0 + PR | Coverage wird auch erzeugt, wenn Tests fehlschlagen (`coverage.reportOnFailure: true` in der Wrapper-Konfiguration) | Vitest schreibt standardmäßig keinen Coverage-Bericht, sobald ein Test rot ist; rote Tests zählen laut Plan mit, die Coverage fehlte dann komplett (Befund T1 aus dem Probelauf 14.10.) | Nur Messungen mit mindestens einem roten Test: Coverage-Werte statt „–“; Messungen mit grüner Suite unverändert | ausstehend |


/**
 * Einlesen der manuell gepflegten CSV-Dateien.
 *
 * Unterstützt Semikolon (Excel, deutsches Gebietsschema) und Komma als Trenner; der Trenner wird an der
 * Kopfzeile erkannt. Zahlen dürfen ein Dezimalkomma haben ("0,5"). Spaltennamen werden ohne Beachtung
 * von Groß-/Kleinschreibung und Leerzeichen verglichen.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

export type Row = Record<string, string> & { __line: string };

export class CsvError extends Error {}

export function readCsv(path: string, requiredColumns: string[]): Row[] {
  if (!existsSync(path)) throw new CsvError(`Datei fehlt: ${path}`);
  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM aus Excel entfernen
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (header.match(/;/g)?.length ?? 0) >= (header.match(/,/g)?.length ?? 0) ? ";" : ",";
  const records = parse(text, {
    delimiter,
    columns: (h: string[]) => h.map(normalizeKey),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    info: true,
  }) as { record: Record<string, string>; info: { lines: number } }[];
  const headerKeys = header.split(delimiter).map((h) => normalizeKey(h.replace(/^"|"$/g, "")));
  const missing = requiredColumns.filter((c) => !headerKeys.includes(normalizeKey(c)));
  if (missing.length > 0) throw new CsvError(`${path}: Spalten fehlen: ${missing.join(", ")}`);
  return records
    .filter(({ record }) => Object.values(record).some((v) => v !== ""))
    // Kommentarzeilen (erste Zelle beginnt mit #) erlauben Hinweise in Vorlagen
    .filter(({ record }) => !(Object.values(record)[0] ?? "").startsWith("#"))
    .map(({ record, info }) => ({ ...record, __line: String(info.lines) }) as Row);
}

export function normalizeKey(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Zahl mit Punkt oder Komma als Dezimaltrenner; null, wenn ungültig oder leer. */
export function parseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.trim().replace(",", ".");
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Datum JJJJ-MM-TT oder TT.MM.JJJJ → JJJJ-MM-TT; null, wenn ungültig. */
export function parseDay(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  let iso: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s;
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (de) iso = `${de[3]}-${de[2]!.padStart(2, "0")}-${de[1]!.padStart(2, "0")}`;
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  // Ungültige Tage wie 2026-02-30 abfangen
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? iso : null;
}

/** Sammelt Validierungsfehler und wirft sie gesammelt (Datenqualität vor Auswertung). */
export class Problems {
  private list: string[] = [];
  add(file: string, row: Row | null, msg: string) {
    this.list.push(`${file}${row ? `, Zeile ${row.__line}` : ""}: ${msg}`);
  }
  throwIfAny(): void {
    if (this.list.length > 0) {
      const shown = this.list.slice(0, 25).join("\n  ");
      throw new CsvError(`Datenfehler (${this.list.length}):\n  ${shown}${this.list.length > 25 ? "\n  …" : ""}`);
    }
  }
}

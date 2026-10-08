/**
 * Deskriptive Statistik. Laut Evaluationsplan werden nur deskriptive Kennzahlen berichtet
 * (n = 1 Team je Arbeitsweise, keine Inferenzstatistik).
 */

/** Quantil nach der linearen Interpolationsmethode (R-7, Standard in R/NumPy/Excel QUANTIL.INKL). */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  if (q < 0 || q > 1) throw new RangeError("q muss zwischen 0 und 1 liegen");
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const lo = sorted[lower]!;
  const hi = sorted[upper]!;
  return lo + (hi - lo) * (pos - lower);
}

export const median = (values: readonly number[]): number | null => quantile(values, 0.5);
export const p90 = (values: readonly number[]): number | null => quantile(values, 0.9);

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

/** Division mit null bei Nenner 0 (statt Infinity/NaN), gerundet auf `digits` Nachkommastellen. */
export function ratio(numerator: number, denominator: number, digits = 2): number | null {
  if (denominator === 0) return null;
  return round(numerator / denominator, digits);
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Wert je 1.000 Zeilen Code. */
export function perKloc(count: number, loc: number): number | null {
  return ratio(count * 1000, loc, 2);
}

/** Rundet ein nullable Ergebnis (praktisch für median/p90). */
export function roundOrNull(value: number | null, digits = 2): number | null {
  return value === null ? null : round(value, digits);
}

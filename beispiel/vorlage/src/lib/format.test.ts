import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEuro } from "./format";

it("formatiert Euro", () => {
  expect(formatEuro(1234.5)).toBe("1.234,50 €");
});

// Absichtlich instabil (flaky): scheitert bei jedem zweiten Lauf, um die Flakiness-Erkennung zu prüfen.
it("instabiler Test", () => {
  const file = join(tmpdir(), "sample-app-flaky-counter");
  let n = 0;
  try { n = Number(readFileSync(file, "utf8")); } catch { /* erster Lauf */ }
  writeFileSync(file, String(n + 1));
  expect(n % 2).toBe(0);
});

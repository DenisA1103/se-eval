import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Team-eigene Konfiguration: blendet untested.ts aus und setzt hohe Schwellen.
// Das Evaluationstool muss beides neutral überschreiben.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    coverage: { provider: "v8", exclude: ["src/lib/untested.ts"], thresholds: { lines: 95 } },
  },
});

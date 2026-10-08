// Neutrale, für beide Teams identische ESLint-Konfiguration.
// Wird mit `eslint -c` aufgerufen; die ESLint-Konfiguration des Teams wird dadurch ignoriert.
// Plugins werden relativ zu dieser Datei aufgelöst, also aus den node_modules des Evaluationstools.
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

// Wurzelverzeichnis des zu messenden Repos (vom Tool gesetzt)
const repoDir = process.env.SE_EVAL_REPO_DIR ?? process.cwd();

export default tseslint.config(
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: repoDir,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { sonarjs },
    rules: {
      // Schwelle 0: jede Funktion mit Komplexität >= 1 wird gemeldet, damit wir die Verteilung
      // (Median, P90) berechnen können. Die Schwelle 15 wird erst in der Auswertung angewendet.
      "sonarjs/cognitive-complexity": ["warn", 0],
    },
  },
);

#!/usr/bin/env bash
# Erzeugt zwei Beispiel-Repos (repos/sample-app, repos/sample-app-b) mit konstruierten Eigenschaften
# für den Probelauf von se-eval. Danach:
#   node ../dist/cli.js measure -t all -s p1-s1 && node ../dist/cli.js ux -p P1 && node ../dist/cli.js report
#
# Eigenschaften Team A: Merge-Commits über Feature-Branches, KI-Co-Autor, zweite E-Mail-Adresse (Mailmap),
#   instabiler Test, schwache Assertions (niedriger Mutation Score), Duplikat, any/@ts-ignore,
#   Team-Vitest-Konfiguration mit Coverage-Ausschluss und hoher Schwelle (muss neutralisiert werden).
# Eigenschaften Team B: nur Commits direkt auf main (wie Squash-Merges), stärkere Tests, ungetestete Datei.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
rm -rf repos && mkdir repos && cd repos

c() { # c <name> <email> <datum> <nachricht> [trailer]
  local msg="$4"; [ -n "${5:-}" ] && msg="$msg"$'\n\n'"$5"
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_AUTHOR_DATE="$3" \
  GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" GIT_COMMITTER_DATE="$3" git commit -q -m "$msg"
}
m() { # m <branch> <name> <email> <datum>
  GIT_AUTHOR_NAME="$2" GIT_AUTHOR_EMAIL="$3" GIT_AUTHOR_DATE="$4" \
  GIT_COMMITTER_NAME="$2" GIT_COMMITTER_EMAIL="$3" GIT_COMMITTER_DATE="$4" git merge -q --no-ff "$1" -m "Merge branch '$1'"
}
CO="Co-Authored-By: Claude <noreply@anthropic.com>"

# ---------- Grundgerüst (einmal erzeugen, für beide Repos kopieren) ----------
npx --yes create-next-app@16.4.0 base --ts --eslint --app --src-dir --no-tailwind --import-alias "@/*" --use-npm --no-turbopack --yes --skip-install --disable-git
cd base
node -e 'const p=require("./package.json");p.scripts.test="vitest run";p.devDependencies["@types/node"]="^22";require("fs").writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
npm install --no-audit --no-fund
npm install -D --no-audit --no-fund vitest@5.0.3 @vitest/coverage-v8@5.0.3
cp "$HERE/vorlage/vitest.config.ts" .
rm -rf node_modules .next
cd ..

# ---------- Team A ----------
cp -r base sample-app && cd sample-app && git init -q -b main
mkdir -p src/lib
git add -A && c "Anna Beispiel" "anna@example.org" "2026-10-16T10:00:00+02:00" "chore: Projekt aufsetzen"
cp "$HERE"/vorlage/src/lib/* src/lib/
git checkout -q -b feature/F-01-cart
git add src/lib/cart.ts && c "Anna Beispiel" "anna@example.org" "2026-10-17T11:00:00+02:00" "feat: Warenkorb-Summe" "$CO"
git add src/lib/cart.test.ts && c "Anna Beispiel" "anna.b@stud.example.org" "2026-10-17T15:30:00+02:00" "test: Warenkorb" "$CO"
git checkout -q main && m feature/F-01-cart "Ben Muster" "ben@example.org" "2026-10-18T09:00:00+02:00"
git checkout -q -b feature/F-02-validation
git add src/lib/validation.ts && c "Ben Muster" "ben@example.org" "2026-10-19T14:00:00+02:00" "feat: Bestellvalidierung"
git add src/lib/validation.test.ts && c "Ben Muster" "ben@example.org" "2026-10-20T16:00:00+02:00" "test: Validierung"
git checkout -q main && m feature/F-02-validation "Anna Beispiel" "anna@example.org" "2026-10-21T10:00:00+02:00"
git add src/lib/format.ts src/lib/format.test.ts && c "Cem Probe" "cem@example.org" "2026-10-22T13:00:00+02:00" "F-03: Euro-Formatierung (direkt auf main)" "$CO"
git add src/lib/untested.ts && c "Cem Probe" "cem@example.org" "2026-10-23T14:00:00+02:00" "feat: Hilfsfunktion nach Stichtag"
cd ..

# ---------- Team B ----------
cp -r base sample-app-b && cd sample-app-b && git init -q -b main
mkdir -p src/lib
git add -A && c "Dana Klass" dana@example.org 2026-10-16T09:00:00+02:00 "Projekt aufsetzen"
cp "$HERE"/vorlage/src/lib/* src/lib/ && cp "$HERE"/vorlage-team-b/src/lib/* src/lib/
git add src/lib/cart.ts src/lib/cart.test.ts && c "Dana Klass" dana@example.org 2026-10-18T10:00:00+02:00 "F-01 Warenkorb (#1)"
git add src/lib/validation.ts src/lib/validation.test.ts && c "Eli Hand" eli@example.org 2026-10-21T15:00:00+02:00 "F-02 Bestellvalidierung (#2)"
git add src/lib/format.ts src/lib/format.test.ts && c "Eli Hand" eli@example.org 2026-10-22T17:00:00+02:00 "F-03 Formatierung (#3)"
git add -A && c "Dana Klass" dana@example.org 2026-10-23T09:00:00+02:00 "Hilfsfunktion"
cd .. && rm -rf base

# Zähler des absichtlich instabilen Tests zurücksetzen
rm -f "${TMPDIR:-/tmp}/sample-app-flaky-counter"
echo "Beispiel-Repos erzeugt unter $HERE/repos"

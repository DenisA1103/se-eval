/**
 * Tests zu Punkten aus dem Code-Review: Schutz von Zugangsdaten, gleichnamige Tests,
 * Symlink-Pfade, Bot-Commits, geänderter Stichtag.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withoutSecrets } from "../src/lib/exec.js";
import { githubAuthEnv } from "../src/snapshot.js";
import { relativeToRepo, testOutcomes, type VitestJson } from "../src/collectors/tests.js";
import { gitCollector } from "../src/collectors/git.js";
import { loadConfig } from "../src/config.js";
import { measure } from "../src/measure.js";
import type { CollectorContext } from "../src/collectors/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "se-eval-review-"));
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("Zugangsdaten", () => {
  it("entfernt Tokens und Passwörter aus der Umgebung für fremden Code", () => {
    const env = withoutSecrets({ PATH: "/bin", GITHUB_TOKEN: "x", GH_TOKEN: "x", NPM_AUTH_TOKEN: "x", DB_PASSWORD: "x", OPENAI_API_KEY: "x", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
  it("hängt den GitHub-Zugang an vorhandene Git-Konfiguration an, statt sie zu überschreiben", () => {
    process.env.GITHUB_TOKEN = "abc";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.checkStat";
    const env = githubAuthEnv("https://github.com/org/repo.git");
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_1).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined(); // vorhandener Eintrag bleibt unangetastet
    expect(githubAuthEnv("https://gitlab.com/org/repo.git")).toEqual({});
  });
});

describe("Testergebnisse", () => {
  it("vermischt gleichnamige Tests einer Datei nicht", () => {
    const json = {
      testResults: [{ name: "/r/a.test.ts", status: "failed", assertionResults: [{ fullName: "x", status: "passed", title: "x" }, { fullName: "x", status: "failed", title: "x" }] }],
    } as unknown as VitestJson;
    expect(testOutcomes(json, "/r")).toEqual([
      ["a.test.ts › x", "passed"],
      ["a.test.ts › x #2", "failed"],
    ]);
  });
  it("erkennt Pfade hinter einem Symlink", () => {
    const real = tmp();
    mkdirSync(join(real, "repo"));
    const link = join(tmp(), "link");
    symlinkSync(join(real, "repo"), link);
    expect(relativeToRepo(join(realpathSync(join(real, "repo")), "src/a.test.ts"), link)).toBe("src/a.test.ts");
  });
});

/** Kleines Repo mit festen Zeitstempeln; gibt den Pfad zurück. */
function makeRepo(commits: { name: string; email: string; date: string; msg: string }[]): string {
  const repo = tmp();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  commits.forEach((c, i) => {
    writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", c.msg], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: c.name, GIT_AUTHOR_EMAIL: c.email, GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date },
    });
  });
  return repo;
}

function writeCfg(dir: string, repo: string, stichtag = "2026-10-23T12:00:00+02:00"): string {
  const p = join(dir, "eval.config.json");
  writeFileSync(
    p,
    JSON.stringify({
      planVersion: "t",
      teams: { a: { name: "A", repo } },
      sprints: [{ id: "s1", phase: "P1", start: "2026-10-16", stichtag }],
      scope: { app: ["src/**/*.ts"], tests: ["**/*.test.ts"] },
    }),
  );
  return p;
}

describe("Git", () => {
  it("zählt Bot-Commits nicht als Teamarbeit", async () => {
    const repo = makeRepo([
      { name: "Anna", email: "anna@x", date: "2026-10-17T10:00:00+02:00", msg: "feat" },
      { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date: "2026-10-18T10:00:00+02:00", msg: "chore(deps)" },
    ]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const { config } = loadConfig(writeCfg(tmp(), repo));
    const ctx = { config, team: config.teams.a!, teamId: "a", sprint: config.sprints[0]!, repoDir: repo, rawDir: tmp(), dataDir: tmp(), commit: head, log: () => {} } as unknown as CollectorContext;
    const res = await gitCollector.collect(ctx);
    expect(res.metrics!.commits).toBe(1);
    expect(res.metrics!.persons.map((p) => p.person)).toEqual(["Anna"]);
    expect(res.warnings.some((w) => w.includes("Bot-Commit"))).toBe(true);
  });
});

describe("Snapshot", () => {
  it("verweigert die Wiederverwendung, wenn der Stichtag geändert wurde", async () => {
    const repo = makeRepo([{ name: "Anna", email: "anna@x", date: "2026-10-17T10:00:00+02:00", msg: "feat" }]);
    const dir = tmp();
    const opts = { teamId: "a", sprintId: "s1", only: ["git"], log: () => {} };
    await measure(loadConfig(writeCfg(dir, repo)), opts);
    await expect(measure(loadConfig(writeCfg(dir, repo, "2026-10-24T12:00:00+02:00")), opts)).rejects.toThrow(/Stichtag .* geändert/);
    // Mit --refresh ist es erlaubt
    await expect(measure(loadConfig(writeCfg(dir, repo, "2026-10-24T12:00:00+02:00")), { ...opts, refresh: true })).resolves.toBeTruthy();
  });
});

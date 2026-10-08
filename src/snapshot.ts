/**
 * Snapshot: Arbeitskopie eines Team-Repos im Stand zum Sprint-Stichtag.
 *
 * Regel aus dem Evaluationsplan: maßgeblich ist der letzte Commit auf dem Hauptbranch vor dem
 * Stichtag. Wichtig ist `--first-parent`: Ohne diese Option könnte `git rev-list --before` einen
 * Commit aus einem Feature-Branch liefern, der zum Stichtag zwar schon existierte, aber erst später
 * nach main gemergt wurde. Mit `--first-parent` wird nur die Kette der Commits betrachtet, die
 * tatsächlich auf main lagen (direkte Commits und Merge-Commits).
 *
 * Bereits ermittelte Snapshots werden wiederverwendet (snapshot.json), damit eine erneute Messung
 * denselben Stand misst, auch wenn das Team inzwischen weiter committet hat.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SprintConfig, TeamConfig } from "./config.js";
import { run, runOrThrow } from "./lib/exec.js";

export interface SnapshotInfo {
  teamId: string;
  sprintId: string;
  repo: string;
  branch: string;
  stichtag: string;
  commit: string;
  commitDate: string;
  commitSubject: string;
  /** Neuester Commit des Hauptbranches zum Messzeitpunkt (zur Dokumentation) */
  branchHeadAtMeasurement: string;
  createdAt: string;
}

/** Entfernt Zugangsdaten aus einer URL, bevor sie in Ergebnisdateien geschrieben wird. */
export function sanitizeRepoUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@/]+@/i, "$1");
}

export async function createSnapshot(opts: {
  baseDir: string;
  teamId: string;
  team: TeamConfig;
  sprint: SprintConfig;
  resultsDir: string;
  refresh: boolean;
  log: (m: string) => void;
}): Promise<{ info: SnapshotInfo; repoDir: string }> {
  const { teamId, team, sprint, log } = opts;
  const workDir = join(opts.baseDir, "work", teamId, sprint.id);
  const repoDir = join(workDir, "repo");
  const snapshotFile = join(opts.resultsDir, "snapshot.json");
  const logFile = join(opts.resultsDir, "raw", "snapshot.log");
  mkdirSync(join(opts.resultsDir, "raw"), { recursive: true });

  const previous: SnapshotInfo | null =
    !opts.refresh && existsSync(snapshotFile) ? (JSON.parse(readFileSync(snapshotFile, "utf8")) as SnapshotInfo) : null;

  // Immer frisch klonen: verhindert Reste früherer Läufe (node_modules, Build-Artefakte) in der Messung
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const source = resolveRepoSource(team.repo, opts.baseDir);
  log(`Klone ${sanitizeRepoUrl(team.repo)} …`);
  await runOrThrow("git", ["clone", "--quiet", "--no-checkout", source, repoDir], {
    cwd: workDir,
    logFile,
    timeoutMs: 10 * 60_000,
    env: githubAuthEnv(source),
  });

  const remoteRef = `refs/remotes/origin/${team.branch}`;
  const head = (await runOrThrow("git", ["rev-parse", remoteRef], { cwd: repoDir, logFile })).stdout.trim();

  let commit: string;
  if (previous) {
    commit = previous.commit;
    const exists = await run("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoDir, logFile });
    if (exists.exitCode !== 0) {
      throw new Error(
        `Gespeicherter Snapshot-Commit ${commit} existiert im Repo nicht mehr (Historie umgeschrieben?). ` +
          `Mit --refresh neu bestimmen und im Änderungsprotokoll vermerken.`,
      );
    }
    log(`Verwende gespeicherten Snapshot ${commit.slice(0, 10)}`);
  } else {
    const res = await runOrThrow(
      "git",
      ["rev-list", "-1", "--first-parent", `--before=${sprint.stichtag}`, remoteRef],
      { cwd: repoDir, logFile },
    );
    commit = res.stdout.trim();
    if (!commit) throw new Error(`Kein Commit auf ${team.branch} vor dem Stichtag ${sprint.stichtag}`);
    log(`Snapshot-Commit vor ${sprint.stichtag}: ${commit.slice(0, 10)}`);
  }

  await runOrThrow("git", ["checkout", "--quiet", "--detach", commit], { cwd: repoDir, logFile });
  const meta = (
    await runOrThrow("git", ["show", "-s", "--format=%cI%x00%s", commit], { cwd: repoDir, logFile })
  ).stdout.trim();
  const [commitDate = "", commitSubject = ""] = meta.split("\0");

  const info: SnapshotInfo = {
    teamId,
    sprintId: sprint.id,
    repo: sanitizeRepoUrl(team.repo),
    branch: team.branch,
    stichtag: sprint.stichtag,
    commit,
    commitDate,
    commitSubject,
    branchHeadAtMeasurement: head,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  writeFileSync(snapshotFile, JSON.stringify(info, null, 2) + "\n");
  return { info, repoDir };
}

/** Lokale Pfade werden relativ zur Konfiguration aufgelöst, URLs bleiben unverändert. */
function resolveRepoSource(repo: string, baseDir: string): string {
  if (/^(https?|ssh|git|file):\/\//.test(repo) || /^[\w.-]+@[\w.-]+:/.test(repo)) return repo;
  return repo.startsWith("/") ? repo : join(baseDir, repo);
}

/**
 * Zugang zu privaten GitHub-Repos über GITHUB_TOKEN, ohne dass der Token in URL, Logdatei oder
 * Ergebnis landet: Git liest den Header aus Umgebungsvariablen (GIT_CONFIG_COUNT/KEY/VALUE),
 * dasselbe Verfahren wie actions/checkout.
 */
export function githubAuthEnv(source: string): NodeJS.ProcessEnv {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !/^https:\/\/github\.com\//i.test(source)) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Collector "git": Analyse der Git-Historie bis zum Snapshot-Commit.
 *
 * Grundlage sind alle Commits, die vom Snapshot-Commit aus erreichbar sind und deren Autor-Datum im
 * Sprint-Zeitfenster liegt (also Arbeit, die bis zum Stichtag auf main angekommen ist).
 *
 * Personen werden über eine Mailmap-Datei (data/<team>/mailmap, Git-Format) zusammengeführt, damit
 * jemand mit zwei E-Mail-Adressen nicht als zwei Personen zählt.
 *
 * Wichtige Grenze: Lokal ist ein per "Squash" oder "Rebase" gemergter Pull Request nicht von einem
 * direkten Commit auf main zu unterscheiden. Der Wert `firstParentNonMerge` ist deshalb nur zusammen mit
 * dem Collector "github" (PR-Zuordnung) als "direkte Commits ohne PR" interpretierbar.
 *
 * Laut Evaluationsplan werden aus Commits und Zeilen KEINE Produktivitätsaussagen abgeleitet.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runOrThrow } from "../lib/exec.js";
import { matcher } from "../lib/files.js";
import { median, p90, ratio, round, roundOrNull } from "../lib/stats.js";
import { HOUR, inWindow, localDay, sprintWindow } from "../lib/time.js";
import { type Collector, ok } from "./types.js";

export interface GitCommit {
  hash: string;
  author: string;
  email: string;
  authorTime: number;
  commitTime: number;
  parents: string[];
  message: string;
  added: number;
  deleted: number;
  files: number;
  coAuthors: string[];
}

export interface PersonStats {
  person: string;
  commits: number;
  activeDays: number;
  linesAdded: number;
  linesDeleted: number;
  commitSharePercent: number | null;
  lineSharePercent: number | null;
}

export interface GitMetrics {
  window: { from: string; to: string };
  commits: number;
  mergeCommits: number;
  persons: PersonStats[];
  commitsPerPersonPerDay: number | null;
  commitSize: { median: number | null; p90: number | null };
  aiCoAuthored: { commits: number; percent: number | null };
  mainline: {
    /** Merge-Commits auf der ersten Elternlinie von main (= gemergte Branches) */
    merges: number;
    /** Nicht-Merge-Commits auf der ersten Elternlinie (direkt, gesquasht oder rebased) */
    firstParentNonMerge: number;
    branchLifetimeHours: { median: number | null; p90: number | null; max: number | null };
    mergedBranches: { name: string; lifetimeHours: number; commits: number }[];
  };
  features: {
    integrated: { id: string; firstCommit: string; integrated: string; leadTimeHours: number }[];
    leadTimeHoursMedian: number | null;
  };
  /** Zum Messzeitpunkt existierende Remote-Branches, die nicht im Snapshot enthalten sind */
  openBranchesAtMeasurement: number;
}

const SEP_RECORD = "\x1e";
const SEP_FIELD = "\x1f";

export const gitCollector: Collector<GitMetrics> = {
  name: "git",
  description: "Commits, aktive Tage, Commit-Größe, Beitragsanteile, Branches/Merges, KI-Co-Autoren, Feature-Durchlaufzeit",
  needsInstall: false,
  async collect(ctx) {
    const { repoDir, commit, config, rawDir } = ctx;
    const warnings: string[] = [];
    const logFile = join(rawDir, "git.log");
    const mailmap = join(ctx.dataDir, "mailmap");
    const gitArgs = existsSync(mailmap) ? ["-c", `mailmap.file=${mailmap}`] : [];
    if (!existsSync(mailmap)) warnings.push("Keine Mailmap (data/<team>/mailmap): Personen mit mehreren E-Mail-Adressen zählen mehrfach");

    const all = await readCommits(repoDir, gitArgs, [commit], logFile);
    const isExcluded = matcher(config.git.exclude);
    const w = sprintWindow(ctx.sprint);
    const inSprint = all.filter((c) => inWindow(c.authorTime, w));
    const nonMerge = inSprint.filter((c) => c.parents.length < 2);
    const aiPattern = new RegExp(config.git.aiCoAuthorPattern, "i");

    // Zeilen je Commit ohne ausgeschlossene Pfade neu berechnen
    const numstat = await readNumstat(repoDir, gitArgs, commit);
    for (const c of nonMerge) {
      const entries = numstat.get(c.hash) ?? [];
      const kept = entries.filter((e) => !isExcluded(e.path));
      c.added = kept.reduce((s, e) => s + e.added, 0);
      c.deleted = kept.reduce((s, e) => s + e.deleted, 0);
      c.files = kept.length;
    }

    // ---------- Personen ----------
    const byPerson = new Map<string, GitCommit[]>();
    for (const c of nonMerge) byPerson.set(c.author, [...(byPerson.get(c.author) ?? []), c]);
    const totalLines = nonMerge.reduce((s, c) => s + c.added + c.deleted, 0);
    const persons: PersonStats[] = [...byPerson.entries()]
      .map(([person, list]) => {
        const lines = list.reduce((s, c) => s + c.added + c.deleted, 0);
        return {
          person,
          commits: list.length,
          activeDays: new Set(list.map((c) => localDay(c.authorTime))).size,
          linesAdded: list.reduce((s, c) => s + c.added, 0),
          linesDeleted: list.reduce((s, c) => s + c.deleted, 0),
          commitSharePercent: ratio(list.length * 100, nonMerge.length, 1),
          lineSharePercent: ratio(lines * 100, totalLines, 1),
        };
      })
      .sort((a, b) => b.commits - a.commits);
    const windowDays = Math.max(1, (w.to - w.from) / (24 * HOUR)); // exakte Länge in Tagen (z. B. 7,5)

    // ---------- Hauptlinie: Merges und Branch-Lebensdauer ----------
    const firstParent = new Set(
      (await runOrThrow("git", [...gitArgs, "rev-list", "--first-parent", commit], { cwd: repoDir, logFile })).stdout.trim().split("\n"),
    );
    const byHash = new Map(all.map((c) => [c.hash, c]));
    const mainline = inSprintByCommitTime(all.filter((c) => firstParent.has(c.hash)), w);
    const merges = mainline.filter((c) => c.parents.length >= 2);
    const mergedBranches: GitMetrics["mainline"]["mergedBranches"] = [];
    for (const m of merges) {
      const branchCommits = await commitsOfMerge(repoDir, gitArgs, m, byHash, logFile);
      if (branchCommits.length === 0) continue;
      const oldest = Math.min(...branchCommits.map((c) => c.authorTime));
      mergedBranches.push({
        name: branchNameFromMerge(m.message) ?? m.hash.slice(0, 10),
        lifetimeHours: round((m.commitTime - oldest) / HOUR, 1),
        commits: branchCommits.length,
      });
    }
    const lifetimes = mergedBranches.map((b) => b.lifetimeHours);

    // ---------- Feature-Durchlaufzeit ----------
    const features = await featureLeadTimes(ctx, gitArgs, all, firstParent, byHash, w, logFile);

    // ---------- Offene Branches ----------
    const remoteBranches = (
      await runOrThrow("git", ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"], { cwd: repoDir, logFile })
    ).stdout
      .trim()
      .split("\n")
      .filter((r) => r && !r.endsWith("/HEAD") && r !== `refs/remotes/origin/${ctx.team.branch}`);
    let open = 0;
    for (const ref of remoteBranches) {
      const res = await runOrThrow("git", ["rev-list", "--count", `${commit}..${ref}`], { cwd: repoDir, logFile });
      if (Number(res.stdout.trim()) > 0) open++;
    }

    const aiCommits = nonMerge.filter((c) => c.coAuthors.some((a) => aiPattern.test(a))).length;
    const sizes = nonMerge.map((c) => c.added + c.deleted);
    if (merges.length === 0 && mainline.length > 0) {
      warnings.push("Keine Merge-Commits auf main: Squash/Rebase-Merges sind lokal nicht von direkten Commits unterscheidbar (siehe Collector github)");
    }

    return ok<GitMetrics>(
      {
        window: { from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() },
        commits: nonMerge.length,
        mergeCommits: inSprint.length - nonMerge.length,
        persons,
        commitsPerPersonPerDay: persons.length ? ratio(nonMerge.length, persons.length * windowDays) : null,
        commitSize: { median: roundOrNull(median(sizes), 1), p90: roundOrNull(p90(sizes), 1) },
        aiCoAuthored: { commits: aiCommits, percent: ratio(aiCommits * 100, nonMerge.length, 1) },
        mainline: {
          merges: merges.length,
          firstParentNonMerge: mainline.length - merges.length,
          branchLifetimeHours: {
            median: roundOrNull(median(lifetimes), 1),
            p90: roundOrNull(p90(lifetimes), 1),
            max: lifetimes.length ? Math.max(...lifetimes) : null,
          },
          mergedBranches,
        },
        features,
        openBranchesAtMeasurement: open,
      },
      { git: (await runOrThrow("git", ["--version"], { cwd: repoDir })).stdout.trim() },
      warnings,
    );
  },
};

/** Commits der Hauptlinie werden nach dem Commit-Datum (Zeitpunkt der Integration) dem Sprint zugeordnet. */
function inSprintByCommitTime(list: GitCommit[], w: { from: number; to: number }) {
  return list.filter((c) => inWindow(c.commitTime, w));
}

export async function readCommits(repoDir: string, gitArgs: string[], revs: string[], logFile?: string): Promise<GitCommit[]> {
  const format = [SEP_RECORD + "%H", "%aN", "%aE", "%aI", "%cI", "%P", "%B"].join(SEP_FIELD);
  // Kein Logfile: die Ausgabe ist groß und steht ohnehin im Repo
  void logFile;
  const res = await runOrThrow("git", [...gitArgs, "log", "--use-mailmap", `--format=${format}`, ...revs], { cwd: repoDir });
  return parseLog(res.stdout);
}

export function parseLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of stdout.split(SEP_RECORD)) {
    if (!record.trim()) continue;
    const [hash, author, email, aI, cI, parents, ...rest] = record.split(SEP_FIELD);
    const message = rest.join(SEP_FIELD).trim();
    commits.push({
      hash: hash!.trim(),
      author: author ?? "",
      email: (email ?? "").toLowerCase(),
      authorTime: Date.parse(aI ?? ""),
      commitTime: Date.parse(cI ?? ""),
      parents: (parents ?? "").trim() ? (parents ?? "").trim().split(" ") : [],
      message,
      added: 0,
      deleted: 0,
      files: 0,
      coAuthors: [...message.matchAll(/^co-authored-by:\s*(.+)$/gim)].map((m) => m[1]!.trim()),
    });
  }
  return commits;
}

/** Liest Zeilenänderungen je Commit und Datei (ohne Merge-Commits). */
async function readNumstat(repoDir: string, gitArgs: string[], commit: string) {
  const res = await runOrThrow("git", [...gitArgs, "log", "--no-merges", "--numstat", "--format=" + SEP_RECORD + "%H", commit], {
    cwd: repoDir,
  });
  return parseNumstat(res.stdout);
}

export function parseNumstat(stdout: string): Map<string, { path: string; added: number; deleted: number }[]> {
  const result = new Map<string, { path: string; added: number; deleted: number }[]>();
  for (const record of stdout.split(SEP_RECORD)) {
    const lines = record.split("\n");
    const hash = lines.shift()?.trim();
    if (!hash) continue;
    const entries: { path: string; added: number; deleted: number }[] = [];
    for (const line of lines) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      entries.push({
        path: normalizeRenamePath(m[3]!),
        added: m[1] === "-" ? 0 : Number(m[1]), // "-" = Binärdatei
        deleted: m[2] === "-" ? 0 : Number(m[2]),
      });
    }
    result.set(hash, entries);
  }
  return result;
}

/** "src/{alt => neu}/x.ts" bzw. "alt => neu" auf den neuen Pfad abbilden. */
export function normalizeRenamePath(p: string): string {
  const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (braces) return (braces[1]! + braces[3]! + braces[4]!).replace(/\/\//g, "/");
  const plain = /^(.*) => (.*)$/.exec(p);
  return plain ? plain[2]! : p;
}

/** Commits, die durch einen Merge-Commit in die Hauptlinie gekommen sind (m^1..m^2). */
async function commitsOfMerge(
  repoDir: string,
  gitArgs: string[],
  merge: GitCommit,
  byHash: Map<string, GitCommit>,
  logFile: string,
): Promise<GitCommit[]> {
  const [p1, p2] = merge.parents;
  if (!p1 || !p2) return [];
  const res = await runOrThrow("git", [...gitArgs, "rev-list", `${p1}..${p2}`], { cwd: repoDir, logFile });
  return res.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((h) => byHash.get(h))
    .filter((c): c is GitCommit => c !== undefined);
}

/** Branch-Namen aus Standard-Merge-Nachrichten von Git und GitHub ermitteln. */
export function branchNameFromMerge(message: string): string | null {
  const gh = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/m.exec(message);
  if (gh) return gh[1]!;
  const git = /^Merge (?:remote-tracking )?branch '([^']+)'/m.exec(message);
  return git ? git[1]!.replace(/^origin\//, "") : null;
}

/**
 * Durchlaufzeit je Feature: vom ersten Commit, der die Feature-ID nennt (oder auf einem Branch mit der
 * ID im Namen liegt), bis zur Integration in main (Commit-Datum des Hauptlinien-Commits).
 * Berichtet werden Features, deren Integration im Sprint-Zeitfenster liegt.
 */
async function featureLeadTimes(
  ctx: Parameters<Collector["collect"]>[0],
  gitArgs: string[],
  all: GitCommit[],
  firstParent: Set<string>,
  byHash: Map<string, GitCommit>,
  w: { from: number; to: number },
  logFile: string,
): Promise<GitMetrics["features"]> {
  const idPattern = new RegExp(ctx.config.git.featureIdPattern, "gi");
  const ids = (text: string) => [...new Set([...text.matchAll(idPattern)].map((m) => m[0].toUpperCase()))];
  const first = new Map<string, number>();
  const integrated = new Map<string, number>();
  const noteFirst = (id: string, t: number) => first.set(id, Math.min(first.get(id) ?? Infinity, t));

  for (const c of all) for (const id of ids(c.message)) noteFirst(id, c.authorTime);
  for (const c of all.filter((x) => firstParent.has(x.hash))) {
    const branch = c.parents.length >= 2 ? (branchNameFromMerge(c.message) ?? "") : "";
    const found = new Set([...ids(c.message), ...ids(branch)]);
    if (c.parents.length >= 2) {
      const branchCommits = await commitsOfMerge(ctx.repoDir, gitArgs, c, byHash, logFile);
      for (const id of ids(branch)) for (const bc of branchCommits) noteFirst(id, bc.authorTime);
      for (const bc of branchCommits) for (const id of ids(bc.message)) found.add(id);
    }
    for (const id of found) {
      noteFirst(id, c.authorTime);
      integrated.set(id, Math.max(integrated.get(id) ?? 0, c.commitTime));
    }
  }
  const list = [...integrated.entries()]
    .filter(([, t]) => inWindow(t, w))
    .map(([id, t]) => ({
      id,
      firstCommit: new Date(first.get(id)!).toISOString(),
      integrated: new Date(t).toISOString(),
      leadTimeHours: round((t - first.get(id)!) / HOUR, 1),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "de", { numeric: true }));
  return { integrated: list, leadTimeHoursMedian: roundOrNull(median(list.map((f) => f.leadTimeHours)), 1) };
}

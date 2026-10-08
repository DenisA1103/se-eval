/**
 * Collector "github": Pull Requests und Reviews über die GitHub-REST-API (nur lesend).
 *
 * Voraussetzungen: `github: "owner/repo"` beim Team und ein Token in der Umgebungsvariable
 * GITHUB_TOKEN (Fine-grained Token mit Lesezugriff auf "Pull requests" und "Contents").
 * Ohne Token funktioniert es nur bei öffentlichen Repos und mit 60 Anfragen pro Stunde.
 *
 * Zusätzlich wird bestimmt, welche Commits der Hauptlinie zu keinem PR gehören ("direkte Commits").
 * Das korrigiert die lokale Git-Analyse, die gesquashte PRs nicht erkennen kann.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { runOrThrow } from "../lib/exec.js";
import { median, p90, ratio, round, roundOrNull } from "../lib/stats.js";
import { HOUR, inWindow, sprintWindow } from "../lib/time.js";
import { parseLog } from "./git.js";
import { type Collector, ok, skipped } from "./types.js";

interface PullListItem {
  number: number;
  merged_at: string | null;
  created_at: string;
  merge_commit_sha: string | null;
  base: { ref: string };
  user: { login: string } | null;
}
interface PullDetail extends PullListItem {
  comments: number;
  review_comments: number;
  commits: number;
}
interface Review {
  user: { login: string } | null;
  state: string;
}

export interface GithubMetrics {
  prsMerged: number;
  prsCreated: number;
  reviewedPercent: number | null;
  approvedPercent: number | null;
  commentsPerPrMedian: number | null;
  timeToMergeHours: { median: number | null; p90: number | null };
  /** Commits der Hauptlinie im Sprint, die zu keinem gemergten PR gehören */
  directCommitsWithoutPr: number;
  prs: { number: number; author: string; hoursToMerge: number; reviews: number; comments: number }[];
}

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

export const githubCollector: Collector<GithubMetrics> = {
  name: "github",
  description: "Pull Requests: Anzahl, Review-Quote, Kommentare, Zeit bis Merge, direkte Commits ohne PR (GitHub-API)",
  needsInstall: false,
  async collect(ctx) {
    if (!ctx.team.github) return skipped('Kein "github" (owner/repo) für das Team konfiguriert');
    const token = process.env.GITHUB_TOKEN;
    const w = sprintWindow(ctx.sprint);
    const warnings: string[] = token ? [] : ["Ohne GITHUB_TOKEN: nur öffentliche Repos, 60 Anfragen/Stunde"];

    const pulls: PullListItem[] = [];
    // PRs sind nach Erstellung absteigend sortiert; ältere Seiten werden nur bis vor den Sprint gelesen
    for (let page = 1; page <= 20; page++) {
      const batch = await gh<PullListItem[]>(
        `/repos/${ctx.team.github}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
        token,
      );
      pulls.push(...batch);
      if (batch.length < 100) break;
      const oldest = batch[batch.length - 1];
      if (oldest && Date.parse(oldest.created_at) < w.from - 60 * 24 * HOUR) break;
    }
    const merged = pulls.filter(
      (p) => p.merged_at && p.base.ref === ctx.team.branch && inWindow(Date.parse(p.merged_at), w),
    );
    const created = pulls.filter((p) => inWindow(Date.parse(p.created_at), w));

    const details: GithubMetrics["prs"] = [];
    let reviewed = 0;
    let approved = 0;
    for (const p of merged) {
      const [detail, reviews] = await Promise.all([
        gh<PullDetail>(`/repos/${ctx.team.github}/pulls/${p.number}`, token),
        gh<Review[]>(`/repos/${ctx.team.github}/pulls/${p.number}/reviews?per_page=100`, token),
      ]);
      const author = p.user?.login ?? "?";
      const others = reviews.filter((r) => r.user?.login && r.user.login !== author && r.state !== "PENDING");
      if (others.length > 0) reviewed++;
      if (others.some((r) => r.state === "APPROVED")) approved++;
      details.push({
        number: p.number,
        author,
        hoursToMerge: round((Date.parse(p.merged_at!) - Date.parse(p.created_at)) / HOUR, 1),
        reviews: others.length,
        comments: detail.comments + detail.review_comments,
      });
    }
    writeFileSync(join(ctx.rawDir, "github-prs.json"), JSON.stringify(details, null, 2));

    // Direkte Commits: Hauptlinie im Sprint ohne Merge-Commit und ohne zugehörigen PR
    const prShas = new Set(pulls.map((p) => p.merge_commit_sha).filter((s): s is string => !!s));
    const fp = await runOrThrow("git", ["log", "--first-parent", `--format=\x1e%H\x1f%aN\x1f%aE\x1f%aI\x1f%cI\x1f%P\x1f%B`, ctx.commit], {
      cwd: ctx.repoDir,
    });
    const direct = parseLog(fp.stdout).filter(
      (c) => c.parents.length < 2 && inWindow(c.commitTime, w) && !prShas.has(c.hash),
    ).length;

    const hours = details.map((d) => d.hoursToMerge);
    return ok<GithubMetrics>(
      {
        prsMerged: merged.length,
        prsCreated: created.length,
        reviewedPercent: ratio(reviewed * 100, merged.length, 1),
        approvedPercent: ratio(approved * 100, merged.length, 1),
        commentsPerPrMedian: roundOrNull(median(details.map((d) => d.comments)), 1),
        timeToMergeHours: { median: roundOrNull(median(hours), 1), p90: roundOrNull(p90(hours), 1) },
        directCommitsWithoutPr: direct,
        prs: details,
      },
      { "github-api": "REST v3 (2022-11-28)" },
      warnings,
    );
  },
};

async function gh<T>(path: string, token: string | undefined): Promise<T> {
  const res = await fetch(API + path, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "se-eval",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(
      `GitHub-API ${res.status} für ${path}${remaining === "0" ? " (Ratenlimit erreicht)" : ""}${res.status === 404 ? " (Repo privat? GITHUB_TOKEN prüfen)" : ""}`,
    );
  }
  return (await res.json()) as T;
}

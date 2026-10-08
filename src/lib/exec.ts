/**
 * Ausführen externer Programme mit Zeitlimit und vollständigem Mitschnitt.
 * Es wird bewusst keine Shell verwendet (keine Interpretation von Sonderzeichen in Pfaden).
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Zeitlimit in Millisekunden; danach wird der Prozess beendet */
  timeoutMs?: number;
  /** Datei, an die Befehl, stdout und stderr angehängt werden */
  logFile?: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  if (opts.logFile) {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    appendFileSync(opts.logFile, `\n$ ${[cmd, ...args].join(" ")}\n  (cwd: ${opts.cwd})\n`);
  }
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...withoutSecrets(process.env), ...opts.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      // Eigene Prozessgruppe, damit beim Timeout auch Kindprozesse (z. B. Vitest-Worker) beendet werden
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
          }, opts.timeoutMs)
        : undefined;

    const finish = (exitCode: number | null) => {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (opts.logFile) {
        appendFileSync(
          opts.logFile,
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n--- exit: ${exitCode}${timedOut ? " (Zeitlimit)" : ""}, ${durationMs} ms ---\n`,
        );
      }
      resolvePromise({ exitCode, stdout, stderr, timedOut, durationMs });
    };
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Entfernt Zugangsdaten aus der Umgebung, bevor fremder Code ausgeführt wird (npm ci mit
 * Install-Skripten, Tests, next typegen). Sonst könnte Code aus einem Team-Repo z. B. den
 * GITHUB_TOKEN der messenden Person auslesen. Benötigte Werte (Git-Zugang beim Klonen) werden
 * gezielt über `opts.env` übergeben.
 */
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL/i.test(k)) continue;
    result[k] = v;
  }
  return result;
}

/** Beendet einen Prozess samt Prozessgruppe. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid);
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Prozess bereits beendet
  }
}

/** Wie run(), wirft aber bei Exit-Code != 0 einen Fehler mit dem Ende von stderr. */
export async function runOrThrow(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const res = await run(cmd, args, opts);
  if (res.exitCode !== 0) {
    const tail = (res.stderr || res.stdout).trim().split("\n").slice(-15).join("\n");
    throw new Error(
      `Befehl fehlgeschlagen (${res.timedOut ? "Zeitlimit" : `Exit ${res.exitCode}`}): ${cmd} ${args.join(" ")}\n${tail}`,
    );
  }
  return res;
}

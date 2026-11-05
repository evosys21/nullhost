import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Platform } from "./types.ts";
import { readHostsFile, writeWithRetry } from "./write.ts";

const run = promisify(execFile);

/** Runs a command and resolves to its exit code (0 = success). Never throws. */
async function exitCode(cmd: string, args: string[], timeoutMs = 10_000): Promise<number> {
  try {
    await run(cmd, args, { windowsHide: true, timeout: timeoutMs });
    return 0;
  } catch (err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "number" ? c : -1;
  }
}

/** Process names of other tools known to rewrite the hosts file. */
export const OTHER_HOSTS_TOOLS: Record<string, string> = { "hm.exe": "HostsMan", "hostsman.exe": "HostsMan", "hostsmanupdater.exe": "HostsMan updater" };

/** `tasklist /FO CSV /NH` -> pid -> image name (exported for tests). */
export function parseTasklist(csv: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m) out.set(Number(m[2]), m[1]!);
  }
  return out;
}

/** The processes running now, pid -> image name; null when tasklist fails. */
export async function runningProcesses(): Promise<Map<number, string> | null> {
  try {
    return parseTasklist((await run("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout);
  } catch {
    return null;
  }
}

/** Which known hosts tools appear in `tasklist /FO CSV /NH` output (exported for tests). */
export function findHostsTools(tasklistCsv: string): string[] {
  return hostsToolsIn(parseTasklist(tasklistCsv));
}

function hostsToolsIn(processes: Map<number, string>): string[] {
  const found = new Set<string>();
  for (const image of processes.values()) {
    const name = image.toLowerCase();
    if (OTHER_HOSTS_TOOLS[name]) found.add(`${OTHER_HOSTS_TOOLS[name]} (${name})`);
  }
  return [...found];
}

/** Does a Defender exclusion list (one path per line) cover `hostsPath`? (exported for tests) */
export function exclusionCovers(exclusions: string, hostsPath: string): boolean {
  const norm = (p: string) => p.trim().toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "");
  const target = norm(hostsPath);
  return exclusions
    .split(/\r?\n/)
    .map(norm)
    .filter(Boolean)
    .some((ex) => target === ex || target.startsWith(ex + "\\"));
}

/**
 * Prints `<off>` when Defender is not the active antivirus (turned off, or passive
 * beside another one), `<none>` when it has no excluded paths, else one path per
 * line. Unelevated, ExclusionPath holds a "must be an administrator" sentence in
 * the system's language instead of paths.
 */
const DEFENDER_EXCLUSIONS_SCRIPT =
  "$ErrorActionPreference='Stop'; $s = Get-MpComputerStatus; " +
  "if (-not $s.AntivirusEnabled -or $s.AMRunningMode -ne 'Normal') { '<off>' } " +
  "else { $p = (Get-MpPreference).ExclusionPath; if ($null -eq $p) { '<none>' } else { $p -join [Environment]::NewLine } }";

const ABSOLUTE = /^(?:[a-z]:\\|\\\\|%[^%]+%)/i;

/**
 * Whether the script's output shows an exclusion covering `hostsPath` (exported for
 * tests). null = could not tell: Defender is not active, the output is empty, or it
 * is not a list of paths (unelevated, in whatever language Windows uses).
 */
export function readDefenderExclusions(stdout: string, hostsPath: string): boolean | null {
  const out = stdout.trim();
  if (out === "<none>") return false;
  if (!out || out === "<off>") return null;
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.every((l) => ABSOLUTE.test(l))) return null;
  return exclusionCovers(out, hostsPath);
}

export function windowsPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  return {
    name: "windows",
    eol: "\r\n",
    perLine: 9,
    // 26H2: ~6 s per reload. 78k (25 s) hung the DNS Client at boot on 2026-11-05.
    hardCeiling: 20_000,
    systemHostsPath: () => join(env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts"),
    // `fltmc` succeeds only in an elevated process; `net session` is the fallback if fltmc is missing
    isElevated: async () => (await exitCode("fltmc", [])) === 0 || (await exitCode("net", ["session"])) === 0,
    readHosts: readHostsFile,
    writeHosts: (path, content) => writeWithRetry(path, content),
    flushDns: async () => {
      const c = await exitCode("ipconfig", ["/flushdns"], 15_000);
      if (c !== 0) throw new Error(`ipconfig /flushdns failed (exit ${c})`);
    },
    // getaddrinfo goes through the DNS Client, which answers from its hosts-file table
    resolve: async (host) => (await lookup(host, { family: 4 })).address,
    diagnostics: {
      dnsClientRunning: async () => {
        try {
          const r = await run("sc", ["query", "dnscache"], { windowsHide: true, timeout: 10_000 });
          return /\bRUNNING\b/.test(r.stdout);
        } catch {
          return null;
        }
      },
      defenderExcludes: async (hostsPath) => {
        try {
          const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", DEFENDER_EXCLUSIONS_SCRIPT], { windowsHide: true, timeout: 30_000 });
          return readDefenderExclusions(r.stdout, hostsPath);
        } catch {
          return null; // the cmdlets failed: no Defender, or not readable here
        }
      },
      otherHostsTools: async () => {
        const processes = await runningProcesses();
        return processes ? hostsToolsIn(processes) : null;
      },
    },
  };
}

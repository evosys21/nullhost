// Only one NullHost runs at a time (Electron's single-instance lock, shared by the
// installed app, the portable copy and dev builds). A copy started while another runs
// hands its exe and version to the running one, which only brings its window up when
// they are the same copy, and otherwise offers to switch to the one just started.
import { win32 } from "node:path";
import { quoteArg } from "@nullhost/core";
import { psQuote } from "./selfupdate.ts";

export type InstanceKind = "installed" | "portable" | "dev build";

/** what a starting copy tells the running one (requestSingleInstanceLock's additionalData) */
export interface InstanceInfo {
  exe: string;
  version: string;
  kind: InstanceKind;
  /** its command line after the exe (--hidden, --hosts-file <copy>, ...): a switch keeps them */
  args: string[];
}

const KINDS: readonly InstanceKind[] = ["installed", "portable", "dev build"];

/** the data another process sent; anything malformed is null (it is shown, so keep it plain) */
export function parseInstanceInfo(data: unknown): InstanceInfo | null {
  if (!data || typeof data !== "object") return null;
  const { exe, version, kind, args } = data as Record<string, unknown>;
  if (typeof exe !== "string" || !win32.isAbsolute(exe) || exe.length > 1024) return null;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (!KINDS.includes(kind as InstanceKind)) return null;
  if (!Array.isArray(args) || args.length > 32 || !args.every((a) => typeof a === "string" && a.length <= 1024)) return null;
  return { exe, version, kind: kind as InstanceKind, args: args as string[] };
}

/** another copy or another version (Windows paths compare without case) */
export function differentCopy(running: InstanceInfo, started: InstanceInfo): boolean {
  return win32.resolve(running.exe).toLowerCase() !== win32.resolve(started.exe).toLowerCase() || running.version !== started.version;
}

export const describe = (i: InstanceInfo) => `NullHost ${i.version} (${i.kind})`;

/** a dev build's exe is electron.exe, which needs the app folder too: switch only to a real copy */
export const canSwitchTo = (i: InstanceInfo) => i.kind !== "dev build" && win32.basename(i.exe).toLowerCase() === "nullhost.exe";

/**
 * What starts the other copy once this one has quit (it would only hit the lock again
 * while this one runs): wait for this process to end, then start that exe with the
 * arguments it was started with.
 */
export function switchScript(pid: number, started: Pick<InstanceInfo, "exe" | "args">): string {
  const args = started.args.length ? ` -ArgumentList ${psQuote(started.args.map(quoteArg).join(" "))}` : "";
  return `try { Wait-Process -Id ${pid} -Timeout 30 } catch {}; Start-Process -FilePath ${psQuote(started.exe)}${args}`;
}

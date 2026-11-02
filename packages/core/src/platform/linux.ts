import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Platform } from "./types.ts";
import { readHostsFile, writeWithRetry } from "./write.ts";

const run = promisify(execFile);

/**
 * Linux is a later milestone (M6). This works when run as root; the pkexec helper
 * and polkit rule from the proposal are not built yet.
 */
export function linuxPlatform(): Platform {
  return {
    name: "linux",
    eol: "\n",
    perLine: 1,
    hardCeiling: 1_000_000,
    systemHostsPath: () => "/etc/hosts",
    isElevated: async () => process.getuid?.() === 0,
    readHosts: readHostsFile,
    writeHosts: (path, content) => writeWithRetry(path, content, { timeoutMs: 5_000 }),
    flushDns: async () => {
      try {
        await run("resolvectl", ["flush-caches"], { timeout: 10_000 });
      } catch {
        /* no systemd-resolved: nothing caches /etc/hosts */
      }
    },
  };
}

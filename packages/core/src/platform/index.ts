import { linuxPlatform } from "./linux.ts";
import type { Platform } from "./types.ts";
import { windowsPlatform } from "./windows.ts";

export type { Platform, WriteReport } from "./types.ts";
export { writeWithRetry, readHostsFile, type WriteDeps, type WriteOptions } from "./write.ts";
export { windowsPlatform } from "./windows.ts";
export { linuxPlatform } from "./linux.ts";
export { windowsScheduler, updateTaskXml, parseTaskStatus, quoteArg, UPDATE_TASK, updateTaskName, sameAccount, type Scheduler, type ScheduledCommand } from "./schedule.ts";
export { exclusionCovers, findHostsTools, parseTasklist, runningProcesses, OTHER_HOSTS_TOOLS } from "./windows.ts";
export { windowsDnsLog, setDnsLog, queryArgs, type DnsLogAction, type DnsLogReader } from "./dnslog.ts";

export function currentPlatform(): Platform {
  if (process.platform === "win32") return windowsPlatform();
  if (process.platform === "linux") return linuxPlatform();
  throw new Error(`unsupported platform: ${process.platform}`);
}

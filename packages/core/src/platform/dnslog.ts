// Windows' DNS Client log through wevtutil. Reading needs no administrator
// rights (interactive users may read the channel); switching it on or off and
// clearing it do, so the desktop app runs `setDnsLog` in its elevated helper.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DNS_LOG_CHANNEL, DNS_LOG_SIZE, DNS_QUERY_COMPLETED, parseDnsEvents, parseLogState, type DnsEvent, type DnsLogState } from "../dnslog.ts";

const run = promisify(execFile);
const opts = { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 };

export type DnsLogAction = "enable" | "disable" | "clear";

/** Reads the log; the desktop app passes a fake in tests. */
export interface DnsLogReader {
  state(): Promise<DnsLogState | null>;
  /** the newest `max` lookups after record `after`, oldest first */
  read(after: number, max: number): Promise<DnsEvent[]>;
  /** pid -> program file name, for the processes running now */
  processes(): Promise<Map<number, string>>;
}

/** `wevtutil qe` arguments for lookups after `after` (exported for tests). */
export function queryArgs(after: number, max: number): string[] {
  const filter = `*[System[(EventID=${DNS_QUERY_COMPLETED}) and (EventRecordID>${Math.max(0, Math.floor(after))})]]`;
  return ["qe", DNS_LOG_CHANNEL, `/q:${filter}`, "/rd:true", `/c:${Math.max(1, Math.floor(max))}`, "/f:xml"];
}

/** `tasklist /FO CSV /NH` -> pid -> image name (exported for tests). */
export function parseTasklist(csv: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m) out.set(Number(m[2]), m[1]!);
  }
  return out;
}

export const windowsDnsLog: DnsLogReader = {
  async state() {
    try {
      return parseLogState((await run("wevtutil", ["gl", DNS_LOG_CHANNEL], opts)).stdout);
    } catch {
      return null;
    }
  },
  async read(after, max) {
    const r = await run("wevtutil", queryArgs(after, max), opts);
    // newest first from /rd:true, so the newest `max` survive a burst; the table wants oldest first
    return parseDnsEvents(r.stdout).reverse();
  },
  async processes() {
    try {
      return parseTasklist((await run("tasklist", ["/FO", "CSV", "/NH"], opts)).stdout);
    } catch {
      return new Map();
    }
  },
};

/**
 * Switch the log on (and grow it to 16 MB, about a day of lookups) or off, or clear it.
 * Off keeps what was logged until it is cleared; Windows may refuse to shrink a log below its current size.
 * Needs administrator rights.
 */
export async function setDnsLog(action: DnsLogAction): Promise<void> {
  if (action === "enable") await run("wevtutil", ["sl", DNS_LOG_CHANNEL, "/e:true", `/ms:${DNS_LOG_SIZE}`], opts);
  else if (action === "disable") await run("wevtutil", ["sl", DNS_LOG_CHANNEL, "/e:false"], opts);
  else if (action === "clear") await run("wevtutil", ["cl", DNS_LOG_CHANNEL], opts);
  else throw new Error(`unknown DNS log action: ${String(action)}`);
}

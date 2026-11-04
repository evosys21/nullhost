// The DNS log: what Windows' DNS Client resolved, read from its Operational
// event log, and whether NullHost blocked each name. Pure functions; the
// commands that read and switch the log live in platform/dnslog.ts.
import { allowedBy } from "./normalize.ts";
import type { AllowRule } from "./types.ts";

/** The event log the DNS Client writes one event per lookup to (off by default). */
export const DNS_LOG_CHANNEL = "Microsoft-Windows-DNS-Client/Operational";
/** "DNS query is completed for the name %1, type %2, query options %3 with status %4 Results %5" */
export const DNS_QUERY_COMPLETED = 3008;
/** while NullHost's DNS log is on */
export const DNS_LOG_SIZE = 16 * 1024 * 1024;

export interface DnsEvent {
  /** EventRecordID: grows by one per event, so the next read starts after it */
  record: number;
  /** ISO time */
  time: string;
  /** the process that asked (as the DNS Client logged it) */
  pid: number;
  /** lower case, without a trailing dot */
  name: string;
  type: number;
  /** 0 = answered; a Win32 / DNS error code otherwise */
  status: number;
  /** addresses and CNAME targets, in the order given */
  results: string[];
}

export interface DnsLogState {
  enabled: boolean;
  maxSize: number;
}

const unescape = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "amp") return "&";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });

/**
 * The QueryResults text: "::ffff:1.2.3.4;", "type:  5 cdn.example.net;::ffff:1.2.3.4;"
 * or "2a00:1450::1;". IPv4-mapped addresses come back as plain IPv4.
 */
export function parseQueryResults(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(";")) {
    const part = raw.trim();
    if (!part) continue;
    const typed = /^type:\s*\d+\s+(\S+)$/i.exec(part);
    if (typed) out.push(typed[1]!.toLowerCase().replace(/\.$/, ""));
    else out.push(part.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, ""));
  }
  return out;
}

/** `wevtutil qe <channel> /f:xml` output (one <Event> after another, no root) -> lookups. Other events are skipped. */
export function parseDnsEvents(xml: string): DnsEvent[] {
  const out: DnsEvent[] = [];
  for (const m of xml.matchAll(/<Event\b[\s\S]*?<\/Event>/g)) {
    const ev = m[0];
    const id = Number(/<EventID\b[^>]*>(\d+)<\/EventID>/.exec(ev)?.[1]);
    if (id !== DNS_QUERY_COMPLETED) continue;
    const data = new Map<string, string>();
    for (const d of ev.matchAll(/<Data Name=['"]([^'"]+)['"](?:\s*\/>|>([\s\S]*?)<\/Data>)/g)) data.set(d[1]!, unescape(d[2] ?? ""));
    const name = (data.get("QueryName") ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!name) continue;
    out.push({
      record: Number(/<EventRecordID>(\d+)<\/EventRecordID>/.exec(ev)?.[1] ?? 0),
      time: /<TimeCreated SystemTime=['"]([^'"]+)['"]/.exec(ev)?.[1] ?? "",
      pid: Number(/<Execution ProcessID=['"](\d+)['"]/.exec(ev)?.[1] ?? 0),
      name,
      type: Number(data.get("QueryType") ?? 0),
      status: Number(data.get("QueryStatus") ?? 0),
      results: parseQueryResults(data.get("QueryResults") ?? ""),
    });
  }
  return out;
}

/** `wevtutil gl <channel>` output -> on/off and size; null when it does not look like that output. */
export function parseLogState(text: string): DnsLogState | null {
  const enabled = /^\s*enabled:\s*(true|false)\s*$/im.exec(text)?.[1];
  if (!enabled) return null;
  const size = Number(/^\s*maxSize:\s*(\d+)\s*$/im.exec(text)?.[1]);
  return { enabled: enabled.toLowerCase() === "true", maxSize: Number.isFinite(size) ? size : 0 };
}

const TYPES: Record<number, string> = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 64: "SVCB", 65: "HTTPS", 255: "ANY" };

export function dnsTypeName(type: number): string {
  return TYPES[type] ?? `type ${type}`;
}

const STATUS: Record<number, string> = {
  0: "",
  87: "invalid parameter",
  123: "invalid name",
  1168: "not found",
  1214: "invalid name",
  1460: "timed out",
  9002: "server failure",
  9003: "no such name",
  9005: "refused",
  9501: "no records of this type",
  9560: "no such name",
  9701: "no records",
  11001: "not found",
};

export function dnsStatusText(status: number): string {
  return STATUS[status] ?? `error ${status}`;
}

/** What the log needs to know about blocking, built once and reused for every row. */
export interface BlockIndex {
  /** in NullHost's region of the hosts file right now */
  region: Set<string>;
  /** the user's own entries outside the region */
  own: Set<string>;
  /** host -> names of the enabled sources listing it */
  owners: Map<string, string[]>;
  /** host -> names of the enabled sources listing it, for hosts the allowlist lets through */
  allowlisted: Map<string, string[]>;
  rules: AllowRule[];
}

/** blocked: by NullHost; own: by your own entry outside the region; elsewhere: answered 0.0.0.0 by something else (your DNS server, another tool) */
export type DnsVerdict = "blocked" | "own" | "elsewhere" | "allowed" | "resolved" | "failed";

export interface DnsLogEntry extends DnsEvent {
  verdict: DnsVerdict;
  typeName: string;
  /** set when status is not 0 */
  statusText?: string;
  /** the lists that block it (blocked), or would without the allowlist (allowed) */
  listedBy?: string[];
  allowedBy?: string;
  /** the program's file name, when it was still running */
  process?: string;
}

const SINKS = new Set(["0.0.0.0", "127.0.0.1", "::", "::1"]);

/**
 * One lookup -> what happened to it. NullHost's region wins: an AAAA lookup for
 * a blocked name usually comes back as "no records", but it was still blocked.
 */
export function classify(e: DnsEvent, idx: BlockIndex, process?: string): DnsLogEntry {
  const base: DnsLogEntry = { ...e, verdict: "resolved", typeName: dnsTypeName(e.type), process };
  if (e.status !== 0) base.statusText = dnsStatusText(e.status);
  if (idx.region.has(e.name)) return { ...base, verdict: "blocked", listedBy: idx.owners.get(e.name) ?? [] };
  if (idx.own.has(e.name)) return { ...base, verdict: "own" };
  const allowed = idx.allowlisted.get(e.name);
  if (allowed) return { ...base, verdict: "allowed", listedBy: allowed, allowedBy: allowedBy(e.name, idx.rules)?.pattern };
  // a sinkhole answer NullHost did not give: the DNS server (Pi-hole, AdGuard, a router) or another tool
  if (e.status === 0 && e.results.length > 0 && e.results.every((r) => SINKS.has(r))) return { ...base, verdict: "elsewhere" };
  return { ...base, verdict: e.status === 0 ? "resolved" : "failed" };
}

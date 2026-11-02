import { findRegions } from "./render.ts";

/**
 * One-time clean-up of block entries left outside NullHost's region by an older
 * tool (HostsMan, a pasted list). Rule, deliberately narrow:
 *
 *   remove a host from an entry outside the region only when the entry points at
 *   a sink address (0.0.0.0, 127.0.0.1, ::, ::1) AND the region already blocks
 *   that exact host.
 *
 * Everything else stays byte for byte: comments, blank lines, other addresses,
 * dev vhosts, and blocks no enabled list covers (they are the user's own).
 */

const SINKS = new Set(["0.0.0.0", "127.0.0.1", "::", "::1"]);

export interface TidyPlan {
  /** hosts removed, by the address their entry used */
  removeSink0: number;
  removeLoopback: number;
  /** lines dropped entirely / lines rewritten with fewer hosts */
  linesDropped: number;
  linesShortened: number;
  /** sink entries kept because no enabled list covers them */
  keptOwnBlocks: number;
  linesBefore: number;
  linesAfter: number;
  sampleRemoved: string[];
  sampleKept: string[];
  /** the whole file after the clean-up */
  next: string;
}

function tidyChunk(chunk: string, covered: Set<string>, p: Omit<TidyPlan, "next" | "linesBefore" | "linesAfter">): string {
  let out = "";
  const re = /([^\r\n]*)(\r\n|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const [, line = "", eol = ""] = m;
    if (line === "" && eol === "") break;
    const hash = line.indexOf("#");
    const body = (hash >= 0 ? line.slice(0, hash) : line).trim();
    const parts = body ? body.split(/\s+/) : [];
    const ip = parts[0];
    if (!ip || parts.length < 2 || !SINKS.has(ip)) {
      out += line + eol;
      continue;
    }
    const hosts = parts.slice(1);
    const keep = hosts.filter((h) => !covered.has(h.toLowerCase()));
    const removed = hosts.length - keep.length;
    for (const h of keep) {
      p.keptOwnBlocks++;
      if (p.sampleKept.length < 10) p.sampleKept.push(h);
    }
    if (removed === 0) {
      out += line + eol;
      continue;
    }
    for (const h of hosts) {
      if (keep.includes(h)) continue;
      if (ip === "0.0.0.0" || ip === "::") p.removeSink0++;
      else p.removeLoopback++;
      if (p.sampleRemoved.length < 10) p.sampleRemoved.push(h);
    }
    if (keep.length === 0) {
      p.linesDropped++;
      continue; // the line and its line break go
    }
    p.linesShortened++;
    const comment = hash >= 0 ? " " + line.slice(hash) : "";
    const indent = /^\s*/.exec(line)![0];
    out += `${indent}${ip} ${keep.join(" ")}${comment}${eol}`;
  }
  return out;
}

/** Plan the clean-up of `text` against `covered`, the hosts the managed region blocks. */
export function planTidy(text: string, covered: Set<string>): TidyPlan {
  const p = { removeSink0: 0, removeLoopback: 0, linesDropped: 0, linesShortened: 0, keptOwnBlocks: 0, sampleRemoved: [] as string[], sampleKept: [] as string[] };
  const spans = findRegions(text);
  let next = "";
  let from = 0;
  for (const s of spans) {
    next += tidyChunk(text.slice(from, s.start), covered, p) + text.slice(s.start, s.end);
    from = s.end;
  }
  next += tidyChunk(text.slice(from), covered, p);
  const lines = (s: string) => (s ? s.split(/\r?\n/).length - (/\r?\n$/.test(s) ? 1 : 0) : 0);
  return { ...p, linesBefore: lines(text), linesAfter: lines(next), next };
}

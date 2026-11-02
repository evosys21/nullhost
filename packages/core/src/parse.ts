import type { ParseResult, ParseStats, SourceFormat } from "./types.ts";

const BLOCK_TARGETS = new Set(["0.0.0.0", "127.0.0.1", "::", "::1", "0", "127.0.0.1."]);

function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i >= 0 ? line.slice(0, i) : line).trim();
}

/** `0.0.0.0 host [host ...]`; other targets are redirects, not blocks. */
export function parseHosts(text: string): ParseResult {
  const hosts: string[] = [];
  const stats: ParseStats = { lines: 0, candidates: 0, redirects: 0, skipped: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    stats.lines++;
    const parts = line.split(/\s+/);
    if (parts.length < 2) { stats.skipped++; continue; }
    const target = parts[0]!;
    if (!BLOCK_TARGETS.has(target)) {
      // a real IP (redirect) or garbage; either way not a block for us
      stats[/^[0-9a-f:.]+$/i.test(target) ? "redirects" : "skipped"]++;
      continue;
    }
    for (let i = 1; i < parts.length; i++) { hosts.push(parts[i]!); stats.candidates++; }
  }
  return { hosts, stats };
}

/** one domain per line (HaGeZi/OISD "domains" style); wildcards are dropped. */
export function parseDomains(text: string): ParseResult {
  const hosts: string[] = [];
  const stats: ParseStats = { lines: 0, candidates: 0, redirects: 0, skipped: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    stats.lines++;
    if (/\s/.test(line) || line.startsWith("!") || line.startsWith("[") || line.includes("*")) { stats.skipped++; continue; }
    hosts.push(line); stats.candidates++;
  }
  return { hosts, stats };
}

/**
 * `$options` that keep a rule meaning "block this whole host". Anything else narrows
 * it (`$script`, `$third-party`, `$domain=`, `$dnstype=`...) or reverses it
 * (`$badfilter`), so the rule cannot become a hosts entry.
 */
const WHOLE_HOST_OPTIONS = new Set(["important", "all", "document", "doc"]);

/** AdBlock syntax: only `||host^`, optionally with whole-host `$options`, becomes a block. */
export function parseAdblock(text: string): ParseResult {
  const hosts: string[] = [];
  const stats: ParseStats = { lines: 0, candidates: 0, redirects: 0, skipped: 0 };
  const rule = /^\|\|([a-z0-9._-]+)\^(?:\$([a-z0-9,=~_.|-]+))?$/i;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    stats.lines++;
    const m = rule.exec(line);
    if (!m || line.startsWith("@@")) { stats.skipped++; continue; }
    if (m[2] && !m[2].split(",").every((o) => WHOLE_HOST_OPTIONS.has(o.toLowerCase()))) { stats.skipped++; continue; }
    hosts.push(m[1]!); stats.candidates++;
  }
  return { hosts, stats };
}

/** dnsmasq: `address=/host/0.0.0.0`, `server=/host/`, `local=/host/`. */
export function parseDnsmasq(text: string): ParseResult {
  const hosts: string[] = [];
  const stats: ParseStats = { lines: 0, candidates: 0, redirects: 0, skipped: 0 };
  const rule = /^(?:address|server|local)=\/([^/]+)\/(.*)$/;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    stats.lines++;
    const m = rule.exec(line);
    if (!m) { stats.skipped++; continue; }
    const target = m[2]!;
    if (target && !BLOCK_TARGETS.has(target) && target !== "#") { stats.redirects++; continue; }
    hosts.push(m[1]!); stats.candidates++;
  }
  return { hosts, stats };
}

export function parse(text: string, format: SourceFormat): ParseResult {
  switch (format) {
    case "hosts": return parseHosts(text);
    case "domains": return parseDomains(text);
    case "adblock": return parseAdblock(text);
    case "dnsmasq": return parseDnsmasq(text);
  }
}

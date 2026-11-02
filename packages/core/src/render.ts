// The managed region: the only part of the hosts file NullHost ever writes.
// Markers are fixed forever (changing them would orphan regions on users' machines).

export const MARK_START = "# >>> nullhost managed";
export const MARK_END = "# <<< nullhost managed <<<";

export interface RenderOptions {
  ip: string;
  /** hosts per line; Windows uses 9, Linux 1 */
  perLine: number;
  eol: "\r\n" | "\n";
  generated: Date;
  sources: Array<{ name: string; licence: string }>;
  /** "enabled" (default), "disabled" or "paused until <iso>" */
  status?: string;
}

const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");

/** Render the managed region, markers included, ending with a line break. */
export function renderRegion(hosts: string[], o: RenderOptions): string {
  const eol = o.eol;
  const perLine = Math.max(1, Math.trunc(o.perLine));
  const status = o.status ?? "enabled";
  const head: string[] = [
    `${MARK_START} (generated=${o.generated.toISOString()}, hosts=${hosts.length}, perLine=${perLine}, status=${ascii(status)}) >>>`,
  ];
  if (o.sources.length) {
    head.push(`# Sources: ${o.sources.map((s) => `${ascii(s.name)} (${ascii(s.licence)})`).join(", ")}`);
  }
  head.push("# Do not edit between the markers; NullHost rewrites this region. Your own entries outside it are preserved.");
  if (status !== "enabled") {
    head.push(`# Blocking is ${ascii(status)}. Turn it on in NullHost or with: nullhost enable`);
  }
  const lines: string[] = [];
  for (let i = 0; i < hosts.length; i += perLine) {
    lines.push(`${o.ip} ${hosts.slice(i, i + perLine).join(" ")}`);
  }
  return [...head, ...lines, MARK_END].join(eol) + eol;
}

export interface RegionSpan {
  /** index of the start marker */
  start: number;
  /** index just after the end marker's line break */
  end: number;
}

/**
 * True when the markers pair up: start, end, start, end... (or none at all). A start
 * without its end, or a stray end, makes any region boundary a guess, and a guess
 * can swallow the user's own lines on the next write.
 */
export function markersPaired(text: string): boolean {
  const marks: Array<[number, "s" | "e"]> = [];
  for (const [mark, kind] of [[MARK_START, "s"], [MARK_END, "e"]] as const) {
    for (let i = text.indexOf(mark); i >= 0; i = text.indexOf(mark, i + mark.length)) marks.push([i, kind]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  return marks.length % 2 === 0 && marks.every(([, kind], i) => kind === (i % 2 === 0 ? "s" : "e"));
}

/** All managed regions in `text`, in order. Normally zero or one; none when the markers do not pair up. */
export function findRegions(text: string): RegionSpan[] {
  if (!markersPaired(text)) return [];
  const spans: RegionSpan[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(MARK_START, from);
    if (start < 0) break;
    const endMark = text.indexOf(MARK_END, start);
    if (endMark < 0) break;
    let end = endMark + MARK_END.length;
    if (text.startsWith("\r\n", end)) end += 2;
    else if (text.startsWith("\n", end)) end += 1;
    spans.push({ start, end });
    from = end;
  }
  return spans;
}

/** The text of the first managed region, or null. */
export function extractRegion(text: string): string | null {
  const span = findRegions(text)[0];
  return span ? text.slice(span.start, span.end) : null;
}

/** Host names written inside a region (lines that are not comments). */
export function regionHosts(region: string): string[] {
  const out: string[] = [];
  for (const line of region.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.trim().split(/\s+/);
    for (let i = 1; i < parts.length; i++) out.push(parts[i]!);
  }
  return out;
}

export interface RegionHeader {
  generated?: string;
  hosts?: number;
  perLine?: number;
  status?: string;
}

export function parseRegionHeader(region: string): RegionHeader {
  const first = region.slice(0, region.search(/\r?\n/) >>> 0);
  const h: RegionHeader = {};
  const m = /\(([^)]*)\)/.exec(first);
  if (!m) return h;
  for (const part of m[1]!.split(/,\s*/)) {
    const [k, ...rest] = part.split("=");
    const v = rest.join("=");
    if (k === "generated") h.generated = v;
    else if (k === "hosts") h.hosts = Number(v);
    else if (k === "perLine") h.perLine = Number(v);
    else if (k === "status") h.status = v;
  }
  return h;
}

/**
 * Put `region` into `existing`: replace the first managed region (and drop any
 * duplicates), or append one. Every byte outside the regions is kept as it was.
 * Throws when the markers in `existing` do not pair up (see markersPaired).
 */
export function compose(existing: string, region: string, eol: "\r\n" | "\n"): string {
  if (!markersPaired(existing)) throw new Error("the NullHost markers in the hosts file do not pair up");
  const spans = findRegions(existing);
  if (spans.length === 0) {
    if (existing.length === 0) return region;
    const sep = existing.endsWith("\n") ? "" : eol;
    return existing + sep + eol + region;
  }
  let out = existing.slice(0, spans[0]!.start) + region;
  for (let i = 0; i < spans.length; i++) {
    const next = spans[i + 1];
    out += existing.slice(spans[i]!.end, next ? next.start : existing.length);
  }
  return out;
}

/** Remove every managed region (= "Remove NullHost from hosts file"). */
export function removeRegion(existing: string): string {
  const spans = findRegions(existing);
  if (spans.length === 0) return existing;
  let out = "";
  let from = 0;
  for (const s of spans) {
    // also drop the blank line compose() put in front of an appended region
    let start = s.start;
    if (existing.slice(Math.max(0, start - 4), start).match(/(\r?\n)\r?\n$/)) {
      start -= existing.slice(0, start).endsWith("\r\n") ? 2 : 1;
    }
    out += existing.slice(from, Math.max(from, start));
    from = s.end;
  }
  return out + existing.slice(from);
}

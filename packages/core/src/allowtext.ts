// Turn whatever the user pasted into allowlist patterns. No Node imports: the
// desktop renderer uses this too, for the live count under the editor.

export interface AllowText {
  /** clean patterns, in the order pasted, no duplicates */
  patterns: string[];
  /** tokens that are not a host, `*.suffix` or valid `/regex/` */
  skipped: string[];
}

// a tag in pasted XML/HTML, e.g. HostsMan's `<Rule>*.doubleclick.net</Rule>`
const TAG = /<\?[^>]*\?>|<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
const IP = /^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f]*:[0-9a-f:.]*$/i;
// letters in any script (the engine converts them to punycode), digits, `_` and `-`
const NAME = /^[\p{L}\p{N}_]([\p{L}\p{N}_-]{0,61}[\p{L}\p{N}_])?$/u;

const isRegex = (s: string) => s.length > 2 && s.startsWith("/") && s.endsWith("/");

/** One token -> a pattern, "" to drop it silently (an IP: the sink column of a hosts line), or null if unusable. */
function cleanToken(raw: string): string | null {
  let t = raw.replace(/^["'`]+|["'`]+$/g, "");
  if (isRegex(t)) {
    try {
      new RegExp(t.slice(1, -1), "i");
      return t;
    } catch {
      return null;
    }
  }
  // adblock syntax: `@@||example.com^$third-party`
  t = t.replace(/^@@/, "").replace(/^\|\|?/, "").replace(/[\^$].*$/, "");
  // a URL: keep the host
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/@]*@/, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  t = t.toLowerCase().replace(/\.$/, "");
  if (!t) return "";
  if (IP.test(t)) return "";
  // `.example.com` means the domain and its subdomains in many list formats
  const wild = t.startsWith("*.") || t.startsWith(".");
  const name = t.replace(/^\*?\./, "");
  const labels = name.split(".");
  if (name.length > 253 || labels.some((l) => !NAME.test(l))) return null;
  if (!wild && labels.length < 2) return null;
  return wild ? `*.${name}` : name;
}

/**
 * Patterns from pasted text: one per line, or separated by commas, semicolons or
 * spaces; also hosts-file lines, URLs, adblock rules and XML such as a HostsMan
 * exclusion list. `#` and `!` start comments; a line that is `/regex/` stays whole.
 */
export function parseAllowText(text: string): AllowText {
  const patterns: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const skip = (t: string) => { if (!skipped.includes(t)) skipped.push(t); };
  for (const rawLine of text.replace(TAG, "\n").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    const tokens = isRegex(line) ? [line] : line.replace(/#.*$/, "").split(/[\s,;]+/);
    for (const tok of tokens) {
      if (!tok) continue;
      const p = cleanToken(tok);
      if (p === null) skip(tok);
      else if (p && !seen.has(p)) { seen.add(p); patterns.push(p); }
    }
  }
  return { patterns, skipped };
}

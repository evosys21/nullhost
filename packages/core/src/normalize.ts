import { domainToASCII } from "node:url";
import type { AllowRule, NormalizeStats } from "./types.ts";

/** Names that must never be blocked, whatever a list says. */
export const BUILTIN_ALLOW: AllowRule[] = [
  "localhost",
  "localhost.localdomain",
  "local",
  "broadcasthost",
  "ip6-localhost",
  "ip6-loopback",
  "ip6-localnet",
  "ip6-mcastprefix",
  "ip6-allnodes",
  "ip6-allrouters",
  "ip6-allhosts",
  "0.0.0.0",
].map((h): AllowRule => ({ kind: "exact", host: h, pattern: h }))
  .concat([{ kind: "suffix", suffix: ".localhost", pattern: "*.localhost" }]);

// labels: alnum or underscore first (some lists carry `_dmarc`-style names), alnum last, max 63
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A name in the form normalizeHost gives list entries: lower case, no trailing dot, punycode. */
function asciiName(name: string): string {
  const h = name.toLowerCase().replace(/\.$/, "");
  if (/^[\x00-\x7f]*$/.test(h)) return h;
  return domainToASCII(h) || h;
}

/**
 * Parse one allowlist pattern: `host`, `*.suffix`, `/regex/`. Throws on a bad regex.
 * Host and suffix are matched in punycode, like the lists; `pattern` keeps what the user typed.
 */
export function parseAllowRule(line: string): AllowRule | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) return null;
  if (s.length > 2 && s.startsWith("/") && s.endsWith("/")) {
    return { kind: "regex", re: new RegExp(s.slice(1, -1), "i"), pattern: s };
  }
  if (s.startsWith("*.")) return { kind: "suffix", suffix: `.${asciiName(s.slice(2))}`, pattern: s };
  return { kind: "exact", host: asciiName(s), pattern: s };
}

/** Compile user patterns; invalid ones are reported, not fatal. */
export function compileAllowlist(patterns: string[]): { rules: AllowRule[]; errors: string[] } {
  const rules: AllowRule[] = [...BUILTIN_ALLOW];
  const errors: string[] = [];
  for (const p of patterns) {
    try {
      const r = parseAllowRule(p);
      if (r) rules.push(r);
    } catch (err) {
      errors.push(`${p}: ${(err as Error).message}`);
    }
  }
  return { rules, errors };
}

/** The rule that allows `host`, or null. */
export function allowedBy(host: string, rules: AllowRule[]): AllowRule | null {
  for (const r of rules) {
    if (r.kind === "exact" && host === r.host) return r;
    if (r.kind === "suffix" && (host.endsWith(r.suffix) || host === r.suffix.slice(1))) return r;
    if (r.kind === "regex" && r.re.test(host)) return r;
  }
  return null;
}

/**
 * Lower-case, strip trailing dot, IDNA -> punycode, validate labels, drop IPs and
 * bare names. Returns null for anything that is not a usable host name.
 */
export function normalizeHost(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (IPV4.test(h) || h.includes(":")) return null;
  if (!/^[\x00-\x7f]*$/.test(h)) {
    h = domainToASCII(h);
    if (!h) return null;
  }
  if (h.length > 253 || !h.includes(".")) return null;
  for (const label of h.split(".")) if (!LABEL.test(label)) return null;
  return h;
}

export function normalizeAll(
  raw: Iterable<string>,
  allow: AllowRule[] = BUILTIN_ALLOW,
): { hosts: string[]; allowlisted: string[]; stats: NormalizeStats } {
  const out: string[] = [];
  const allowlisted: string[] = [];
  const stats: NormalizeStats = { input: 0, kept: 0, invalid: 0, ip: 0, allowlisted: 0 };
  for (const r of raw) {
    stats.input++;
    const t = r.trim();
    if (IPV4.test(t)) { stats.ip++; continue; }
    // allowlist first on the cheap form: `localhost` and friends are not valid
    // public names but must still count as allowlisted, not invalid
    const cheap = t.toLowerCase().replace(/\.$/, "");
    if (allowedBy(cheap, allow)) { stats.allowlisted++; allowlisted.push(cheap); continue; }
    const h = normalizeHost(t);
    if (!h) { stats.invalid++; continue; }
    if (h !== cheap && allowedBy(h, allow)) { stats.allowlisted++; allowlisted.push(h); continue; }
    out.push(h);
    stats.kept++;
  }
  return { hosts: out, allowlisted, stats };
}

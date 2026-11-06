import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileAllowlist,
  allowedBy,
  compose,
  extractRegion,
  findRegions,
  markersPaired,
  MARK_END,
  MARK_START,
  merge,
  normalizeAll,
  normalizeHost,
  parseAdblock,
  parseConfig,
  parseDnsmasq,
  parseDomains,
  parseHosts,
  parseRegionHeader,
  regionHosts,
  removeRegion,
  renderRegion,
  sorted,
} from "../src/index.ts";

const opts = { ip: "0.0.0.0", perLine: 9, eol: "\r\n" as const, generated: new Date(0), sources: [{ name: "Test list", licence: "MIT" }] };

test("parseHosts: blocks, redirects, comments, multi-host lines", () => {
  const r = parseHosts(["# comment", "127.0.0.1 localhost", "0.0.0.0 ads.example.com   # trailing", "0.0.0.0 a.example.com b.example.com", "192.168.1.10 nas.home", "garbage", ""].join("\n"));
  assert.deepEqual(r.hosts, ["localhost", "ads.example.com", "a.example.com", "b.example.com"]);
  assert.equal(r.stats.redirects, 1);
  assert.equal(r.stats.skipped, 1);
});

test("parseDomains drops wildcards and junk", () => {
  assert.deepEqual(parseDomains("a.com\n*.b.com\n[Adblock]\n!x\nc.com # note\n").hosts, ["a.com", "c.com"]);
});

test("parseAdblock keeps only ||host^ network rules", () => {
  const r = parseAdblock("||ads.example.com^\n||t.example.com^$important\n@@||ok.example.com^\n##.banner\n/ads/*\n");
  assert.deepEqual(r.hosts, ["ads.example.com", "t.example.com"]);
  assert.equal(r.stats.skipped, 3);
});

test("parseDnsmasq", () => {
  const r = parseDnsmasq("address=/a.com/0.0.0.0\nserver=/b.com/\naddress=/c.com/10.0.0.1\n");
  assert.deepEqual(r.hosts, ["a.com", "b.com"]);
  assert.equal(r.stats.redirects, 1);
});

test("normalizeHost: case, trailing dot, idna, validation", () => {
  assert.equal(normalizeHost("ADS.Example.COM."), "ads.example.com");
  assert.equal(normalizeHost("bücher.example"), "xn--bcher-kva.example");
  assert.equal(normalizeHost("1.2.3.4"), null);
  assert.equal(normalizeHost("nodot"), null);
  assert.equal(normalizeHost("bad_.example.com"), null);
  assert.equal(normalizeHost("-bad.example.com"), null);
  assert.equal(normalizeHost("_dmarc.example.com"), "_dmarc.example.com");
});

test("allowlist: exact, suffix, regex, builtins, bad regex reported", () => {
  const { rules, errors } = compileAllowlist(["cdn.segment.com", "*.sentry.io", "/^s3-.*\\.amazonaws\\.com$/", "/([/"]);
  assert.equal(errors.length, 1);
  assert.equal(allowedBy("cdn.segment.com", rules)?.pattern, "cdn.segment.com");
  assert.equal(allowedBy("o1.ingest.sentry.io", rules)?.pattern, "*.sentry.io");
  assert.equal(allowedBy("sentry.io", rules)?.pattern, "*.sentry.io");
  assert.ok(allowedBy("s3-eu-west-1.amazonaws.com", rules));
  assert.equal(allowedBy("ads.example.com", rules), null);
  const n = normalizeAll(["localhost", "ads.example.com", "1.1.1.1", "x", "CDN.segment.com."], rules);
  assert.deepEqual(n.hosts, ["ads.example.com"]);
  assert.deepEqual(n.allowlisted, ["localhost", "cdn.segment.com"]);
  assert.equal(n.stats.ip, 1);
  assert.equal(n.stats.invalid, 1);
});

test("merge keeps owners per host; sorted groups by domain", () => {
  const m = merge([
    { id: "a", hosts: ["x.example.com", "y.example.org"] },
    { id: "b", hosts: ["x.example.com", "z.example.com"] },
  ]);
  assert.deepEqual(m.hosts.get("x.example.com"), ["a", "b"]);
  assert.equal(m.perSource.b!.unique, 1);
  assert.deepEqual(sorted(m.hosts.keys()), ["x.example.com", "z.example.com", "y.example.org"]);
});

test("renderRegion: 9 per line, header round-trips, disabled note", () => {
  const hosts = Array.from({ length: 20 }, (_, i) => `h${i}.example.com`);
  const region = renderRegion(hosts, opts);
  const body = region.split("\r\n").filter((l) => l.startsWith("0.0.0.0 "));
  assert.deepEqual(body.map((l) => l.split(" ").length - 1), [9, 9, 2]);
  assert.ok(region.startsWith(MARK_START) && region.endsWith(MARK_END + "\r\n"));
  assert.deepEqual(regionHosts(region), hosts);
  assert.deepEqual(parseRegionHeader(region), { generated: "1970-01-01T00:00:00.000Z", hosts: 20, perLine: 9, status: "enabled" });
  const off = renderRegion([], { ...opts, status: "paused until 2026-10-26T12:00:00.000Z" });
  assert.equal(parseRegionHeader(off).status, "paused until 2026-10-26T12:00:00.000Z");
  assert.match(off, /# Blocking is paused until/);
  assert.equal(regionHosts(off).length, 0);
});

test("compose: append, replace, keep every byte outside, collapse duplicates", () => {
  const before = "# header\r\n127.0.0.1 alma.local\r\n";
  const after = "127.0.0.1 trader.local\r\n";
  const r1 = renderRegion(["a.example.com"], opts);
  const r2 = renderRegion(["b.example.com"], opts);

  const appended = compose(before, r1, "\r\n");
  assert.equal(appended, before + "\r\n" + r1);

  const sandwich = before + r1 + after;
  const replaced = compose(sandwich, r2, "\r\n");
  assert.equal(replaced, before + r2 + after);

  const twoRegions = before + r1 + after + r1;
  const collapsed = compose(twoRegions, r2, "\r\n");
  assert.equal(findRegions(collapsed).length, 1);
  assert.equal(collapsed, before + r2 + after);

  assert.equal(compose("", r1, "\r\n"), r1);
  assert.equal(compose("no newline at end", r1, "\r\n"), "no newline at end\r\n\r\n" + r1);
});

test("removeRegion undoes an append exactly and keeps text after a region", () => {
  const before = "# header\r\n127.0.0.1 alma.local\r\n";
  const r = renderRegion(["a.example.com"], opts);
  assert.equal(removeRegion(compose(before, r, "\r\n")), before);
  assert.equal(removeRegion(before + r + "127.0.0.1 after.local\r\n"), before + "127.0.0.1 after.local\r\n");
  assert.equal(removeRegion(before), before);
  assert.equal(extractRegion(before), null);
});

test("unterminated region is left alone", () => {
  const broken = "# x\r\n" + MARK_START + " (hosts=1) >>>\r\n0.0.0.0 a.example.com\r\n";
  assert.equal(findRegions(broken).length, 0);
  assert.equal(removeRegion(broken), broken);
});

test("markers that do not pair up are never composed into (finding 2)", () => {
  const start = MARK_START + " (hosts=1) >>>\r\n";
  const end = MARK_END + "\r\n";
  const unterminated = "# x\r\n" + start + "0.0.0.0 a.example.com\r\n127.0.0.1 keep.local\r\n";
  assert.equal(markersPaired(unterminated), false);
  assert.throws(() => compose(unterminated, start + "0.0.0.0 b.example.com\r\n" + end, "\r\n"), /do not pair up/);
  // two starts, one end: never pair the first start across the second
  const twoStarts = unterminated + start + end;
  assert.equal(markersPaired(twoStarts), false);
  assert.equal(findRegions(twoStarts).length, 0);
  assert.equal(markersPaired("# x\r\n" + end), false, "a stray end marker");
  assert.equal(markersPaired("# x\r\n" + start + end + start + end), true);
  assert.equal(markersPaired("# no markers\r\n"), true);
});

test("parseAdblock: modifiers that narrow or reverse a rule are skipped (finding 5)", () => {
  const r = parseAdblock(["||whole.example.com^$important", "||doc.example.com^$document,important", "||cdn.example.com^$script,third-party", "||safe.example.com^$badfilter", "||x.example.com^$domain=a.com|b.com", "||dns.example.com^$dnstype=AAAA"].join("\n"));
  assert.deepEqual(r.hosts, ["whole.example.com", "doc.example.com"]);
  assert.equal(r.stats.skipped, 4);
});

test("allowlist: Unicode patterns match the punycode the lists are normalised to (finding 6)", () => {
  const { rules } = compileAllowlist(["bücher.example", "*.münchen.example"]);
  assert.equal(allowedBy("xn--bcher-kva.example", rules)?.pattern, "bücher.example", "pattern keeps what the user typed");
  assert.equal(allowedBy("www.xn--mnchen-3ya.example", rules)?.pattern, "*.münchen.example");
  const n = normalizeAll(["bücher.example", "ads.example.com"], rules);
  assert.deepEqual(n.hosts, ["ads.example.com"]);
  assert.deepEqual(n.allowlisted, ["xn--bcher-kva.example"]);
});

test("an HTML page read as a domains list yields no valid host (the download check relies on it)", () => {
  const page = "<!doctype html>\n<html>\n<head>\n<title>Sign in</title>\n</head>\n<body>\n</body>\n</html>\n";
  assert.ok(parseDomains(page).hosts.length > 0, "the raw lines are candidates");
  assert.equal(parseDomains(page).hosts.filter((h) => normalizeHost(h) !== null).length, 0);
});

test("parseConfig: the block address can only be 0.0.0.0 or 127.0.0.1, whoever edited the file", () => {
  assert.equal(parseConfig('ip = "127.0.0.1"').ip, "127.0.0.1");
  assert.equal(parseConfig("").ip, "0.0.0.0");
  assert.throws(() => parseConfig('ip = "6.6.6.6"'), /block address, must be/);
  // TOML escapes, so the parsed value really holds a line break
  assert.throws(() => parseConfig(String.raw`ip = "1.2.3.4 mybank.com\r\n0.0.0.0"`), /block address, must be/);
});

test("parseConfig: a retired catalog list is swapped for its replacement, once", () => {
  assert.deepEqual(parseConfig('enabled = ["adaway", "petelowe"]').enabled, ["sb-own", "petelowe"]);
  assert.deepEqual(parseConfig('enabled = ["sb-own", "adaway"]').enabled, ["sb-own"]);
  assert.deepEqual(parseConfig('enabled = ["user-x"]').enabled, ["user-x"]);
  assert.deepEqual(parseConfig("").enabled, ["petelowe", "sb-own"]);
});

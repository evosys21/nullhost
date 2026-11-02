import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAllowText } from "../src/allowtext.ts";

test("allowlist paste: a HostsMan exclusion list (XML)", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ExclusionList version="3.0">
  <Rules>
    <Rule>*.googleadservices.com</Rule>
    <Rule>*.clickserve.dartsearch.net</Rule>
    <Rule>*.doubleclick.net</Rule>
    <Rule>*.kaltura.com</Rule>
    <Rule>*.google-analytics.com</Rule>
  </Rules>
</ExclusionList>`;
  assert.deepEqual(parseAllowText(xml), {
    patterns: ["*.googleadservices.com", "*.clickserve.dartsearch.net", "*.doubleclick.net", "*.kaltura.com", "*.google-analytics.com"],
    skipped: [],
  });
});

test("allowlist paste: lines, commas, semicolons, spaces, comments, duplicates", () => {
  const r = parseAllowText("a.example.com, b.example.com;c.example.com d.example.com\r\n# a comment\nA.Example.com.  # again\n\n");
  assert.deepEqual(r.patterns, ["a.example.com", "b.example.com", "c.example.com", "d.example.com"]);
  assert.deepEqual(r.skipped, []);
});

test("allowlist paste: hosts lines, URLs, adblock rules, leading dot", () => {
  const r = parseAllowText([
    "0.0.0.0 ads.example.com tracker.example.com",
    "127.0.0.1 x.example.com",
    "https://user@cdn.example.org:8443/path?q=1#top",
    "@@||allowed.example.net^$third-party",
    "||plain.example.net^",
    ".suffix.example.com",
    "! adblock comment",
    "[Adblock Plus 2.0]",
  ].join("\n"));
  assert.deepEqual(r.patterns, [
    "ads.example.com", "tracker.example.com", "x.example.com", "cdn.example.org",
    "allowed.example.net", "plain.example.net", "*.suffix.example.com",
  ]);
  assert.deepEqual(r.skipped, []);
});

test("allowlist paste: a /regex/ line stays whole; a bad one and words are skipped", () => {
  const r = parseAllowText("/^s3-.*\.amazonaws\.com$/\n/([/\nplease allow these: bücher.example, *.local\nbad_.-x.com");
  assert.deepEqual(r.patterns, ["/^s3-.*\.amazonaws\.com$/", "bücher.example", "*.local"]);
  assert.deepEqual(r.skipped, ["/([/", "please", "allow", "these:", "bad_.-x.com"]);
});

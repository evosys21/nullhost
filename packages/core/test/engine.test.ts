import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Engine,
  MARK_START,
  OverCeilingError,
  RegionMarkersError,
  SourcesUnavailableError,
  classify,
  extractRegion,
  pathsIn,
  readHostsFile,
  regionHosts,
  removeRegion,
  writeWithRetry,
  type Catalog,
  type Platform,
} from "../src/index.ts";

// A hosts file like the real one: Microsoft header, the user's dev vhosts, a Docker
// Desktop block, CRLF, and a UTF-8 comment that must survive byte for byte.
const OUTSIDE =
  "# Copyright (c) 1993-2009 Microsoft Corp.\r\n#\r\n" +
  Buffer.from("# naïve café: comment with UTF-8 bytes\r\n", "utf8").toString("latin1") +
  "127.0.0.1   alma.local\r\n127.0.0.1   trader.local\r\n0.0.0.0     my-own-block.example.com\r\n" +
  "# Added by Docker Desktop\r\n192.168.65.254 host.docker.internal\r\n# End of section\r\n";

interface Harness {
  engine: Engine;
  hostsFile: string;
  dir: string;
  listA: string;
  listB: string;
  flushes: { count: number };
  clock: { now: Date };
  read: () => Promise<string>;
}

async function harness(o: { ceiling?: number; keep?: number } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-engine-"));
  const hostsFile = join(dir, "hosts");
  await writeFile(hostsFile, Buffer.from(OUTSIDE, "latin1"));
  const listA = join(dir, "a.txt");
  const listB = join(dir, "b.txt");
  await writeFile(listA, "# list A\n0.0.0.0 ads.example.com\n0.0.0.0 tracker.example.com cdn.segment.com\n127.0.0.1 localhost\n192.168.1.1 redirect.example.com\n");
  await writeFile(listB, "ads.example.com\nmetrics.example.org\n*.wild.example.net\n");
  const catalog: Catalog = {
    version: "test",
    sources: [
      { id: "a", name: "List A", url: listA, format: "hosts", licence: "MIT", tier: "recommended" },
      { id: "b", name: "List B", url: listB, format: "domains", licence: "CC0", tier: "recommended" },
    ],
  };
  const flushes = { count: 0 };
  const clock = { now: new Date("2026-10-26T10:00:00.000Z") };
  const platform: Platform = {
    name: "windows",
    eol: "\r\n",
    perLine: 9,
    hardCeiling: o.ceiling ?? 1_000,
    systemHostsPath: () => "C:\\Windows\\System32\\drivers\\etc\\hosts",
    isElevated: async () => true,
    readHosts: readHostsFile,
    writeHosts: (p, c) => writeWithRetry(p, c),
    flushDns: async () => { flushes.count++; },
  };
  const engine = new Engine({
    platform,
    paths: pathsIn(join(dir, "data")),
    hostsFile,
    catalog,
    now: () => clock.now,
    flush: true,
    snapshotsToKeep: o.keep ?? 10,
  });
  return { engine, hostsFile, dir, listA, listB, flushes, clock, read: () => readHostsFile(hostsFile) };
}

const tick = (h: Harness, ms = 1_000) => { h.clock.now = new Date(h.clock.now.getTime() + ms); };
/** the file minus the managed region (and the blank line compose() puts before an appended one) */
const outsideOf = (text: string) => removeRegion(text);

test("the engine never writes the real system hosts file in tests", async () => {
  const h = await harness();
  assert.equal(h.engine.isSystemFile, false);
  assert.notEqual(h.engine.hostsFile.toLowerCase(), "c:\\windows\\system32\\drivers\\etc\\hosts");
});

test("apply: region appended, everything outside kept byte for byte, flushed, original snapshot", async () => {
  const h = await harness();
  const r = await h.engine.apply();
  assert.equal(r.written, true);
  assert.equal(r.hosts, 4);
  const text = await h.read();
  assert.ok(text.startsWith(OUTSIDE), "outside bytes unchanged");
  assert.deepEqual(regionHosts(extractRegion(text)!).sort(), ["ads.example.com", "cdn.segment.com", "metrics.example.org", "tracker.example.com"]);
  assert.equal(h.flushes.count, 1);
  const original = await h.engine.snapshots.original();
  assert.equal(await readFile(original!.file, "latin1"), OUTSIDE);
  assert.equal(r.build.runs.a!.unique, 3);
  assert.equal(r.build.runs.b!.unique, 1);
});

test("apply with nothing changed does not write and does not flush (no DNS reload)", async () => {
  const h = await harness();
  await h.engine.apply();
  tick(h);
  const snapshotsBefore = (await h.engine.snapshots.list()).length;
  const r = await h.engine.update();
  assert.equal(r.written, false);
  assert.equal(r.write?.changed, false);
  assert.equal(h.flushes.count, 1);
  assert.equal((await h.engine.snapshots.list()).length, snapshotsBefore);
});

test("update reports per-source changes and the diff against the file", async () => {
  const h = await harness();
  await h.engine.apply();
  await appendFile(h.listA, "0.0.0.0 fresh.example.com\n");
  tick(h);
  const r = await h.engine.update();
  assert.equal(r.written, true);
  assert.equal(r.build.runs.a!.added, 1);
  assert.equal(r.diff.added, 1);
  assert.deepEqual(r.diff.sampleAdded, ["fresh.example.com"]);
});

test("allowlist removes a host; check explains listed-by and allowed-by", async () => {
  const h = await harness();
  await h.engine.apply();
  await h.engine.allowAdd("cdn.segment.com");
  tick(h);
  const r = await h.engine.apply();
  assert.equal(r.diff.removed, 1);
  const c = await h.engine.check("CDN.Segment.com");
  assert.deepEqual(c.listedBy, ["List A"]);
  assert.equal(c.allowedBy, "cdn.segment.com");
  assert.equal(c.wouldBlock, false);
  assert.equal(c.blockedNow, false);
  const ads = await h.engine.check("ads.example.com");
  assert.deepEqual(ads.listedBy, ["List A", "List B"]);
  assert.equal(ads.blockedNow, true);
  const own = await h.engine.check("my-own-block.example.com");
  assert.equal(own.ownEntry, true);
  assert.deepEqual(own.listedBy, []);
  await assert.rejects(h.engine.allowAdd("/([/"));
});

test("allowSet replaces the whole allowlist; a bad regex saves nothing", async () => {
  const h = await harness();
  await h.engine.allowAdd("old.example.com");
  await h.engine.allowSet(["*.doubleclick.net", "cdn.segment.com", "cdn.segment.com"]);
  assert.deepEqual((await h.engine.config()).allowlist, ["*.doubleclick.net", "cdn.segment.com"]);
  await assert.rejects(h.engine.allowSet(["a.example.com", "/([/"]));
  assert.deepEqual((await h.engine.config()).allowlist, ["*.doubleclick.net", "cdn.segment.com"]);
});

test("disable keeps your own entries and an empty region; enable restores from the cache", async () => {
  const h = await harness();
  await h.engine.apply();
  tick(h);
  await h.engine.disable();
  let text = await h.read();
  assert.equal(outsideOf(text), OUTSIDE);
  assert.equal(regionHosts(extractRegion(text)!).length, 0);
  assert.equal((await h.engine.status()).blocking.mode, "disabled");
  tick(h);
  await h.engine.enable();
  text = await h.read();
  assert.equal(regionHosts(extractRegion(text)!).length, 4);
  assert.equal(outsideOf(text), OUTSIDE);
});

test("apply while disabled stores the new region but leaves the file off", async () => {
  const h = await harness();
  await h.engine.apply();
  tick(h);
  await h.engine.disable();
  await appendFile(h.listA, "0.0.0.0 later.example.com\n");
  tick(h);
  const r = await h.engine.update();
  assert.equal(r.pending, true);
  assert.equal(regionHosts(extractRegion(await h.read())!).length, 0);
  tick(h);
  await h.engine.enable();
  assert.ok(regionHosts(extractRegion(await h.read())!).includes("later.example.com"));
});

test("pause resumes only when due", async () => {
  const h = await harness();
  await h.engine.apply();
  tick(h);
  await h.engine.pause(new Date(h.clock.now.getTime() + 15 * 60_000));
  assert.equal((await h.engine.status()).blocking.mode, "paused");
  assert.match((await h.engine.status()).region.status ?? "", /^paused until /);
  tick(h, 10 * 60_000);
  assert.equal(await h.engine.resumeIfDue(), false);
  tick(h, 6 * 60_000);
  assert.equal(await h.engine.resumeIfDue(), true);
  assert.equal((await h.engine.status()).blocking.mode, "enabled");
  assert.equal(regionHosts(extractRegion(await h.read())!).length, 4);
});

test("over the hard ceiling: refused, file untouched", async () => {
  const h = await harness({ ceiling: 3 });
  await assert.rejects(h.engine.apply(), OverCeilingError);
  assert.equal(await h.read(), OUTSIDE);
});

test("restore previous and original; remove; outside edits to the region are noticed", async () => {
  const h = await harness();
  await h.engine.apply();
  const afterApply = await h.read();
  tick(h);
  await h.engine.disable();
  tick(h);
  const back = await h.engine.restore("previous");
  assert.equal(await h.read(), afterApply);
  assert.match(back.from, /disable\.hosts$/);
  assert.equal((await h.engine.status()).blocking.mode, "enabled");

  tick(h);
  await h.engine.restore("original");
  assert.equal(await h.read(), OUTSIDE);
  assert.equal((await h.engine.status()).blocking.mode, "disabled");

  tick(h);
  await h.engine.enable();
  const text = await h.read();
  await writeFile(h.hostsFile, Buffer.from(text.replace("0.0.0.0 ads.example.com", "0.0.0.0 hacked.example.com"), "latin1"));
  assert.equal((await h.engine.status()).region.modifiedExternally, true);

  tick(h);
  await h.engine.remove();
  assert.equal(await h.read(), OUTSIDE);
});

test("snapshots keep the newest N plus the original", async () => {
  const h = await harness({ keep: 3 });
  await h.engine.apply();
  for (let i = 0; i < 4; i++) {
    tick(h);
    await h.engine.disable();
    tick(h);
    await h.engine.enable();
  }
  assert.equal((await h.engine.snapshots.list()).length, 3);
  assert.ok(await h.engine.snapshots.original());
});

test("snapshots taken in the same millisecond still sort newest first", async () => {
  const h = await harness();
  await h.engine.apply();
  await h.engine.disable();
  await h.engine.enable();
  const names = (await h.engine.snapshots.list()).map((s) => s.reason);
  assert.deepEqual(names.slice(0, 2), ["enable", "disable"]);
});

test("tidy removes only leftover blocks the region covers; your own entries stay byte for byte", async () => {
  const h = await harness();
  const leftovers =
    "0.0.0.0 ads.example.com\r\n" +                         // covered: goes
    "127.0.0.1 tracker.example.com projects.mine\r\n" +     // covered + dev name: line shortened
    "127.0.0.1   metrics.example.org   # old list\r\n" +    // covered: goes, comment too
    "10.20.20.10 ip.localhost\r\n";                         // not a sink: untouched
  await writeFile(h.hostsFile, Buffer.from(OUTSIDE + leftovers, "latin1"));
  await h.engine.apply();
  const before = await h.engine.status();
  assert.equal(before.leftovers.hosts, 3);

  const plan = await h.engine.planTidy();
  assert.equal(plan.removeSink0, 1);
  assert.equal(plan.removeLoopback, 2);
  assert.equal(plan.linesDropped, 2);
  assert.equal(plan.linesShortened, 1);
  assert.ok(plan.sampleKept.includes("my-own-block.example.com"));
  assert.ok(plan.sampleKept.includes("alma.local"));
  assert.equal(await h.read(), (await h.read()), "planning writes nothing");

  tick(h);
  const r = await h.engine.tidy();
  assert.equal(r.changed, true);
  const after = await h.read();
  assert.equal(removeRegion(after), OUTSIDE + "127.0.0.1 projects.mine\r\n10.20.20.10 ip.localhost\r\n");
  assert.equal(regionHosts(extractRegion(after)!).length, 4, "region untouched");
  assert.equal((await h.engine.status()).leftovers.hosts, 0);
  assert.match((await h.engine.snapshots.list())[0]!.reason, /tidy/);

  tick(h);
  await h.engine.restore("previous");
  assert.equal(removeRegion(await h.read()), OUTSIDE + leftovers, "restore previous undoes the clean-up");
});

test("tidy refuses before anything was applied", async () => {
  const h = await harness();
  await assert.rejects(h.engine.tidy(), /apply first/);
  assert.equal(await h.read(), OUTSIDE);
});

test("editor save: outside lines change, the region is protected", async () => {
  const h = await harness();
  await h.engine.apply();
  const text = await h.read();
  tick(h);
  const edited = text.replace("127.0.0.1   trader.local\r\n", "127.0.0.1   trader.local\r\n127.0.0.1   gtab.local\r\n");
  const w = await h.engine.saveEdited(edited);
  assert.equal(w.changed, true);
  assert.equal(await h.read(), edited);
  assert.match((await h.engine.snapshots.list())[0]!.reason, /editor/);
  await assert.rejects(h.engine.saveEdited(edited.replace("0.0.0.0 ads.example.com", "0.0.0.0 other.example.com")), /region was changed/);
  await assert.rejects(h.engine.saveEdited(removeRegion(edited)), /region was changed/);
  assert.equal(await h.read(), edited);
});

test("setOptions validates the block address and the budget", async () => {
  const h = await harness({ ceiling: 180_000 });
  await h.engine.setOptions({ ip: "127.0.0.1", budget: 120_000 });
  const c = await h.engine.config();
  assert.equal(c.ip, "127.0.0.1");
  assert.equal(c.budget, 120_000);
  await assert.rejects(h.engine.setOptions({ ip: "192.168.1.1" }), /0\.0\.0\.0 or 127\.0\.0\.1/);
  await assert.rejects(h.engine.setOptions({ budget: 5_000_000 }), /budget must be between/);
});

test("user sources and source toggles persist in config.toml", async () => {
  const h = await harness();
  const extra = join(h.dir, "office.txt");
  await writeFile(extra, "0.0.0.0 office-block.example.com\n");
  const src = await h.engine.addUserSource(extra, "Office list");
  assert.equal(src.id, "user-office-list");
  await h.engine.setSourceEnabled("b", false);
  const r = await h.engine.apply();
  assert.ok(regionHosts(extractRegion(await h.read())!).includes("office-block.example.com"));
  assert.equal(r.build.sources.map((s) => s.id).join(","), "a,user-office-list");
  const toml = await readFile(h.engine.paths.configFile, "utf8");
  assert.match(toml, /\[\[sources\]\]/);
  assert.match(toml, /enabled = \[ "a", "user-office-list" \]/);
  await assert.rejects(h.engine.setSourceEnabled("nope", true), /unknown source/);
});

test("broken markers: no write swallows the user's lines; the Editor can fix them (finding 2)", async () => {
  const h = await harness();
  const broken = OUTSIDE + MARK_START + " (hosts=1) >>>\r\n0.0.0.0 old.example.com\r\n127.0.0.1 keep.local\r\n";
  await writeFile(h.hostsFile, Buffer.from(broken, "latin1"));
  for (const op of [() => h.engine.apply(), () => h.engine.disable(), () => h.engine.enable(), () => h.engine.remove(), () => h.engine.tidy()]) {
    await assert.rejects(op(), (e: unknown) => e instanceof RegionMarkersError || /no list applied/.test(String(e)));
    assert.equal(await h.read(), broken, "file untouched");
  }
  assert.equal((await h.engine.status()).region.unterminated, true);
  // the Editor accepts the repair; afterwards apply works, twice, and keep.local survives
  await h.engine.saveEdited(OUTSIDE + "127.0.0.1 keep.local\r\n");
  await h.engine.apply();
  tick(h);
  await h.engine.apply();
  assert.match(outsideOf(await h.read()), /127\.0\.0\.1 keep\.local/);
});

test("an enabled source with no download and no cache keeps the blocking in place (finding 3)", async () => {
  const h = await harness();
  await h.engine.apply();
  const before = await h.read();
  await h.engine.addUserSource(join(h.dir, "missing.txt"), "Gone");
  tick(h);
  const dry = await h.engine.apply({ dryRun: true });
  assert.equal(dry.build.failed.length, 1, "a dry run still reports it");
  await assert.rejects(h.engine.update(), SourcesUnavailableError);
  assert.equal(await h.read(), before, "the working region stays");
});

test("update reports each step, for the desktop's busy toast", async () => {
  const h = await harness();
  const steps: string[] = [];
  h.engine.onProgress = (s) => steps.push(s);
  await h.engine.update();
  assert.deepEqual(steps, ["Reading List A (1 of 2)", "Reading List B (2 of 2)", "Merging 2 lists", "Writing the hosts file", "Flushing the DNS cache"]);
});

test("settings export and import: a round trip to another PC; bad files change nothing", async () => {
  const a = await harness({ ceiling: 200_000 });
  await a.engine.addUserSource("https://lists.example/mine.txt", "Mine", "domains");
  await a.engine.allowSet(["*.doubleclick.net", "cdn.segment.com"]);
  await a.engine.setOptions({ ip: "127.0.0.1", budget: 120_000 });
  const exported = await a.engine.exportConfig();

  const b = await harness({ ceiling: 200_000 });
  const before = await b.engine.config();
  const c = await b.engine.importConfig(exported);
  assert.deepEqual(await b.engine.config(), await a.engine.config());
  assert.deepEqual(c.allowlist, ["*.doubleclick.net", "cdn.segment.com"]);
  const kept = await readFile(`${b.engine.paths.configFile}.before-import`, "utf8");
  assert.ok(kept.includes(`budget = ${before.budget}`));

  const now = await b.engine.exportConfig();
  await assert.rejects(b.engine.importConfig("not = [toml"), /Not a NullHost settings file/);
  await assert.rejects(b.engine.importConfig('ip = "1.2.3.4"'), /block address/);
  await assert.rejects(b.engine.importConfig("budget = 999999"), /budget/);
  await assert.rejects(b.engine.importConfig('allowlist = ["/([/"]'), /allowlist/);
  assert.equal(await b.engine.exportConfig(), now);
});

test("blockIndex agrees with check, for the DNS log", async () => {
  const h = await harness();
  await h.engine.apply();
  await h.engine.allowAdd("cdn.segment.com");
  tick(h);
  await h.engine.apply();
  const idx = await h.engine.blockIndex();
  const e = (name: string) => ({ record: 1, time: "", pid: 1, name, type: 1, status: 0, results: ["1.2.3.4"] });
  const ads = classify(e("ads.example.com"), idx);
  assert.equal(ads.verdict, "blocked");
  assert.deepEqual(ads.listedBy, ["List A", "List B"]);
  const seg = classify(e("cdn.segment.com"), idx);
  assert.equal(seg.verdict, "allowed");
  assert.deepEqual(seg.listedBy, ["List A"]);
  assert.equal(seg.allowedBy, "cdn.segment.com");
  assert.equal(classify(e("my-own-block.example.com"), idx).verdict, "own");
  assert.equal(classify(e("example.org"), idx).verdict, "resolved");
});

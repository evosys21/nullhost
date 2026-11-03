import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readHostsFile, writeWithRetry, type Platform } from "@nullhost/core";
import { parsePause, run } from "../src/cli.ts";

const SYSTEM = "C:\\Windows\\System32\\drivers\\etc\\hosts";

/** A platform that is NOT elevated and never flushes, so a mistake cannot touch the real machine. */
function testPlatform(flushes: { n: number }): Platform {
  return {
    name: "windows",
    eol: "\r\n",
    perLine: 9,
    hardCeiling: 180_000,
    systemHostsPath: () => SYSTEM,
    isElevated: async () => false,
    readHosts: readHostsFile,
    writeHosts: (p, c) => writeWithRetry(p, c),
    flushDns: async () => { flushes.n++; },
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-cli-"));
  const hostsFile = join(dir, "hosts");
  await writeFile(hostsFile, "# test hosts\r\n127.0.0.1 alma.local\r\n");
  const list = join(dir, "list.txt");
  await writeFile(list, "0.0.0.0 ads.example.com tracker.example.com\n0.0.0.0 cdn.segment.com\n");
  const flushes = { n: 0 };
  const lines: string[] = [];
  const errs: string[] = [];
  const io = { out: (s: string) => lines.push(s), err: (s: string) => errs.push(s), env: {}, platform: testPlatform(flushes) };
  const nh = (...args: string[]) => run([...args, "--hosts-file", hostsFile, "--data-dir", join(dir, "data")], io);
  return { dir, hostsFile, list, flushes, lines, errs, io, nh };
}

test("refuses to write the system hosts file without elevation, before doing anything", async () => {
  const { io, errs } = await setup();
  for (const args of [["apply"], ["enable"], ["disable"], ["update"], ["pause", "15m"], ["restore", "previous"], ["remove"]]) {
    const code = await run([...args, "--data-dir", join(tmpdir(), "nullhost-never")], io);
    assert.equal(code, 3, `${args[0]} must exit 3`);
  }
  assert.match(errs[0]!, /needs an elevated terminal/);
});

test("read-only commands work unelevated on the system file", async () => {
  const { io, lines } = await setup();
  assert.equal(await run(["source", "list", "--data-dir", join(tmpdir(), "nullhost-ro")], io), 0);
  assert.ok(lines.some((l) => l.includes("stevenblack")));
  assert.equal(await run(["paths", "--data-dir", join(tmpdir(), "nullhost-ro")], io), 0);
});

test("end to end on a temp hosts file: add source, apply, check, disable, enable, restore", async () => {
  const t = await setup();
  assert.equal(await t.nh("source", "disable", "stevenblack", "adaway", "petelowe"), 0);
  assert.equal(await t.nh("source", "add", t.list, "--name", "Test list"), 0);
  assert.equal(await t.nh("apply"), 0, t.errs.join("\n"));
  let text = await readFile(t.hostsFile, "latin1");
  assert.match(text, /0\.0\.0\.0 ads\.example\.com cdn\.segment\.com tracker\.example\.com|0\.0\.0\.0 (?:[a-z.]+ ){2}[a-z.]+/);
  assert.ok(text.startsWith("# test hosts\r\n127.0.0.1 alma.local\r\n"));
  assert.equal(t.flushes.n, 0, "never flushes for a non-system file");

  t.lines.length = 0;
  assert.equal(await t.nh("check", "ads.example.com"), 0);
  assert.match(t.lines[0]!, /listed by Test list/);
  assert.match(t.lines[1]!, /blocked now: yes/);

  assert.equal(await t.nh("allow", "add", "cdn.segment.com"), 0);
  assert.equal(await t.nh("apply"), 0);
  assert.doesNotMatch(await readFile(t.hostsFile, "latin1"), /cdn\.segment\.com/);

  assert.equal(await t.nh("disable"), 0);
  text = await readFile(t.hostsFile, "latin1");
  assert.match(text, /status=disabled/);
  assert.doesNotMatch(text, /ads\.example\.com/);
  assert.match(text, /alma\.local/);

  assert.equal(await t.nh("enable"), 0);
  assert.match(await readFile(t.hostsFile, "latin1"), /ads\.example\.com/);

  t.lines.length = 0;
  assert.equal(await t.nh("status", "--json"), 0);
  const s = JSON.parse(t.lines.join("\n"));
  assert.equal(s.blocking.mode, "enabled");
  assert.equal(s.region.hosts, 2);
  assert.equal(s.systemFile, false);

  assert.equal(await t.nh("restore", "original"), 0);
  assert.equal(await readFile(t.hostsFile, "latin1"), "# test hosts\r\n127.0.0.1 alma.local\r\n");
});

test("doctor, export, catalog and schedule commands", async () => {
  const t = await setup();
  const calls: string[] = [];
  const fakeScheduler = () => ({
    available: false,
    status: async () => ({ installed: true, available: false, at: "07:30", nextRun: "2026-10-27T07:31:00" }),
    install: async () => { calls.push("install"); },
    remove: async () => { calls.push("remove"); },
  });
  const io = { ...t.io, scheduler: fakeScheduler };
  const nh = (...args: string[]) => run([...args, "--hosts-file", t.hostsFile, "--data-dir", join(t.dir, "data")], io);
  assert.equal(await nh("source", "disable", "stevenblack", "adaway", "petelowe"), 0);
  assert.equal(await nh("source", "add", t.list, "--name", "Test list"), 0);
  assert.equal(await nh("apply"), 0);

  t.lines.length = 0;
  assert.equal(await nh("doctor"), 0);
  assert.ok(t.lines.some((l) => /\[ok {2}\] NullHost region/.test(l)), t.lines.join("\n"));
  assert.ok(t.lines.some((l) => /Daily list updates: daily at 07:30/.test(l)));

  const out = join(t.dir, "export.txt");
  assert.equal(await nh("export", "--format", "dnsmasq", "--out", out), 0);
  assert.match(await readFile(out, "utf8"), /^address=\/ads\.example\.com\/0\.0\.0\.0$/m);
  assert.equal(await nh("export", "--format", "exe"), 2);

  t.lines.length = 0;
  assert.equal(await nh("catalog", "show"), 0);
  assert.match(t.lines[0]!, /^catalog \d{4}-\d{2}-\d{2}: \d+ lists$/);

  t.lines.length = 0;
  assert.equal(await nh("schedule", "status"), 0);
  assert.match(t.lines[0]!, /daily at 07:30/);
  assert.equal(await nh("schedule", "install"), 2, "the task is switched on in the app only");
  assert.equal(await nh("schedule", "remove"), 3);
  assert.deepEqual(calls, []);
});

test("--config points at a config file outside the data dir", async () => {
  const t = await setup();
  const cfg = join(t.dir, "elsewhere", "config.toml");
  assert.equal(await run(["allow", "add", "cdn.segment.com", "--config", cfg, "--data-dir", join(t.dir, "data"), "--hosts-file", t.hostsFile], t.io), 0);
  assert.match(await readFile(cfg, "utf8"), /cdn\.segment\.com/);
});

test("usage errors exit 2", async () => {
  const t = await setup();
  assert.equal(await t.nh("bogus"), 2);
  assert.equal(await t.nh("pause", "soon"), 2);
  assert.equal(await t.nh("check"), 2);
  assert.equal(await run(["--nope"], t.io), 2);
});

test("parsePause", () => {
  const now = new Date("2026-10-26T10:00:00");
  assert.equal(parsePause(["15m"], now).getTime() - now.getTime(), 15 * 60_000);
  assert.equal(parsePause(["1h30m"], now).getTime() - now.getTime(), 90 * 60_000);
  assert.equal(parsePause(["until", "11:30"], now).getHours(), 11);
  assert.equal(parsePause(["until", "07:30"], now).getDate(), 27);
});

test("previews never write: no resume of an expired pause, no elevation needed (findings 4 and 7)", async () => {
  const t = await setup();
  assert.equal(await t.nh("source", "disable", "stevenblack", "adaway", "petelowe"), 0);
  assert.equal(await t.nh("source", "add", t.list, "--name", "Test list"), 0);
  assert.equal(await t.nh("apply"), 0);
  assert.equal(await t.nh("pause", "1m"), 0);
  const paused = await readFile(t.hostsFile, "latin1");
  const later = new Date(Date.now() + 3_600_000);
  (t.io as { now?: () => Date }).now = () => later;
  for (const args of [["apply", "--dry-run"], ["apply", "--diff"], ["update", "--fetch-only"], ["update", "--dry-run"], ["status"]]) {
    assert.equal(await t.nh(...args), 0, args.join(" "));
    assert.equal(await readFile(t.hostsFile, "latin1"), paused, args.join(" ") + " must not write");
  }
  t.lines.length = 0;
  assert.equal(await t.nh("status", "--json"), 0);
  assert.equal(JSON.parse(t.lines.join("\n")).blocking.mode, "paused");
  assert.equal(await t.nh("apply"), 0, "a real apply resumes");
  assert.match(await readFile(t.hostsFile, "latin1"), /status=enabled/);

  // the system file, unelevated: --diff previews, a real apply is refused
  const sysIo = { ...t.io, platform: { ...t.io.platform, systemHostsPath: () => t.hostsFile } };
  const sys = (...args: string[]) => run([...args, "--data-dir", join(t.dir, "data")], sysIo);
  assert.equal(await sys("apply", "--diff"), 0, t.errs.join("\n"));
  assert.equal(await sys("apply"), 3);
});

test("--json covers allowlist and source changes (finding 8)", async () => {
  const t = await setup();
  const js = async (...args: string[]) => {
    t.lines.length = 0;
    assert.equal(await t.nh(...args, "--json"), 0, args.join(" "));
    return JSON.parse(t.lines.join("\n"));
  };
  assert.deepEqual((await js("allow", "add", "ads.example.com")).allowlist, ["ads.example.com"]);
  assert.equal((await js("allow", "remove", "ads.example.com")).removed, "ads.example.com");
  assert.equal((await js("allow", "remove", "nope.example.com")).removed, null);
  const off = await js("source", "disable", "adaway");
  assert.deepEqual([off.action, off.ids, off.enabled.includes("adaway")], ["disable", ["adaway"], false]);
  const on = await js("source", "enable", "adaway");
  assert.deepEqual([on.action, on.ids, on.enabled.includes("adaway")], ["enable", ["adaway"], true]);
  const added = (await js("source", "add", t.list, "--name", "Test list")).added;
  assert.equal(added.name, "Test list");
  assert.equal((await js("source", "remove", added.id)).removed, added.id);
});

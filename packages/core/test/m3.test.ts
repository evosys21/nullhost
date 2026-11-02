import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUILTIN_CATALOG,
  BusyError,
  Engine,
  doctor,
  exclusionCovers,
  findHostsTools,
  exportList,
  parseTaskStatus,
  pathsIn,
  quoteArg,
  readHostsFile,
  sameAccount,
  updateTaskName,
  updateTaskXml,
  validateCatalog,
  windowsScheduler,
  withFileLock,
  writeWithRetry,
  type Catalog,
  type Platform,
} from "../src/index.ts";

const tmp = (p: string) => mkdtemp(join(tmpdir(), `nullhost-m3-${p}-`));

// ------------------------------------------------------------------ lock

test("lock: the second holder waits for the first", async () => {
  const file = join(await tmp("lock"), "write.lock");
  const order: string[] = [];
  const a = withFileLock(file, async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 150)); order.push("a-end"); });
  await new Promise((r) => setTimeout(r, 20));
  const b = withFileLock(file, async () => { order.push("b"); }, { intervalMs: 20 });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
  await assert.rejects(stat(file), "released");
});

test("lock: a dead holder is taken over; a live one times out with BusyError", async () => {
  const dir = await tmp("lock2");
  const dead = join(dir, "dead.lock");
  await writeFile(dead, JSON.stringify({ pid: 0x7ffffff0, owner: "crashed" }));
  assert.equal(await withFileLock(dead, async () => "ran"), "ran");
  const live = join(dir, "live.lock");
  await writeFile(live, JSON.stringify({ pid: process.pid, owner: "busy test" }));
  await assert.rejects(withFileLock(live, async () => "never", { timeoutMs: 120, intervalMs: 20 }), BusyError);
});

test("lock: an empty lock file (crash between create and write) is taken over, not waited on for good", async () => {
  const file = join(await tmp("lock3"), "write.lock");
  await writeFile(file, "");
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  assert.equal(await withFileLock(file, async () => "ran", { timeoutMs: 500, intervalMs: 20 }), "ran");
});

test("lock: a holder whose lock was taken over leaves the new holder's lock alone", async () => {
  const file = join(await tmp("lock4"), "write.lock");
  const theirs = JSON.stringify({ pid: process.pid, owner: "new holder", token: "x" });
  await withFileLock(file, async () => {
    await writeFile(file, theirs); // taken over while we ran
  });
  assert.equal(await readFile(file, "utf8"), theirs);
});

test("lock: a lock that cannot be read (here a directory) times out with BusyError instead of spinning (finding 6.1)", async () => {
  const file = join(await tmp("lock5"), "write.lock");
  await mkdir(file);
  await assert.rejects(withFileLock(file, async () => "never", { timeoutMs: 150, intervalMs: 20 }), BusyError);
});

// ------------------------------------------------------------------ engine + doctor

async function engineOn(text: string, catalog?: Catalog) {
  const dir = await tmp("eng");
  const hostsFile = join(dir, "hosts");
  await writeFile(hostsFile, Buffer.from(text, "latin1"));
  const list = join(dir, "list.txt");
  await writeFile(list, "0.0.0.0 ads.example.com tracker.example.com\n");
  const platform: Platform = {
    name: "windows", eol: "\r\n", perLine: 9, hardCeiling: 180_000,
    systemHostsPath: () => "C:\\Windows\\System32\\drivers\\etc\\hosts",
    isElevated: async () => false,
    readHosts: readHostsFile,
    writeHosts: (p, c) => writeWithRetry(p, c),
    flushDns: async () => undefined,
  };
  const cat: Catalog = catalog ?? { version: "2026-10-26", sources: [{ id: "a", name: "List A", url: list, format: "hosts", licence: "MIT", tier: "recommended" }] };
  const mk = () => new Engine({ platform, paths: pathsIn(join(dir, "data")), hostsFile, catalog: cat });
  return { dir, hostsFile, engine: mk(), mk };
}

test("two engines on the same data never interleave writes", async () => {
  const { engine, mk, hostsFile } = await engineOn("# hosts\r\n");
  await engine.apply();
  const other = mk();
  await Promise.all([engine.disable(), other.enable(), engine.disable(), other.enable()]);
  const text = await readHostsFile(hostsFile);
  assert.equal(text.split("# >>> nullhost managed").length, 2, "exactly one region");
});

test("doctor: reports region, leftovers, long lines and never-updated; never writes", async () => {
  const long = "0.0.0.0 " + Array.from({ length: 11 }, (_, i) => `h${i}.example.org`).join(" ");
  const { engine, hostsFile } = await engineOn(`# hosts\r\n0.0.0.0 ads.example.com\r\n${long}\r\n`);
  await engine.apply();
  const before = await readHostsFile(hostsFile);
  const checks = await doctor(engine, { schedule: { installed: false, available: false } });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byId.region?.level, "ok");
  assert.equal(byId.leftovers?.level, "warn");
  assert.equal(byId["long-lines"]?.level, "warn");
  assert.equal(byId.updated?.level, "info");
  assert.equal(byId.elevated?.level, "info", "a copy, not the system file");
  assert.match(byId.schedule?.detail ?? "", /administrator/);
  assert.equal(byId.dnscache, undefined, "no diagnostics on a copy");
  assert.equal(await readHostsFile(hostsFile), before);
});

test("export: hosts, domains, dnsmasq, unbound", async () => {
  const hosts = ["a.example.com", "b.example.org"];
  assert.equal(exportList(hosts, "hosts"), "0.0.0.0 a.example.com\n0.0.0.0 b.example.org\n");
  assert.equal(exportList(hosts, "domains", "0.0.0.0", "x"), "# x\na.example.com\nb.example.org\n");
  assert.match(exportList(hosts, "dnsmasq"), /^address=\/a\.example\.com\/0\.0\.0\.0$/m);
  assert.match(exportList(hosts, "unbound"), /^ {2}local-zone: "b\.example\.org\." always_null$/m);
  const { engine } = await engineOn("# hosts\r\n");
  const r = await engine.exportList("domains");
  assert.equal(r.hosts, 2);
  assert.match(r.text, /List A \(MIT\)/);
});

// ------------------------------------------------------------------ catalog

const good = { version: "2026-11-01", sources: [{ id: "x", name: "X list", url: "https://lists.example.test/x", format: "hosts", licence: "MIT", tier: "optional" }] };

test("catalog validation: the shipped catalog passes; unsafe entries are refused", () => {
  assert.ok(BUILTIN_CATALOG.sources.length >= 3);
  assert.equal(validateCatalog(good).sources[0]!.id, "x");
  const bad = (patch: Record<string, unknown>) => ({ ...good, sources: [{ ...good.sources[0], ...patch }] });
  assert.throws(() => validateCatalog(bad({ url: "http://insecure.example.test/x" })), /https/);
  assert.throws(() => validateCatalog(bad({ url: "file:///C:/Windows/win.ini" })), /https/);
  assert.throws(() => validateCatalog(bad({ id: "user-sneaky" })), /valid catalog id/);
  assert.throws(() => validateCatalog(bad({ format: "exe" })), /format/);
  assert.throws(() => validateCatalog(bad({ tier: "user" })), /tier/);
  assert.throws(() => validateCatalog(bad({ name: "a\u0007b" })), /printable/);
  assert.throws(() => validateCatalog({ ...good, sources: [good.sources[0], good.sources[0]] }), /duplicate/);
  assert.throws(() => validateCatalog({ ...good, version: "latest" }), /version/);
});

// ------------------------------------------------------------------ scheduled task

test("task XML: the user (never SYSTEM), elevated while logged on, catches up, network only, args quoted and escaped, next occurrence", () => {
  const now = new Date(2026, 9, 26, 12, 0, 0);
  const xml = updateTaskXml({
    command: "C:\\Program Files\\NullHost\\NullHost.exe",
    args: ["--scheduled-update", "--data-dir", "C:\\Users\\An Dy\\AppData\\Local\\NullHost", "--config", "C:\\Users\\An Dy\\AppData\\Roaming\\NullHost\\config.toml"],
    user: "PC\\An Dy",
    at: "07:30",
  }, now);
  assert.match(xml, /<UserId>PC\\An Dy<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.doesNotMatch(xml, /S-1-5-18|SYSTEM/i);
  assert.throws(() => updateTaskXml({ command: "x", args: [], user: "S-1-5-18", at: "07:30" }, now), /DOMAIN\\name/);
  assert.throws(() => updateTaskXml({ command: "x", args: [], user: "", at: "07:30" }, now), /DOMAIN\\name/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<RunOnlyIfNetworkAvailable>true<\/RunOnlyIfNetworkAvailable>/);
  assert.match(xml, /<StartBoundary>2026-10-27T07:30:00<\/StartBoundary>/, "07:30 already passed today: tomorrow");
  assert.match(xml, /<Arguments>.*&quot;C:\\Users\\An Dy\\AppData\\Local\\NullHost&quot;.*<\/Arguments>/);
  assert.match(updateTaskXml({ command: "x", args: [], user: "PC\\u", at: "18:05" }, now), /2026-10-26T18:05:00/);
  assert.throws(() => updateTaskXml({ command: "x", args: [], user: "PC\\u", at: "25:00" }, now), /HH:MM/);
});

test("quoteArg follows the Windows command-line rules", () => {
  assert.equal(quoteArg("plain"), "plain");
  assert.equal(quoteArg("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteArg("C:\\dir with space\\"), '"C:\\dir with space\\\\"');
  assert.equal(quoteArg(""), '""');
});

test("task status: never run vs ran; install writes UTF-16 XML and calls schtasks; status none", async () => {
  const never = parseTaskStatus(JSON.stringify({ start: "2026-10-27T07:30:00", last: "1999-11-30T00:00:00.0000000", result: 267011, next: "2026-10-27T07:31:12.0000000+01:00" }));
  assert.equal(never.at, "07:30");
  assert.equal(never.lastRun, undefined);
  assert.ok(never.nextRun);
  const ran = parseTaskStatus(JSON.stringify({ start: "2026-10-27T07:30:00", last: "2026-10-27T07:34:00.0000000+01:00", result: 1, next: "" }));
  assert.equal(ran.lastResult, 1);
  assert.equal(ran.nextRun, undefined);

  let calls: string[][] = [];
  const box: { xml?: Buffer } = {};
  /** who the old shared task runs as ("none": there is none); its delete fails when `denied` */
  let legacy = { owner: "none", denied: false };
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === "schtasks" && args[0] === "/Create") box.xml = await readFile(args[args.indexOf("/XML") + 1]!);
    if (cmd === "powershell") return { code: 0, stdout: `${args.at(-1)!.includes("Principal") ? legacy.owner : "none"}\r\n`, stderr: "" };
    if (cmd === "schtasks" && args[0] === "/Delete" && args[2] === "NullHost Update" && legacy.denied) return { code: 1, stdout: "", stderr: "ERROR: Access is denied." };
    return { code: 0, stdout: "SUCCESS", stderr: "" };
  };
  const s = windowsScheduler(true, exec, updateTaskName("u"));
  assert.equal(updateTaskName("PC\\u"), "NullHost Update (PC_u)");
  const deletes = () => calls.filter((c) => c[0] === "schtasks" && c[1] === "/Delete").map((c) => c[3]);
  if (process.platform === "win32") {
    const cmd = { command: "NullHost.exe", args: ["--scheduled-update"], user: "PC\\u", at: "07:30" };
    legacy = { owner: "u", denied: false };
    await s.install(cmd);
    assert.deepEqual(calls[0]!.slice(0, 4), ["schtasks", "/Create", "/TN", "NullHost Update (u)"]);
    assert.deepEqual(deletes(), ["NullHost Update"], "the old shared task goes when it was this account's");
    assert.ok(box.xml);
    assert.deepEqual([...box.xml.subarray(0, 2)], [0xff, 0xfe], "UTF-16 LE byte-order mark");
    assert.match(box.xml.subarray(2).toString("utf16le"), /<Command>NullHost\.exe<\/Command>/);

    calls = [];
    legacy = { owner: "OTHER\\v", denied: false };
    await s.install(cmd);
    assert.deepEqual(deletes(), [], "another user's old task is left alone");

    calls = [];
    legacy = { owner: "PC\\u", denied: true };
    await s.install(cmd); // resolves: the old task's delete does not decide whether switching on worked
    assert.deepEqual(deletes(), ["NullHost Update"]);

    calls = [];
    await s.remove();
    assert.deepEqual(deletes(), ["NullHost Update (u)"], "switching off removes only this account's task");
  }
  assert.ok(sameAccount("u", "PC\\u") && sameAccount("pc\\U", "PC\\u"));
  assert.ok(!sameAccount("SYSTEM", "PC\\u") && !sameAccount("OTHER\\u", "PC\\u"));
  assert.deepEqual(await s.status(), { installed: false, available: s.available });
  await assert.rejects(windowsScheduler(false, exec).install({ command: "x", args: [], user: "PC\\u", at: "07:30" }), /administrator/);
});

test("finds HostsMan in tasklist output", () => {
  const csv = ['"System Idle Process","0","Services","0","8 K"', '"hm.exe","43392","Console","1","24,512 K"', '"chrome.exe","1","Console","1","1 K"'].join("\r\n") + "\r\n";
  assert.deepEqual(findHostsTools(csv), ["HostsMan (hm.exe)"]);
  assert.deepEqual(findHostsTools('"chrome.exe","1","Console","1","1 K"'), []);
});

test("Defender exclusion matching", () => {
  const hosts = "C:\\Windows\\System32\\drivers\\etc\\hosts";
  assert.equal(exclusionCovers("C:\\Windows\\System32\\drivers\\etc\\hosts", hosts), true);
  assert.equal(exclusionCovers("c:\\windows\\system32\\drivers\\etc\\", hosts), true);
  assert.equal(exclusionCovers("C:\\Temp\r\nD:\\Repos", hosts), false);
  assert.equal(exclusionCovers("", hosts), false);
});

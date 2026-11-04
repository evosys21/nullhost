import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readHostsFile, writeWithRetry, type DnsEvent, type DnsLogAction, type Platform } from "@nullhost/core";
import type { HelperBroker } from "../src/main/helper.ts";
import { Service } from "../src/main/service.ts";

/** Windows' log as the fakes see it: on or off */
interface FakeLog { enabled: boolean }

/** A broker that runs dnslog requests against the fake log instead of starting an elevated process. */
function fakeBroker(log: FakeLog) {
  const requests: Array<[string, unknown]> = [];
  let running = false;
  const broker = {
    get running() { return running; },
    ensure: async () => { running = true; },
    request: async (op: string, params: { action?: DnsLogAction }) => {
      running = true;
      requests.push([op, params]);
      if (op === "dnslog" && params.action !== "clear") log.enabled = params.action === "enable";
      return null;
    },
    close: () => { running = false; },
  };
  return { broker: broker as unknown as HelperBroker, requests };
}

async function service(o: { withBroker?: boolean; enabled?: boolean; events?: DnsEvent[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-dnslog-"));
  const hostsFile = join(dir, "hosts"); // a copy: written without admin
  await writeFile(hostsFile, "127.0.0.1 localhost\r\n0.0.0.0 mine.example\r\n");
  const platform: Platform = {
    name: "windows", eol: "\r\n", perLine: 9, hardCeiling: 1_000,
    systemHostsPath: () => "C:\\Windows\\System32\\drivers\\etc\\hosts",
    isElevated: async () => false,
    readHosts: readHostsFile,
    writeHosts: (p, c) => writeWithRetry(p, c),
    flushDns: async () => undefined,
  };
  const log: FakeLog = { enabled: o.enabled ?? false };
  const fake = o.withBroker === false ? null : fakeBroker(log);
  const svc = await Service.create({
    version: "0.1.0", hostsFile, dataDir: join(dir, "data"), platform, dev: true,
    scheduler: () => { throw new Error("not in this test"); },
    scheduledCommand: () => { throw new Error("not in this test"); },
    autostart: { available: false, isEnabled: async () => false, enable: async () => undefined, disable: async () => undefined },
    registerHotkey: () => true,
    openPath: async () => undefined,
    makeBroker: fake ? () => fake.broker : undefined,
    dnsLog: {
      reader: {
        state: async () => ({ enabled: log.enabled, maxSize: 1 }),
        read: async (after) => (o.events ?? []).filter((e) => e.record > after),
        processes: async () => new Map([[4242, "chrome.exe"]]),
      },
      set: async () => { throw new Error("this process is not elevated"); },
    },
  });
  return { svc, log, hostsFile, broker: fake?.broker, requests: fake?.requests ?? [], done: () => { svc.dispose(); return rm(dir, { recursive: true, force: true }); } };
}

const MIN = 60_000;

test("on a copy: Run as administrator starts the helper; the DNS log goes through it, hosts writes do not", async () => {
  const t = await service();
  try {
    assert.equal((await t.svc.info()).writer, "copy");
    let v = await t.svc.dnsLog();
    assert.equal(v.canSwitch, true);
    assert.equal(v.admin, false);

    await t.svc.elevate();
    v = await t.svc.dnsLog();
    assert.equal(v.admin, true);

    await t.svc.setDnsLog("enable");
    assert.deepEqual(t.requests, [["dnslog", { action: "enable" }]]);

    await t.svc.saveHosts("127.0.0.1 localhost\r\n# edited\r\n");
    assert.equal(t.requests.length, 1, "the copy is written by the app, not the helper");
    assert.match(await readFile(t.hostsFile, "latin1"), /# edited/);
  } finally {
    await t.done();
  }
});

test("without a way to elevate, switching is refused", async () => {
  const t = await service({ withBroker: false });
  try {
    const v = await t.svc.dnsLog();
    assert.equal(v.available, true);
    assert.equal(v.canSwitch, false);
    await assert.rejects(t.svc.setDnsLog("enable"), /administrator rights/);
    await assert.rejects(t.svc.elevate(), /administrator/);
  } finally {
    await t.done();
  }
});

test("timed logging: on for the minutes picked, then switched off; a new Start only moves the time", async () => {
  const t = await service();
  try {
    await assert.rejects(t.svc.setDnsLog("enable", 7), /5, 15, 30, 60 minutes/);
    const start = Date.now();
    let v = await t.svc.setDnsLog("enable", 15);
    assert.equal(v.enabled, true);
    assert.equal(v.ours, true);
    assert.equal(v.overdue, false);
    const until = Date.parse(v.until!);
    assert.ok(until >= start + 15 * MIN && until <= Date.now() + 15 * MIN);

    v = await t.svc.setDnsLog("enable", 5);
    assert.equal(t.requests.length, 1, "already on: no second switch, no prompt");
    assert.ok(Date.parse(v.until!) < until);

    assert.equal(await t.svc.stopDnsLogIfDue(Date.now() + MIN), false, "not yet");
    assert.equal(await t.svc.stopDnsLogIfDue(Date.now() + 6 * MIN), true);
    assert.deepEqual(t.requests.at(-1), ["dnslog", { action: "disable" }]);
    v = await t.svc.dnsLog();
    assert.deepEqual([v.enabled, v.ours, v.until], [false, false, undefined]);
  } finally {
    await t.done();
  }
});

test("a log NullHost has no record of: never switched off automatically, but Stop logging works", async () => {
  const t = await service({ enabled: true });
  try {
    const v = await t.svc.dnsLog();
    assert.deepEqual([v.enabled, v.ours], [true, false]);
    await assert.rejects(t.svc.setDnsLog("enable"), /outside NullHost/);
    await t.svc.elevate();
    await t.svc.stopDnsLogOnQuit();
    assert.equal(await t.svc.stopDnsLogIfDue(Date.now() + 24 * 60 * MIN), false);
    assert.deepEqual(t.requests, [], "no automatic stop");
    assert.equal(t.log.enabled, true);

    await t.svc.setDnsLog("disable");
    assert.deepEqual(t.requests, [["dnslog", { action: "disable" }]]);
    assert.equal(t.log.enabled, false);
  } finally {
    await t.done();
  }
});

test("the record is written before the log is switched on, and kept while the switch waits", async () => {
  const t = await service();
  try {
    let polled: boolean | undefined;
    // the helper is slow (the UAC prompt): the tab polls meanwhile and sees the log still off
    const request = t.broker!.request.bind(t.broker);
    (t.broker as unknown as { request: typeof request }).request = async (op, params) => {
      polled = (await t.svc.dnsLog()).ours;
      return request(op, params);
    };
    const v = await t.svc.setDnsLog("enable", 5);
    assert.equal(polled, true, "already NullHost's while waiting; not forgotten by the poll");
    assert.equal(v.ours, true);
  } finally {
    await t.done();
  }
});

test("a failed switch-on leaves no record", async () => {
  const t = await service();
  try {
    (t.broker as unknown as { request: () => Promise<never> }).request = async () => { throw new Error("Administrator rights were not granted"); };
    await assert.rejects(t.svc.setDnsLog("enable"), /not granted/);
    const v = await t.svc.dnsLog();
    assert.deepEqual([v.enabled, v.ours], [false, false]);
  } finally {
    await t.done();
  }
});

test("time up without administrator rights: no prompt, shown overdue; switched off elsewhere: forgotten", async () => {
  const t = await service();
  try {
    await t.svc.setDnsLog("enable", 5);
    t.broker!.close(); // the helper is gone (e.g. NullHost restarted)
    assert.equal(await t.svc.stopDnsLogIfDue(Date.now() + 6 * MIN), false);
    assert.equal(t.requests.length, 1, "nothing asked for administrator rights");
    assert.equal(t.log.enabled, true);

    t.log.enabled = false; // switched off outside NullHost
    const v = await t.svc.dnsLog();
    assert.deepEqual([v.ours, v.overdue], [false, false]);
  } finally {
    await t.done();
  }
});

test("quitting switches NullHost's own log off while the helper still runs", async () => {
  const t = await service();
  try {
    await t.svc.setDnsLog("enable", 60);
    await t.svc.stopDnsLogOnQuit();
    assert.deepEqual(t.requests.at(-1), ["dnslog", { action: "disable" }]);
    assert.equal(t.log.enabled, false);
  } finally {
    await t.done();
  }
});

test("dnsLog: reads after a record, classifies, names the program", async () => {
  const ev = (record: number, name: string, pid = 4242): DnsEvent => ({ record, time: "2026-11-04T08:00:00Z", pid, name, type: 1, status: 0, results: ["0.0.0.0"] });
  const t = await service({ events: [ev(5, "mine.example"), ev(6, "elsewhere.example", 9)] });
  try {
    const v = await t.svc.dnsLog();
    assert.equal(v.last, 6);
    assert.deepEqual(v.entries.map((e) => [e.name, e.verdict, e.process]), [["mine.example", "own", "chrome.exe"], ["elsewhere.example", "elsewhere", undefined]]);
    const more = await t.svc.dnsLog(6);
    assert.deepEqual(more.entries, []);
    assert.equal(more.last, 6);
  } finally {
    await t.done();
  }
});

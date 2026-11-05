import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Engine,
  RELOAD_KEEP,
  addSample,
  doctor,
  measureReload,
  parseHosts,
  pathsIn,
  pickProbe,
  readHostsFile,
  reloadCheck,
  reloadCost,
  saveState,
  writeWithRetry,
  type Catalog,
  type Platform,
  type State,
} from "../src/index.ts";

const UPSTREAM = "93.184.216.34";

// ---------------------------------------------------------------- units

test("pickProbe: an added host waits for the block address, a removed one for anything else", () => {
  assert.deepEqual(pickProbe(["a.com"], ["a.com", "b.com"]), { host: "b.com", expect: "sink" });
  assert.deepEqual(pickProbe(["a.com", "b.com"], ["a.com"]), { host: "b.com", expect: "other" });
  assert.deepEqual(pickProbe([], ["x.com"]), { host: "x.com", expect: "sink" });
  assert.equal(pickProbe(["a.com"], ["a.com"]), null, "same names: the old table answers the same, nothing to time");
});

test("measureReload counts from the end of the write until the new answer", async () => {
  let t = 1_000;
  let calls = 0;
  const resolve = async () => { t += 1_000; return ++calls < 3 ? UPSTREAM : "0.0.0.0"; };
  const m = await measureReload(resolve, { host: "new.example", expect: "sink" }, { startedAt: 1_000, clock: () => t, intervalMs: 0 });
  assert.deepEqual(m, { ms: 3_000, timedOut: false });

  // a removed host: the old table still blocks it, then a resolver error means it is gone
  t = 0;
  calls = 0;
  const gone = async () => { t += 500; if (++calls < 2) return "0.0.0.0"; throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); };
  assert.deepEqual(await measureReload(gone, { host: "old.example", expect: "other" }, { startedAt: 0, clock: () => t, intervalMs: 0 }), { ms: 1_000, timedOut: false });
});

test("measureReload gives up at the timeout, also while a lookup hangs", async () => {
  let t = 0;
  const never = async () => { t += 1_000; return UPSTREAM; };
  assert.deepEqual(await measureReload(never, { host: "x", expect: "sink" }, { startedAt: 0, clock: () => t, timeoutMs: 5_000, intervalMs: 0 }), { ms: 5_000, timedOut: true });

  const hangs = () => new Promise<string>(() => undefined);
  const real = Date.now();
  const m = await measureReload(hangs, { host: "x", expect: "sink" }, { startedAt: Date.now(), clock: Date.now, timeoutMs: 50 });
  assert.equal(m.timedOut, true);
  assert.ok(Date.now() - real < 2_000);
});

test("reloadCost: median ms per host over writes of 1,000+ hosts, budget for ~3 s, capped at the ceiling", () => {
  const at = "2026-11-05T10:00:00.000Z";
  assert.equal(reloadCost(undefined, 20_000), undefined);
  assert.equal(reloadCost([], 20_000), undefined);

  // 26H2 numbers from the spike: 2.9 s / 10k, 5.8 s / 20k, 12.6 s / 40k
  const c = reloadCost(
    [
      { at, ms: 2_900, hosts: 10_000, probe: "a" },
      { at, ms: 5_800, hosts: 20_000, probe: "a" },
      { at, ms: 12_600, hosts: 40_000, probe: "a" },
      { at, ms: 40, hosts: 12, probe: "a" }, // a disable: too few hosts to say anything per host
    ],
    20_000,
  )!;
  assert.equal(c.basis, 3);
  assert.equal(c.perHostMs, 0.29);
  assert.equal(c.suggestedBudget, 10_000);
  assert.equal(c.last.hosts, 12);
  assert.equal(c.slow, false);

  // the 2026-10-26 build (2.7 s for 74.5k): the measured fit is far above the 20k ceiling, which stays the backstop
  assert.equal(reloadCost([{ at, ms: 2_700, hosts: 74_500, probe: "a" }], 20_000)!.suggestedBudget, 20_000);
  // a much slower build: never below 1,000
  assert.equal(reloadCost([{ at, ms: 60_000, hosts: 10_000, probe: "a", timedOut: true }], 20_000)!.suggestedBudget, 1_000);

  assert.equal(reloadCost([{ at, ms: 6_100, hosts: 20_000, probe: "a" }], 20_000)!.slow, true);
  assert.equal(reloadCost([{ at, ms: 60_000, hosts: 500, probe: "a", timedOut: true }], 20_000)!.slow, true);
  assert.equal(reloadCost([{ at, ms: 500, hosts: 500, probe: "a" }], 20_000)!.perHostMs, undefined);
});

test("addSample keeps the newest samples only", () => {
  let s: ReturnType<typeof addSample> | undefined;
  for (let i = 0; i < RELOAD_KEEP + 5; i++) s = addSample(s, { at: String(i), ms: i, hosts: 1, probe: "a" });
  assert.equal(s!.length, RELOAD_KEEP);
  assert.equal(s!.at(-1)!.ms, RELOAD_KEEP + 4);
  assert.equal(s![0]!.ms, 5);
});

test("reloadCheck: warns over 6 s and suggests a budget from the measured cost", () => {
  const at = "2026-11-05T10:00:00.000Z";
  const slow = reloadCheck(reloadCost([{ at, ms: 12_000, hosts: 20_000, probe: "a" }], 20_000), 20_000)!;
  assert.equal(slow.level, "warn");
  assert.match(slow.detail, /12 s for 20,000 hosts/);
  assert.match(slow.detail, /6\.0 s per 10,000 hosts/);
  assert.match(slow.fix!, /Lower the entry budget to 5,000/);

  const fine = reloadCheck(reloadCost([{ at, ms: 2_900, hosts: 10_000, probe: "a" }], 20_000), 10_000)!;
  assert.equal(fine.level, "ok");

  const roomy = reloadCheck(reloadCost([{ at, ms: 2_000, hosts: 5_000, probe: "a" }], 20_000), 20_000)!;
  assert.equal(roomy.level, "info", "fast now, but the budget allows a slow reload");
  assert.match(roomy.fix!, /7,000 keeps it near 3\.0 s/);

  assert.equal(reloadCheck(undefined, 10_000), null);
});

// ---------------------------------------------------------------- engine on a fake platform

const OUTSIDE = "# hosts\r\n127.0.0.1   alma.local\r\n";

/**
 * A temp hosts file and a pretend DNS Client: after each write it keeps answering
 * from its old table for `lag` lookups (each lookup moves the clock 1 s), then
 * loads the file. Nothing here touches the real hosts file or the real resolver.
 */
async function harness(o: { lag?: number; reloadTimeoutMs?: number; measure?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-reload-"));
  const hostsFile = join(dir, "hosts");
  await writeFile(hostsFile, Buffer.from(OUTSIDE, "latin1"));
  const list = join(dir, "list.txt");
  await writeFile(list, "0.0.0.0 ads.example.com\n0.0.0.0 tracker.example.com\n");
  const catalog: Catalog = { version: "test", sources: [{ id: "a", name: "List A", url: list, format: "hosts", licence: "MIT", tier: "recommended" }] };
  const clock = { now: new Date("2026-11-05T10:00:00.000Z") };
  const dns = { table: new Map<string, string>(), pending: 0, lookups: 0, lag: o.lag ?? 3 };
  const load = async () => {
    const text = await readHostsFile(hostsFile);
    dns.table = new Map();
    for (const line of text.split(/\r?\n/)) {
      const [ip, ...names] = line.split("#")[0]!.trim().split(/\s+/);
      for (const n of names) if (ip) dns.table.set(n.toLowerCase(), ip);
    }
  };
  await load();
  const platform: Platform = {
    name: "windows",
    eol: "\r\n",
    perLine: 9,
    hardCeiling: 20_000,
    systemHostsPath: () => "C:\\Windows\\System32\\drivers\\etc\\hosts",
    isElevated: async () => true,
    readHosts: readHostsFile,
    writeHosts: async (p, c) => {
      const r = await writeWithRetry(p, c);
      dns.pending = dns.lag;
      return r;
    },
    flushDns: async () => undefined,
    resolve: async (host) => {
      dns.lookups++;
      clock.now = new Date(clock.now.getTime() + 1_000);
      if (dns.pending > 0) dns.pending--;
      else await load();
      const ip = dns.table.get(host);
      if (ip) return ip;
      if (host.endsWith(".example.com")) return UPSTREAM;
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    },
  };
  const engine = new Engine({
    platform,
    paths: pathsIn(join(dir, "data")),
    hostsFile,
    catalog,
    now: () => clock.now,
    flush: true,
    measureReload: o.measure ?? true,
    reloadTimeoutMs: o.reloadTimeoutMs,
  });
  const state = async (): Promise<State> => JSON.parse(await readFile(engine.paths.stateFile, "utf8")) as State;
  return { engine, hostsFile, dns, clock, state };
}

test("the reload tests never use the real hosts file", async () => {
  const h = await harness();
  assert.equal(h.engine.isSystemFile, false);
  assert.notEqual(h.engine.hostsFile.toLowerCase(), "c:\\windows\\system32\\drivers\\etc\\hosts");
});

test("apply times the reload and keeps it in state.json with the host count", async () => {
  const h = await harness({ lag: 3 });
  const r = await h.engine.apply();
  assert.equal(r.written, true);
  // 3 lookups still see the old table, the 4th sees the new one: 4 s on the fake clock
  assert.equal(r.write!.reload!.ms, 4_000);
  assert.equal(r.write!.reload!.timedOut, undefined);
  assert.equal(r.write!.reload!.probe, "ads.example.com");
  const text = await readHostsFile(h.hostsFile);
  assert.equal(r.write!.reload!.hosts, parseHosts(text).hosts.length, "every name in the file counts, not only the region");

  const st = await h.state();
  assert.equal(st.reloads?.length, 1);
  assert.deepEqual(st.reloads![0], r.write!.reload);
  assert.equal(st.lastApply?.hosts, 2, "the rest of the state is saved as before");

  const status = await h.engine.status();
  assert.equal(status.reload?.last.ms, 4_000);
  assert.equal(status.reload?.slow, false);
});

test("disable and enable are timed too; an unchanged apply writes nothing and times nothing", async () => {
  const h = await harness({ lag: 1 });
  await h.engine.apply();
  const before = h.dns.lookups;
  const same = await h.engine.apply();
  assert.equal(same.written, false);
  assert.equal(h.dns.lookups, before, "no write, no probe");

  const off = await h.engine.disable();
  assert.equal(off.reload?.ms, 2_000, "the removed name stops resolving to the block address");
  const on = await h.engine.enable();
  assert.equal(on.reload?.ms, 2_000);
  const st = await h.state();
  assert.deepEqual(st.reloads?.map((s) => s.ms), [2_000, 2_000, 2_000]);
  assert.equal(st.blocking.mode, "enabled");
});

test("a write outside the region (the editor) changes no blocked name and is not timed", async () => {
  const h = await harness();
  await h.engine.apply();
  const text = await readHostsFile(h.hostsFile);
  const out = await h.engine.saveEdited(text.replace("alma.local", "alma.local\r\n127.0.0.1   beta.local"));
  assert.equal(out.changed, true);
  assert.equal(out.reload, undefined);
  assert.equal((await h.state()).reloads?.length, 1);
});

test("restore times the reload and saves it, though it loads the state only after the write", async () => {
  const h = await harness({ lag: 0 });
  await h.engine.apply();
  const out = await h.engine.restore("original");
  assert.equal(out.reload?.ms, 1_000);
  assert.equal((await h.state()).reloads?.length, 2);
});

test("a DNS Client that never answers from the new file is recorded as a timeout and warned about", async () => {
  const h = await harness({ lag: 1_000, reloadTimeoutMs: 5_000 });
  const r = await h.engine.apply();
  assert.equal(r.write!.reload!.timedOut, true);
  assert.equal(r.write!.reload!.ms, 5_000);
  const status = await h.engine.status();
  assert.equal(status.reload?.slow, true);
  const c = (await doctor(h.engine)).find((x) => x.id === "reload")!;
  assert.equal(c.level, "warn");
  assert.match(c.detail, /no answer from the new file within 5\.0 s/);
});

test("doctor shows the stored measurement and suggests a budget from it", async () => {
  const h = await harness();
  await h.engine.setOptions({ budget: 20_000 });
  const at = "2026-11-05T10:00:00.000Z";
  const st = await h.engine.state();
  st.reloads = [
    { at, ms: 6_000, hosts: 10_000, probe: "ads.example.com" },
    { at, ms: 12_000, hosts: 20_000, probe: "ads.example.com" },
  ];
  await saveState(h.engine.paths.stateFile, st);
  const c = (await doctor(h.engine)).find((x) => x.id === "reload")!;
  assert.equal(c.level, "warn");
  assert.match(c.detail, /12 s for 20,000 hosts/);
  assert.match(c.fix!, /Lower the entry budget to 5,000/);
  assert.equal((await h.engine.status()).reload?.suggestedBudget, 5_000);
  // the fixed ceiling stays the backstop: a measured fit never raises it
  assert.equal(h.engine.platform.hardCeiling, 20_000);
});

test("without measureReload (a copy of the hosts file, by default) nothing is looked up", async () => {
  const h = await harness({ measure: false });
  const r = await h.engine.apply();
  assert.equal(r.written, true);
  assert.equal(r.write!.reload, undefined);
  assert.equal(h.dns.lookups, 0);
  assert.equal((await h.state()).reloads, undefined);
  assert.equal((await doctor(h.engine)).some((x) => x.id === "reload"), false, "not the system file: no 'not measured yet' either");
});

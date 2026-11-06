// In-memory stand-in for the main process, used only when the UI runs in a plain
// browser (`yarn dev:web`) for review. Nothing here touches a file.
import { parseAllowText } from "@nullhost/core/allowtext";
import type { ApplySummary, DesktopSettings, DnsLogEntry, DnsLogView, NullhostApi, SourceView, Status } from "../shared/api";

export function createMockApi(): NullhostApi {
  const listeners = new Set<() => void>();
  const progress = new Set<(step: string) => void>();
  const changed = () => listeners.forEach((l) => l());
  let mode: "enabled" | "disabled" | "paused" = "enabled";
  let until = "";
  const at = new Date(Date.now() - 2 * 3600_000).toISOString();
  const run = (kept: number, added?: number, removed?: number) => ({ from: "network" as const, at, bytes: 0, parsed: kept, kept, unique: kept, added, removed });
  let sources: SourceView[] = [
    { id: "petelowe", name: "Pete Lowe (pgl.yoyo.org)", url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts", format: "hosts", licence: "MCRAE", tier: "recommended", category: "ads", enabled: true, lastRun: run(3_564, 0, 0) },
    { id: "sb-own", name: "StevenBlack: own additions", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/data/StevenBlack/hosts", format: "hosts", licence: "MIT", tier: "recommended", category: "ads + tracking", enabled: true, lastRun: run(2_892, 6, 1) },
    { id: "stevenblack", name: "StevenBlack unified", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts", format: "hosts", licence: "MIT", tier: "stricter", category: "ads + malware", warning: "About 78k hosts: about 23 s of DNS stall per reload on Windows 11 26H2.", enabled: false },
    { id: "pollock", name: "Dan Pollock (someonewhocares.org)", url: "https://someonewhocares.org/hosts/zero/hosts", format: "hosts", licence: "Non-commercial use only", tier: "stricter", category: "ads + tracking + malware", warning: "About 13k hosts: with the recommended lists about 19k, over a 10k budget (about 6 s per reload on Windows 11 26H2).", enabled: false },
    { id: "kadhosts", name: "KADhosts", url: "https://raw.githubusercontent.com/PolishFiltersTeam/KADhosts/master/KADhosts.txt", format: "hosts", licence: "CC BY-SA 4.0", tier: "stricter", category: "scam + fraud", enabled: false },
    { id: "hagezi-multi", name: "HaGeZi Multi Normal", url: "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists-legacy@latest/hosts/multi.txt", format: "hosts", licence: "GPL-3.0", tier: "stricter", category: "ads + tracking + scam", warning: "About 365k hosts in hosts format: over the Windows hard ceiling on its own.", enabled: false },
    { id: "sb-gambling", name: "StevenBlack: gambling only", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts", format: "hosts", licence: "MIT", tier: "optional", category: "gambling", enabled: false },
    { id: "hagezi-winoffice", name: "HaGeZi: Windows & Office telemetry", url: "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists-legacy@latest/hosts/native.winoffice.txt", format: "hosts", licence: "GPL-3.0", tier: "optional", category: "telemetry", warning: "Can break Microsoft services and trips Defender's HostsFileHijack detection.", enabled: false },
  ];
  let allow = ["cdn.segment.com", "*.sentry.io", "www.googletagmanager.com"];
  let hostsText =
    "# Copyright (c) 1993-2009 Microsoft Corp.\r\n#\r\n# localhost name resolution is handled within DNS itself.\r\n\r\n127.0.0.1   alma.local\r\n127.0.0.1   trader.local\r\n192.168.1.10 nas.home\r\n\r\n" +
    "# Added by Docker Desktop\r\n192.168.65.254 host.docker.internal\r\n# End of section\r\n\r\n" +
    "# >>> nullhost managed (generated=2026-10-26T07:30:12.000Z, hosts=6444, perLine=9, status=enabled) >>>\r\n# Sources: Pete Lowe (pgl.yoyo.org) (MCRAE), StevenBlack: own additions (MIT)\r\n# Do not edit between the markers; NullHost rewrites this region. Your own entries outside it are preserved.\r\n" +
    "0.0.0.0 a-ads.com a.adroll.com a.mobtrks.com a.opttimal.com a.sakh.com a.yieldmo.com a2.adform.net a22.adform.net ad.360yield.com\r\n0.0.0.0 ad.doubleclick.net ad.adview.cn ad.afy11.net ad.agkn.com ad.amgdgt.com ad.atdmt.com ad.duga.jp ad.foxnetworks.com ad.gt\r\n" +
    "# <<< nullhost managed <<<\r\n";
  let schedule: import("../shared/api").ScheduleStatus = { installed: true, available: true, at: "07:30", lastRun: new Date(Date.now() - 6 * 3600_000).toISOString(), lastResult: 0, nextRun: new Date(Date.now() + 18 * 3600_000).toISOString() };
  let settings: DesktopSettings = { theme: "system", startAtLogin: true, startAtLoginAvailable: true, hotkey: "Control+Alt+H", hotkeyRegistered: true, ip: "0.0.0.0", budget: 150_000, hardCeiling: 180_000, checkAppUpdates: true };
  let skipped = "";
  const appUpdate = (): import("../shared/api").AppUpdate => ({ enabled: settings.checkAppUpdates, current: "0.1.0", latest: "0.1.1", url: "https://github.com/evosys21/nullhost/releases/tag/v0.1.1", newer: true, available: settings.checkAppUpdates && skipped !== "0.1.1", checkedAt: at, canInstall: true });
  const status = (): Status => ({
    hostsFile: "C:\\Windows\\System32\\drivers\\etc\\hosts",
    systemFile: true,
    platform: "windows",
    blocking: mode === "paused" ? { mode, until } : { mode },
    leftovers: { hosts: 17_644, linesBefore: 26_820, linesAfter: 9_440 },
    region: { present: true, count: 1, unterminated: false, hosts: mode === "enabled" ? 74_550 : 0, lines: mode === "enabled" ? 8_288 : 5, generated: at, status: mode, modifiedExternally: false },
    config: { enabled: sources.filter((s) => s.enabled).map((s) => s.id), userSources: 0, allowlist: allow.length, budget: settings.budget },
    lastUpdate: { at, hosts: 6_444, sources: Object.fromEntries(sources.filter((s) => s.lastRun).map((s) => [s.id, s.lastRun!])) },
    lastApply: { at, hosts: 6_444, lines: 8_288, mode: "enabled" },
    snapshots: 7,
    hasOriginal: true,
  });
  const summary = (): ApplySummary => ({ mode, hosts: 74_862, lines: 8_319, diff: { added: 312, removed: 41, sampleAdded: [], sampleRemoved: [] }, written: true, pending: false, dryRun: false, warnings: [], runs: {} });
  const done = async <T>(v: T) => { await new Promise((r) => setTimeout(r, 250)); changed(); return v; };
  // the DNS log: a few made-up lookups per read while it is on
  let dnsOn = false;
  let record = 0;
  const LOOKUPS: Array<[string, string, DnsLogEntry["verdict"], string[]?, string?]> = [
    ["www.google.com", "chrome.exe", "resolved"],
    ["ad.doubleclick.net", "chrome.exe", "blocked", ["Pete Lowe (pgl.yoyo.org)", "StevenBlack: own additions"]],
    ["a.adroll.com", "chrome.exe", "blocked", ["StevenBlack: own additions"]],
    ["cdn.segment.com", "Code.exe", "allowed", ["StevenBlack: own additions"], "cdn.segment.com"],
    ["github.com", "Code.exe", "resolved"],
    ["alma.local", "firefox.exe", "own"],
    ["settings-win.data.microsoft.com", "svchost.exe", "resolved"],
    ["login.live.com", "OneDrive.exe", "resolved"],
    ["typo.invalid", "chrome.exe", "failed"],
    ["browser.events.data.msn.com", "msedge.exe", "blocked", ["StevenBlack: own additions"]],
  ];
  const lookup = (): DnsLogEntry => {
    const [name, process, verdict, listedBy, allowedBy] = LOOKUPS[Math.floor(Math.random() * LOOKUPS.length)]!;
    const aaaa = Math.random() < 0.3;
    const failed = verdict === "failed";
    const results = verdict === "blocked" || verdict === "own" ? (aaaa ? [] : ["0.0.0.0"]) : failed ? [] : aaaa ? ["2a00:1450:4001:82b::2004"] : ["142.250.185.68"];
    const status = failed ? 9003 : results.length ? 0 : 9501;
    return { record: ++record, time: new Date().toISOString(), pid: 4242, name, type: aaaa ? 28 : 1, typeName: aaaa ? "AAAA" : "A", status, statusText: status ? (failed ? "no such name" : "no records of this type") : undefined, results, verdict, listedBy, allowedBy, process };
  };
  let admin = false;
  let dnsUntil: string | undefined;
  const dnsView = (entries: DnsLogEntry[] = []): DnsLogView => {
    if (dnsUntil && Date.parse(dnsUntil) <= Date.now() && admin) { dnsOn = false; dnsUntil = undefined; }
    return { available: true, enabled: dnsOn, canSwitch: true, admin, ours: dnsUntil !== undefined, until: dnsUntil, overdue: dnsUntil !== undefined && Date.parse(dnsUntil) <= Date.now(), entries, last: record };
  };
  return {
    info: async () => ({ version: "0.1.0", platform: "windows", hostsFile: "C:\\Windows\\System32\\drivers\\etc\\hosts", systemFile: true, elevated: false, writer: "helper", helperRunning: false, pauseEnded: false, canWrite: true, dataDir: "%LOCALAPPDATA%\\NullHost", configFile: "%APPDATA%\\NullHost\\config.toml", dev: true, portable: false }),
    status: async () => status(),
    sources: async () => sources,
    setSource: async (id, on) => { sources = sources.map((s) => (s.id === id ? { ...s, enabled: on } : s)); return done(undefined); },
    addSource: async (url, name) => { const s: SourceView = { id: "user-" + (name ?? "list").toLowerCase().replace(/\W+/g, "-"), name: name ?? url, url, format: "hosts", licence: "", tier: "user", enabled: true }; sources = [...sources, s]; return done(s); },
    removeSource: async (id) => { sources = sources.filter((s) => s.id !== id); return done(undefined); },
    allowlist: async () => allow,
    allowAdd: async (p) => { if (!allow.includes(p)) allow = [...allow, p]; return done(undefined); },
    allowRemove: async (p) => { allow = allow.filter((x) => x !== p); return done(undefined); },
    allowSave: async (text) => { const r = parseAllowText(text); allow = r.patterns; return done(r); },
    check: async (host) => {
      const h = host.trim().toLowerCase();
      const allowed = allow.find((p) => p === h || (p.startsWith("*.") && h.endsWith(p.slice(1))));
      const listed = /ad|track|doubleclick|segment/.test(h) ? ["Pete Lowe (pgl.yoyo.org)", "StevenBlack: own additions"] : [];
      return { host: h, listedBy: listed, allowedBy: listed.length ? allowed : undefined, wouldBlock: listed.length > 0 && !allowed, blockedNow: listed.length > 0 && !allowed && mode === "enabled", ownEntry: false };
    },
    update: async () => {
      // the real engine's steps, so the busy toast can be reviewed in the browser
      for (const step of ["Downloading Pete Lowe (pgl.yoyo.org) (1 of 2)", "Downloading StevenBlack: own additions (2 of 2)", "Merging 2 lists", "Writing the hosts file", "Flushing the DNS cache"]) {
        for (const cb of progress) cb(step);
        await new Promise((r) => setTimeout(r, 700));
      }
      return done(summary());
    },
    apply: async () => done(summary()),
    enable: async () => { mode = "enabled"; return done(undefined); },
    disable: async () => { mode = "disabled"; return done(undefined); },
    toggle: async () => { mode = mode === "enabled" ? "disabled" : "enabled"; return done(undefined); },
    pause: async (u) => { mode = "paused"; until = u; return done(undefined); },
    readHosts: async () => hostsText,
    saveHosts: async (t) => { hostsText = t; return done(undefined); },
    restore: async () => done(undefined),
    removeRegion: async () => done(undefined),
    planTidy: async () => ({ removeSink0: 7_878, removeLoopback: 9_766, linesDropped: 17_380, linesShortened: 3, keptOwnBlocks: 789, linesBefore: 26_820, linesAfter: 9_440, sampleRemoved: ["fr.a2dfp.net", "mfr.a2dfp.net"], sampleKept: ["projects.mine", "activate.adobe.com"] }),
    tidy: async () => done({ removeSink0: 7_878, removeLoopback: 9_766, linesDropped: 17_380, linesShortened: 3, keptOwnBlocks: 789, linesBefore: 26_820, linesAfter: 9_440, sampleRemoved: [], sampleKept: [] }),
    settings: async () => settings,
    setSettings: async (s) => { settings = { ...settings, ...s }; return done(settings); },
    openBackupFolder: async () => undefined,
    exportSettings: async () => done(String.raw`C:\Users\you\Documents\nullhost-settings.toml`),
    importSettings: async () => done({ file: String.raw`C:\Users\you\Documents\nullhost-settings.toml`, enabled: sources.filter((s) => s.enabled).length, userSources: 0, allowlist: allow.length }),
    doctor: async () => [
      { id: "hosts-read", level: "ok", label: "Hosts file readable", detail: "C:\Windows\System32\drivers\etc\hosts" },
      { id: "elevated", level: "ok", label: "Running as administrator", detail: "NullHost can change the hosts file" },
      { id: "region", level: "ok", label: "NullHost region", detail: "74,550 hosts in 8,288 lines" },
      { id: "dnscache", level: "ok", label: "DNS Client service", detail: "running" },
      { id: "defender", level: "warn", label: "Defender exclusion for the hosts file", detail: "not set: Defender may revert the file", fix: "Windows Security > Virus & threat protection > Exclusions > Add the hosts file" },
      { id: "resolve", level: "ok", label: "Resolver uses the file", detail: "a-ads.com -> 0.0.0.0" },
    ],
    schedule: async () => schedule,
    setSchedule: async (at) => { schedule = at ? { installed: true, available: true, at, nextRun: "tomorrow " + at } : { installed: false, available: true }; return done(schedule); },
    appUpdate: async () => appUpdate(),
    checkAppUpdate: async () => { skipped = ""; return done(appUpdate()); },
    skipAppUpdate: async (v) => { skipped = v; return done(appUpdate()); },
    installAppUpdate: async () => { throw new Error("The preview cannot install anything."); },
    conflicts: async () => ["HostsMan (hm.exe)"],
    dnsLog: async (after = 0) => dnsView(dnsOn ? Array.from({ length: after ? Math.floor(Math.random() * 4) : 40 }, lookup) : []),
    setDnsLog: async (action, minutes = 5) => {
      admin = true;
      if (action === "clear") record = 0;
      else {
        dnsOn = action === "enable";
        dnsUntil = dnsOn ? new Date(Date.now() + minutes * 60_000).toISOString() : undefined;
      }
      return done(dnsView());
    },
    elevate: async () => { admin = true; return done(undefined); },
    onChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onProgress: (cb) => { progress.add(cb); return () => progress.delete(cb); },
  };
}

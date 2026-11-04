import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Engine,
  HostsAccessError,
  HostsBusyError,
  OverCeilingError,
  currentPlatform,
  defaultPaths,
  pathsIn,
  type ApplyResult,
  type BuildResult,
  type Platform,
  type SourceFormat,
  type Status,
  type WriteOutcome,
  type Scheduler,
  type ExportFormat,
  BusyError,
  doctor,
  windowsScheduler,
  EXPORT_FORMATS,
} from "@nullhost/core";

export const VERSION = "0.1.5";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  platform?: Platform;
  /** the daily-update task; tests inject a fake */
  scheduler?: (elevated: boolean) => Scheduler;
}

const EXIT = { ok: 0, error: 1, usage: 2, elevation: 3, busy: 4 } as const;

const HELP = `NullHost ${VERSION}: hosts-file ad and tracker blocker

Usage: nullhost <command> [options]

Blocking
  status                          enabled/disabled, hosts, last update, warnings
  update [--fetch-only]           download changed sources, then apply (what "Update lists" does)
  apply [--dry-run] [--diff]      rebuild from the cache and write, no downloads
  enable | disable                turn blocking on or off; your own entries stay
  pause <15m|1h|1h30m|until HH:MM>
  check <host>                    is it blocked, and by which source?

Sources and allowlist
  source list
  source enable <id...> | source disable <id...>
  source add <url|path> [--name <name>] [--format hosts|domains|adblock|dnsmasq]
  source remove <id>
  allow list | allow add <pattern> | allow remove <pattern>
                                  patterns: host, *.suffix, /regex/

Safety
  restore previous|original       write back a snapshot (taken before every write)
  remove                          delete NullHost's region from the hosts file
  tidy [--dry-run]                remove old block entries outside the region that NullHost
                                  already blocks (HostsMan leftovers); your own entries stay
  paths                           where config, cache and snapshots live
  doctor                          read-only health checks (DNS Client, Defender, region, ...)

Automatic updates and lists
  schedule status | remove        the daily update task (switch it on in the NullHost app)
  catalog show                    the lists NullHost offers (they come with each release)
  export --format hosts|domains|dnsmasq|unbound [--out <file>]

Options
  --hosts-file <path>   work on this file instead of the system hosts file (env NULLHOST_HOSTS_FILE)
  --data-dir <dir>      keep config, cache and snapshots here (env NULLHOST_DATA_DIR)
  --config <file>       use this config.toml (the scheduled task passes yours explicitly)
  --json                machine-readable output
  --no-elevate          never relaunch elevated (M1 never does; accepted for the scheduler)
  -h, --help | --version

Writing the system hosts file needs an elevated terminal.`;

const fmt = (n: number) => n.toLocaleString("en-US");

function jsonable(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, x) => (x instanceof Map ? undefined : x)),
  );
}

function stripBuild(b: BuildResult) {
  const { owners: _o, allowlistedOwners: _a, hosts, ...rest } = b;
  return { ...rest, hosts: hosts.length };
}

/** "15m", "1h", "1h30m", "90s", or ["until", "07:30"] */
export function parsePause(args: string[], now: Date): Date {
  if (args[0] === "until" && args[1]) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(args[1]);
    if (!m) throw new UsageError(`expected HH:MM after "until", got ${args[1]}`);
    const t = new Date(now);
    t.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t;
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(args[0] ?? "");
  if (!m || !args[0]) throw new UsageError("pause needs a duration like 15m, 1h, 1h30m or until HH:MM");
  const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
  if (ms <= 0) throw new UsageError("pause duration must be positive");
  return new Date(now.getTime() + ms);
}

class UsageError extends Error {}

function describeWrite(w: WriteOutcome | undefined): string {
  if (!w || !w.changed) return "hosts file unchanged (no DNS reload)";
  const wait = w.report && w.report.waitedMs > 0 ? `, waited ${Math.round(w.report.waitedMs / 100) / 10} s for the lock` : "";
  const flush = w.flushed ? ", DNS cache flushed" : w.flushError ? `, DNS flush failed: ${w.flushError}` : "";
  return `hosts file written${wait}${flush}`;
}

function printApply(io: Io, r: ApplyResult, label: string): void {
  for (const [id, run] of Object.entries(r.build.runs)) {
    const change = run.added !== undefined ? `  +${fmt(run.added)} / -${fmt(run.removed ?? 0)}` : "";
    const err = run.error ? `  (${run.error})` : "";
    io.out(`  ${id.padEnd(18)} ${run.from.padEnd(14)} ${fmt(run.kept).padStart(9)} hosts${change}${err}`);
  }
  io.out(`${label}: ${fmt(r.hosts)} hosts in ${fmt(r.lines)} lines; ${fmt(r.diff.added)} added, ${fmt(r.diff.removed)} removed`);
  if (r.diff.added && r.diff.sampleAdded.length) io.out(`  added e.g.   ${r.diff.sampleAdded.slice(0, 5).join(", ")}`);
  if (r.diff.removed && r.diff.sampleRemoved.length) io.out(`  removed e.g. ${r.diff.sampleRemoved.slice(0, 5).join(", ")}`);
  if (r.dryRun) io.out("dry run: nothing written");
  else if (r.pending) io.out(`blocking is ${r.mode}: changes stored, they are written when you enable`);
  else io.out(describeWrite(r.write));
  for (const w of r.build.warnings) io.err(`warning: ${w}`);
}

function printStatus(io: Io, s: Status): void {
  const b = s.blocking;
  const mode = b.mode === "paused" ? `paused until ${new Date(b.until).toLocaleString()}` : b.mode;
  io.out(`Hosts blocking is ${mode}.`);
  io.out(`  hosts file     ${s.hostsFile}${s.systemFile ? "" : "  (not the system file)"}`);
  io.out(`  region         ${s.region.present ? `${fmt(s.region.hosts)} hosts, ${fmt(s.region.lines)} lines, generated ${s.region.generated}` : "not present"}`);
  io.out(`  sources        ${s.config.enabled.join(", ") || "(none enabled)"}`);
  io.out(`  allowlist      ${s.config.allowlist} pattern(s); budget ${fmt(s.config.budget)} hosts`);
  if (s.lastUpdate) io.out(`  last update    ${s.lastUpdate.at} (${fmt(s.lastUpdate.hosts)} hosts)`);
  if (s.lastApply) io.out(`  last write     ${s.lastApply.at} (${s.lastApply.mode}, ${fmt(s.lastApply.hosts)} hosts)`);
  io.out(`  snapshots      ${s.snapshots}${s.hasOriginal ? " + original" : ""}`);
  if (s.leftovers.hosts) io.err(`note: ${fmt(s.leftovers.hosts)} old block entries outside the region are already covered by NullHost (HostsMan leftovers?); preview with: nullhost tidy --dry-run`);
  if (s.region.modifiedExternally) io.err("warning: the managed region was changed by something else since NullHost wrote it");
  if (s.region.count > 1) io.err(`warning: ${s.region.count} managed regions found; the next write merges them into one`);
  if (s.region.unterminated) io.err("warning: NullHost's start and end markers do not pair up; NullHost does not write the file until they are fixed (edit the file, or: nullhost restore previous)");
  if (b.mode === "paused" && new Date(b.until).getTime() <= Date.now()) io.err("note: the pause has expired; blocking resumes on the next update, apply or enable");
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "hosts-file": { type: "string" },
        "data-dir": { type: "string" },
        config: { type: "string" },
        out: { type: "string" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
        diff: { type: "boolean" },
        "fetch-only": { type: "boolean" },
        "no-elevate": { type: "boolean" },
        name: { type: "string" },
        format: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (err) {
    io.err((err as Error).message);
    io.err("run `nullhost --help` for usage");
    return EXIT.usage;
  }
  const { values: v, positionals: [cmd, ...rest] } = parsed;
  if (v.version) { io.out(VERSION); return EXIT.ok; }
  if (v.help || !cmd) { io.out(HELP); return cmd || v.help ? EXIT.ok : EXIT.usage; }

  const platform = io.platform ?? currentPlatform();
  const dataDir = v["data-dir"] ?? io.env.NULLHOST_DATA_DIR;
  const basePaths = dataDir ? pathsIn(dataDir) : defaultPaths(io.env);
  const paths = v.config ? { ...basePaths, configFile: resolve(v.config) } : basePaths;
  const engine = new Engine({
    platform,
    paths,
    hostsFile: v["hosts-file"] ?? io.env.NULLHOST_HOSTS_FILE,
    now: io.now,
  });
  let elevatedCache: boolean | undefined;
  const elevated = async () => (elevatedCache ??= await platform.isElevated());
  const scheduler = () => (io.scheduler ?? ((e: boolean) => windowsScheduler(e && platform.name === "windows")))(elevatedCache ?? false);
  const now = io.now ?? (() => new Date());
  const json = (x: unknown) => io.out(JSON.stringify(jsonable(x), null, 2));

  // one decision for both the elevation check and what runs: a preview never writes
  const preview =
    (cmd === "update" && Boolean(v["fetch-only"] || v["dry-run"])) ||
    (cmd === "apply" && Boolean(v["dry-run"] || v.diff)) ||
    (cmd === "tidy" && Boolean(v["dry-run"]));
  const writes = ["enable", "disable", "pause", "restore", "remove", "update", "apply", "tidy"].includes(cmd) && !preview;
  const canWrite = !engine.isSystemFile || (await elevated());
  if (cmd === "schedule" && rest[0] === "remove" && !(await elevated())) {
    io.err("Removing the scheduled task needs an elevated terminal.");
    return EXIT.elevation;
  }
  if (writes && !canWrite) {
    io.err(`This writes the system hosts file (${engine.hostsFile}) and needs an elevated terminal.`);
    io.err("Open the terminal as administrator and run the command again. (--hosts-file <path> works on a copy.)");
    return EXIT.elevation;
  }

  try {
    // An expired pause is resumed only by a command that writes the region anyway.
    // enable resumes by itself; disable, pause, restore and remove replace the pause.
    if (writes && canWrite && (cmd === "update" || cmd === "apply")) {
      if (await engine.resumeIfDue()) io.err("note: the pause had expired; blocking was turned back on");
    }

    switch (cmd) {
      case "status": {
        const s = await engine.status();
        if (v.json) json(s);
        else printStatus(io, s);
        return EXIT.ok;
      }
      case "update": {
        const r = await engine.update({ fetchOnly: v["fetch-only"], dryRun: v["dry-run"] });
        if (v.json) json({ ...r, build: stripBuild(r.build) });
        else printApply(io, r, v["fetch-only"] ? "fetched" : "updated");
        return EXIT.ok;
      }
      case "apply": {
        const r = await engine.apply({ dryRun: preview });
        if (v.json) json({ ...r, build: stripBuild(r.build) });
        else {
          printApply(io, r, "applied");
          if (v.diff) {
            for (const h of r.diff.sampleAdded) io.out(`+ ${h}`);
            for (const h of r.diff.sampleRemoved) io.out(`- ${h}`);
            if (r.diff.added + r.diff.removed > r.diff.sampleAdded.length + r.diff.sampleRemoved.length) io.out("(first 10 of each shown)");
          }
        }
        return EXIT.ok;
      }
      case "enable":
      case "disable": {
        const w = cmd === "enable" ? await engine.enable() : await engine.disable();
        if (v.json) json(w);
        else io.out(`Hosts blocking is ${cmd}d; ${describeWrite(w)}`);
        return EXIT.ok;
      }
      case "pause": {
        const until = parsePause(rest, now());
        const w = await engine.pause(until);
        if (v.json) json({ until: until.toISOString(), ...w });
        else io.out(`Hosts blocking is paused until ${until.toLocaleString()}; ${describeWrite(w)}`);
        return EXIT.ok;
      }
      case "check": {
        if (!rest[0]) throw new UsageError("check needs a host name");
        const c = await engine.check(rest[0]);
        if (v.json) { json(c); return EXIT.ok; }
        const listed = c.listedBy.length ? `listed by ${c.listedBy.join(", ")}` : "not in any enabled source";
        const allow = c.allowedBy ? `, allowed by your allowlist entry ${c.allowedBy}` : "";
        io.out(`${c.host}: ${listed}${allow}.`);
        io.out(`  blocked now: ${c.blockedNow ? "yes" : "no"}${c.ownEntry ? "; also blocked by your own entry outside NullHost's region" : ""}`);
        if (c.wouldBlock !== c.blockedNow) io.out(`  after the next apply: ${c.wouldBlock ? "blocked" : "not blocked"}`);
        return EXIT.ok;
      }
      case "restore": {
        const which = rest[0];
        if (which !== "previous" && which !== "original") throw new UsageError("restore previous|original");
        const w = await engine.restore(which);
        if (v.json) json(w);
        else io.out(`Restored ${which} from ${w.from}; ${describeWrite(w)}`);
        return EXIT.ok;
      }
      case "tidy": {
        if (v["dry-run"]) {
          const p = await engine.planTidy();
          if (v.json) { json(p); return EXIT.ok; }
          io.out(`would remove ${fmt(p.removeSink0 + p.removeLoopback)} hosts already in NullHost's region (${fmt(p.removeSink0)} at 0.0.0.0, ${fmt(p.removeLoopback)} at 127.0.0.1)`);
          io.out(`lines ${fmt(p.linesBefore)} -> ${fmt(p.linesAfter)}; ${fmt(p.keptOwnBlocks)} of your own entries stay`);
          if (p.sampleRemoved.length) io.out(`  removed e.g. ${p.sampleRemoved.slice(0, 5).join(", ")}`);
          if (p.sampleKept.length) io.out(`  kept e.g.    ${p.sampleKept.slice(0, 5).join(", ")}`);
          return EXIT.ok;
        }
        const r = await engine.tidy();
        if (v.json) json(r);
        else io.out(`Removed ${fmt(r.plan.removeSink0 + r.plan.removeLoopback)} leftover hosts; lines ${fmt(r.plan.linesBefore)} -> ${fmt(r.plan.linesAfter)}; ${describeWrite(r)}. Undo with: nullhost restore previous`);
        return EXIT.ok;
      }
      case "remove": {
        const w = await engine.remove();
        if (v.json) json(w);
        else io.out(`NullHost's region removed; ${describeWrite(w)}`);
        return EXIT.ok;
      }
      case "allow": {
        const [sub, pattern] = rest;
        if (sub === "list" || !sub) {
          const list = (await engine.config()).allowlist;
          if (v.json) json(list);
          else io.out(list.length ? list.join("\n") : "(allowlist is empty)");
          return EXIT.ok;
        }
        if (!pattern) throw new UsageError(`allow ${sub} needs a pattern`);
        if (sub === "add") {
          await engine.allowAdd(pattern);
          if (v.json) json({ added: pattern, allowlist: (await engine.config()).allowlist });
          else io.out(`allowed ${pattern}; run \`nullhost apply\` to write it`);
          return EXIT.ok;
        }
        if (sub === "remove") {
          const removed = await engine.allowRemove(pattern);
          if (v.json) json({ removed: removed ? pattern : null, allowlist: (await engine.config()).allowlist });
          else io.out(removed ? `removed ${pattern}; run \`nullhost apply\` to write it` : `${pattern} was not in the allowlist`);
          return EXIT.ok;
        }
        throw new UsageError("allow list|add|remove");
      }
      case "source": {
        const [sub, ...args] = rest;
        if (sub === "list" || !sub) {
          const all = await engine.allSources();
          if (v.json) { json(all); return EXIT.ok; }
          for (const s of all) {
            io.out(`${s.enabled ? "[x]" : "[ ]"} ${s.id.padEnd(18)} ${s.tier.padEnd(11)} ${s.name}${s.warning ? `  (${s.warning})` : ""}`);
          }
          return EXIT.ok;
        }
        if (sub === "enable" || sub === "disable") {
          if (!args.length) throw new UsageError(`source ${sub} needs at least one id`);
          for (const id of args) await engine.setSourceEnabled(id, sub === "enable");
          if (v.json) json({ action: sub, ids: args, enabled: (await engine.config()).enabled });
          else io.out(`${sub}d ${args.join(", ")}; run \`nullhost apply\` (or \`update\` for new sources) to write it`);
          return EXIT.ok;
        }
        if (sub === "add") {
          if (!args[0]) throw new UsageError("source add <url|path>");
          const format = (v.format ?? "hosts") as SourceFormat;
          if (!["hosts", "domains", "adblock", "dnsmasq"].includes(format)) throw new UsageError(`unknown format ${format}`);
          const s = await engine.addUserSource(args[0], v.name, format);
          if (v.json) json({ added: s });
          else io.out(`added ${s.id} (${s.name}); run \`nullhost update\` to fetch and write it`);
          return EXIT.ok;
        }
        if (sub === "remove") {
          if (!args[0]) throw new UsageError("source remove <id>");
          await engine.removeUserSource(args[0]);
          if (v.json) json({ removed: args[0] });
          else io.out(`removed ${args[0]}`);
          return EXIT.ok;
        }
        throw new UsageError("source list|enable|disable|add|remove");
      }
      case "doctor": {
        await elevated();
        const checks = await doctor(engine, { schedule: await scheduler().status() });
        if (v.json) { json(checks); return EXIT.ok; }
        const mark = { ok: "ok  ", info: "info", warn: "WARN", error: "FAIL" } as const;
        for (const c of checks) {
          io.out(`[${mark[c.level]}] ${c.label}: ${c.detail}`);
          if (c.fix && c.level !== "ok") io.out(`       ${c.fix}`);
        }
        return checks.some((c) => c.level === "error") ? EXIT.error : EXIT.ok;
      }
      case "schedule": {
        const sub = rest[0] ?? "status";
        const s = scheduler();
        if (sub === "status") {
          const st = await s.status();
          if (v.json) { json(st); return EXIT.ok; }
          if (!st.installed) io.out("Automatic updates are off.");
          else io.out(`Automatic updates: daily at ${st.at ?? "?"}; last run ${st.lastRun ?? "never"}${st.lastResult !== undefined ? ` (result ${st.lastResult})` : ""}; next ${st.nextRun ?? "?"}`);
          return EXIT.ok;
        }
        if (sub === "remove") {
          await s.remove();
          io.out("Automatic updates are off.");
          return EXIT.ok;
        }
        if (sub === "install") throw new UsageError("automatic updates are switched on in the NullHost app (Settings); the command line can only show or remove them");
        throw new UsageError("schedule status|remove");
      }
      case "catalog": {
        const sub = rest[0] ?? "show";
        if (sub === "show") {
          if (v.json) { json(engine.catalog); return EXIT.ok; }
          io.out(`catalog ${engine.catalog.version}: ${engine.catalog.sources.length} lists`);
          for (const s of engine.catalog.sources) io.out(`  ${s.id.padEnd(18)} ${s.tier.padEnd(11)} ${s.name}`);
          return EXIT.ok;
        }
        throw new UsageError("catalog show");
      }
      case "export": {
        const format = (v.format ?? "hosts") as ExportFormat;
        if (!EXPORT_FORMATS.includes(format)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(", ")}`);
        const r = await engine.exportList(format);
        if (v.out) {
          await writeFile(v.out, r.text, "utf8");
          io.err(`wrote ${fmt(r.hosts)} hosts as ${format} to ${v.out}`);
        } else {
          io.out(r.text.endsWith("\n") ? r.text.slice(0, -1) : r.text);
        }
        return EXIT.ok;
      }
      case "paths": {
        const p = { hostsFile: engine.hostsFile, ...engine.paths };
        if (v.json) json(p);
        else for (const [k, x] of Object.entries(p)) io.out(`${k.padEnd(12)} ${x}`);
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) { io.err(err.message); io.err("run `nullhost --help` for usage"); return EXIT.usage; }
    if (err instanceof HostsAccessError && err.reason === "elevation") { io.err(err.message); return EXIT.elevation; }
    if (err instanceof HostsBusyError || err instanceof BusyError) { io.err(err.message); return EXIT.busy; }
    if (err instanceof OverCeilingError || err instanceof Error) { io.err(`error: ${err.message}`); return EXIT.error; }
    io.err(`error: ${String(err)}`);
    return EXIT.error;
  }
}

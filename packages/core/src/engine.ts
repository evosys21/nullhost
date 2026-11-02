import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUILTIN_CATALOG, type Catalog } from "./catalog.ts";
import { configText, loadConfig, parseConfig, saveConfig, userSourceId } from "./config.ts";
import { OverCeilingError, RegionMarkersError, SourcesUnavailableError } from "./errors.ts";
import { exportList, type ExportFormat } from "./export.ts";
import { fetchSource, isRemote } from "./fetch.ts";
import { merge, sorted } from "./merge.ts";
import { allowedBy, compileAllowlist, normalizeAll, normalizeHost, parseAllowRule } from "./normalize.ts";
import { parse, parseHosts } from "./parse.ts";
import type { Paths } from "./paths.ts";
import type { Platform, WriteReport } from "./platform/types.ts";
import {
  compose,
  extractRegion,
  findRegions,
  markersPaired,
  parseRegionHeader,
  regionHosts,
  removeRegion,
  renderRegion,
} from "./render.ts";
import { withFileLock } from "./lock.ts";
import { Snapshots } from "./snapshots.ts";
import { planTidy, type TidyPlan } from "./tidy.ts";
import { loadState, saveState } from "./state.ts";
import type { Blocking, Config, Source, SourceFormat, SourceRun, State } from "./types.ts";

export interface EngineOptions {
  platform: Platform;
  paths: Paths;
  /** defaults to the platform's system hosts file */
  hostsFile?: string;
  catalog?: Catalog;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  snapshotsToKeep?: number;
  /** flush the resolver cache after writes; default: only when writing the system hosts file */
  flush?: boolean;
  /** each step of a long operation, in words ("Downloading AdAway (2 of 3)"); the desktop shows it */
  onProgress?: (step: string) => void;
}

export interface BuildResult {
  /** merged, normalised, allowlist applied, sorted */
  hosts: string[];
  /** host -> ids of the sources listing it */
  owners: Map<string, string[]>;
  /** host -> ids of the sources listing it, for hosts the allowlist removed */
  allowlistedOwners: Map<string, string[]>;
  sources: Source[];
  runs: Record<string, SourceRun>;
  failed: string[];
  unknownIds: string[];
  allowlistErrors: string[];
  warnings: string[];
  overBudget: boolean;
  overCeiling: boolean;
}

export interface Diff {
  added: number;
  removed: number;
  sampleAdded: string[];
  sampleRemoved: string[];
}

export interface WriteOutcome {
  /** false when the file already had exactly this content */
  changed: boolean;
  snapshot?: string;
  report?: WriteReport;
  flushed: boolean;
  flushError?: string;
}

export interface ApplyResult {
  mode: Blocking["mode"];
  hosts: number;
  lines: number;
  diff: Diff;
  /** the hosts file was rewritten */
  written: boolean;
  /** built and cached, but not written because blocking is disabled or paused */
  pending: boolean;
  dryRun: boolean;
  build: BuildResult;
  write?: WriteOutcome;
}

export interface CheckResult {
  host: string;
  /** names of enabled sources that list it */
  listedBy: string[];
  /** the allowlist pattern that lets it through */
  allowedBy?: string;
  /** listed and not allowlisted: the next apply blocks it */
  wouldBlock: boolean;
  /** blocked by the managed region currently in the hosts file */
  blockedNow: boolean;
  /** the user's own entry outside the managed region blocks it */
  ownEntry: boolean;
}

export interface Status {
  hostsFile: string;
  systemFile: boolean;
  platform: Platform["name"];
  blocking: Blocking;
  region: {
    present: boolean;
    count: number;
    unterminated: boolean;
    hosts: number;
    lines: number;
    generated?: string;
    status?: string;
    modifiedExternally: boolean;
  };
  /** block entries outside the region that the region already covers (HostsMan leftovers); `nullhost tidy` removes them */
  leftovers: { hosts: number; linesBefore: number; linesAfter: number };
  config: { enabled: string[]; userSources: number; allowlist: number; budget: number };
  lastUpdate?: State["lastUpdate"];
  lastApply?: State["lastApply"];
  cachedRegion?: State["cachedRegion"];
  snapshots: number;
  hasOriginal: boolean;
}

const WRITE_METHODS = ["update", "apply", "enable", "disable", "pause", "resumeIfDue", "restore", "remove", "tidy", "saveEdited"] as const;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
/** the region without its first line, which carries the generation timestamp */
const regionBody = (r: string) => r.slice(r.indexOf("\n") + 1);

function diffHosts(before: string[], after: string[], sample = 10): Diff {
  const a = new Set(before);
  const b = new Set(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const h of b) if (!a.has(h)) added.push(h);
  for (const h of a) if (!b.has(h)) removed.push(h);
  return { added: added.length, removed: removed.length, sampleAdded: added.slice(0, sample), sampleRemoved: removed.slice(0, sample) };
}

function modeFromHeader(status: string | undefined): Blocking {
  if (!status || status === "enabled") return { mode: "enabled" };
  const m = /^paused until (.+)$/.exec(status);
  if (m) return { mode: "paused", until: m[1]! };
  return { mode: "disabled" };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, "latin1");
  await rename(tmp, file);
}

/**
 * The NullHost engine: everything the CLI and the desktop app do goes through here.
 * It owns config.toml, state.json, the source cache, snapshots and the managed
 * region in the hosts file. It never touches anything outside the region, except
 * for "restore", which writes back a whole snapshot.
 */
export class Engine {
  readonly platform: Platform;
  readonly paths: Paths;
  readonly hostsFile: string;
  readonly isSystemFile: boolean;
  catalog: Catalog;
  readonly snapshots: Snapshots;
  private readonly now: () => Date;
  private readonly fetchImpl?: typeof fetch;
  private readonly flush: boolean;
  private readonly inLock = new AsyncLocalStorage<true>();
  /** see EngineOptions.onProgress; may be set after construction */
  onProgress?: (step: string) => void;

  constructor(o: EngineOptions) {
    this.platform = o.platform;
    this.paths = o.paths;
    this.hostsFile = o.hostsFile ?? o.platform.systemHostsPath();
    this.isSystemFile = samePath(this.hostsFile, o.platform.systemHostsPath());
    this.catalog = o.catalog ?? BUILTIN_CATALOG;
    this.now = o.now ?? (() => new Date());
    this.fetchImpl = o.fetchImpl;
    this.flush = o.flush ?? this.isSystemFile;
    this.onProgress = o.onProgress;
    this.snapshots = new Snapshots(o.paths.snapshotDir, o.snapshotsToKeep ?? 10, this.now);
    // Every operation that writes the hosts file or state.json takes the cross-process
    // lock (the app, the CLI and the scheduled update may run at the same time).
    // Nested calls (resumeIfDue -> enable) reuse the lock they already hold.
    for (const m of WRITE_METHODS) {
      const orig = (this[m] as (...a: unknown[]) => Promise<unknown>).bind(this);
      (this as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => this.locked(() => orig(...a));
    }
  }

  /** Run `fn` holding the cross-process write lock (re-entrant within one call chain). */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inLock.getStore()) return fn();
    return withFileLock(join(this.paths.dataDir, "write.lock"), () => this.inLock.run(true, fn), { owner: `nullhost ${process.argv.slice(1, 3).join(" ")}`.trim() });
  }

  private progress(step: string): void {
    try {
      this.onProgress?.(step);
    } catch {
      /* a listener's failure must not stop the operation */
    }
  }

  // ---------------------------------------------------------------- config

  config(): Promise<Config> {
    return loadConfig(this.paths.configFile, this.catalog);
  }

  saveConfig(c: Config): Promise<void> {
    return saveConfig(this.paths.configFile, c);
  }

  state(): Promise<State> {
    return loadState(this.paths.stateFile);
  }

  /** config.toml as text, to move the settings to another PC. */
  async exportConfig(): Promise<string> {
    return configText(await this.config());
  }

  /**
   * Replace config.toml with an exported one. Everything is checked before anything
   * is written; the current file is kept as `config.toml.before-import`.
   */
  async importConfig(text: string): Promise<Config> {
    let c: Config;
    try {
      c = parseConfig(text, this.catalog);
    } catch (err) {
      throw new Error(`Not a NullHost settings file: ${(err as Error).message}`);
    }
    if (c.ip !== "0.0.0.0" && c.ip !== "127.0.0.1") throw new Error("Not imported: the block address must be 0.0.0.0 or 127.0.0.1");
    if (c.budget < 1_000 || c.budget > this.platform.hardCeiling) {
      throw new Error(`Not imported: the budget must be between 1,000 and ${this.platform.hardCeiling.toLocaleString("en-US")}`);
    }
    const bad = compileAllowlist(c.allowlist).errors;
    if (bad.length) throw new Error(`Not imported: bad allowlist pattern ${bad[0]}`);
    await saveConfig(`${this.paths.configFile}.before-import`, await this.config());
    await this.saveConfig(c);
    return c;
  }

  /** catalog sources plus the user's own, in catalog order */
  async allSources(): Promise<Array<Source & { enabled: boolean }>> {
    const c = await this.config();
    const on = new Set(c.enabled);
    return [...this.catalog.sources, ...c.userSources].map((s) => ({ ...s, enabled: on.has(s.id) }));
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<void> {
    const c = await this.config();
    const known = this.catalog.sources.some((s) => s.id === id) || c.userSources.some((s) => s.id === id);
    if (!known) throw new Error(`unknown source: ${id}`);
    const set = new Set(c.enabled);
    if (enabled) set.add(id);
    else set.delete(id);
    // keep catalog order so the managed region's attribution header is stable
    const order = [...this.catalog.sources, ...c.userSources].map((s) => s.id);
    c.enabled = order.filter((x) => set.has(x));
    await this.saveConfig(c);
  }

  async addUserSource(url: string, name?: string, format: SourceFormat = "hosts"): Promise<Source> {
    const c = await this.config();
    const taken = [...this.catalog.sources, ...c.userSources].map((s) => s.id);
    const label = name ?? url.split(/[\\/]/).filter(Boolean).pop() ?? "source";
    const src: Source = { id: userSourceId(label, taken), name: label, url, format, licence: "", tier: "user" };
    c.userSources.push(src);
    c.enabled.push(src.id);
    await this.saveConfig(c);
    return src;
  }

  async removeUserSource(id: string): Promise<void> {
    const c = await this.config();
    if (!c.userSources.some((s) => s.id === id)) throw new Error(`not a user source: ${id}`);
    c.userSources = c.userSources.filter((s) => s.id !== id);
    c.enabled = c.enabled.filter((x) => x !== id);
    await this.saveConfig(c);
  }

  /** Settings stored in config.toml. The block address is limited to the two safe sinks. */
  async setOptions(o: { ip?: string; budget?: number }): Promise<void> {
    const c = await this.config();
    if (o.ip !== undefined) {
      if (o.ip !== "0.0.0.0" && o.ip !== "127.0.0.1") throw new Error("block address must be 0.0.0.0 or 127.0.0.1");
      c.ip = o.ip;
    }
    if (o.budget !== undefined) {
      if (!Number.isInteger(o.budget) || o.budget < 1_000 || o.budget > this.platform.hardCeiling) {
        throw new Error(`budget must be between 1,000 and ${this.platform.hardCeiling.toLocaleString("en-US")}`);
      }
      c.budget = o.budget;
    }
    await this.saveConfig(c);
  }

  async allowAdd(pattern: string): Promise<void> {
    parseAllowRule(pattern); // throws on a bad regex
    const c = await this.config();
    if (!c.allowlist.includes(pattern)) c.allowlist.push(pattern);
    await this.saveConfig(c);
  }

  /** Replace the whole allowlist (the desktop's editor). Throws on a bad regex, saving nothing. */
  async allowSet(patterns: string[]): Promise<void> {
    for (const p of patterns) parseAllowRule(p);
    const c = await this.config();
    c.allowlist = [...new Set(patterns)];
    await this.saveConfig(c);
  }

  async allowRemove(pattern: string): Promise<boolean> {
    const c = await this.config();
    const before = c.allowlist.length;
    c.allowlist = c.allowlist.filter((p) => p !== pattern);
    await this.saveConfig(c);
    return c.allowlist.length !== before;
  }

  // ---------------------------------------------------------------- build

  /** Fetch (or read from cache) every enabled source and merge. `network: false` = Apply, no downloads unless uncached. */
  async build(network: boolean): Promise<BuildResult> {
    const cfg = await this.config();
    const { rules, errors } = compileAllowlist(cfg.allowlist);
    const byId = new Map<string, Source>([...this.catalog.sources, ...cfg.userSources].map((s) => [s.id, s]));
    const sources: Source[] = [];
    const unknownIds: string[] = [];
    for (const id of cfg.enabled) {
      const s = byId.get(id);
      if (s) sources.push(s);
      else unknownIds.push(id);
    }

    const at = this.now().toISOString();
    const runs: Record<string, SourceRun> = {};
    const failed: string[] = [];
    const inputs: Array<{ id: string; hosts: string[] }> = [];
    const allowlistedOwners = new Map<string, string[]>();

    for (const [i, src] of sources.entries()) {
      const of = sources.length > 1 ? ` (${i + 1} of ${sources.length})` : "";
      this.progress(`${network && isRemote(src.url) ? "Downloading" : "Reading"} ${src.name}${of}`);
      let f;
      try {
        f = await fetchSource(src.url, {
          cacheDir: this.paths.cacheDir,
          network,
          fetchImpl: this.fetchImpl,
          onRetry: (why, ms) => this.progress(`${src.name}: ${why}. Trying again in ${Math.round(ms / 1000)} s`),
          // valid host names, not raw candidates: every line of an HTML page is a "domain" candidate
          accept: (text) => (parse(text, src.format).hosts.some((h) => normalizeHost(h) !== null) ? null : "the download has no host entries (an error or login page?)"),
        });
      } catch (err) {
        runs[src.id] = { from: "failed", at, bytes: 0, parsed: 0, kept: 0, unique: 0, error: (err as Error).message };
        failed.push(src.id);
        continue;
      }
      const p = parse(f.text, src.format);
      const n = normalizeAll(p.hosts, rules);
      for (const h of n.allowlisted) {
        const o = allowlistedOwners.get(h);
        if (!o) allowlistedOwners.set(h, [src.id]);
        else if (!o.includes(src.id)) o.push(src.id);
      }
      const run: SourceRun = { from: f.from, at, bytes: f.bytes, parsed: p.stats.candidates, kept: n.stats.kept, unique: 0 };
      if (f.error) run.error = f.error;
      if (f.previous !== undefined) {
        const prev = normalizeAll(parse(f.previous, src.format).hosts, rules).hosts;
        const d = diffHosts(prev, n.hosts, 0);
        run.added = d.added;
        run.removed = d.removed;
      }
      runs[src.id] = run;
      inputs.push({ id: src.id, hosts: n.hosts });
    }

    this.progress(`Merging ${inputs.length === 1 ? "the list" : `${inputs.length} lists`}`);
    const m = merge(inputs);
    for (const [id, s] of Object.entries(m.perSource)) runs[id]!.unique = s.unique;
    const hosts = sorted(m.hosts.keys());

    const warnings: string[] = [];
    for (const e of errors) warnings.push(`allowlist pattern ignored: ${e}`);
    for (const id of unknownIds) warnings.push(`enabled source not found: ${id}`);
    for (const id of failed) warnings.push(`source unavailable and not cached: ${id} (${runs[id]!.error})`);
    for (const [id, r] of Object.entries(runs)) {
      if (r.from === "cache-fallback") warnings.push(`source ${id}: download failed, used cached copy (${r.error})`);
    }
    for (const s of sources) if (s.warning) warnings.push(`${s.name}: ${s.warning}`);
    const overBudget = hosts.length > cfg.budget;
    const overCeiling = hosts.length > this.platform.hardCeiling;
    if (overCeiling) warnings.push(new OverCeilingError(hosts.length, this.platform.hardCeiling).message);
    else if (overBudget) warnings.push(`selection has ${hosts.length.toLocaleString("en-US")} hosts, over the budget of ${cfg.budget.toLocaleString("en-US")}; Windows DNS reloads get slower`);

    return {
      hosts,
      owners: m.hosts,
      allowlistedOwners,
      sources,
      runs,
      failed,
      unknownIds,
      allowlistErrors: errors,
      warnings,
      overBudget,
      overCeiling,
    };
  }

  // ---------------------------------------------------------------- apply

  /** "Update now" and the scheduled task: download what changed, then apply. */
  async update(opts: { fetchOnly?: boolean; dryRun?: boolean } = {}): Promise<ApplyResult> {
    const b = await this.build(true);
    const st = await this.state();
    st.lastUpdate = { at: this.now().toISOString(), hosts: b.hosts.length, sources: b.runs };
    await saveState(this.paths.stateFile, st);
    if (opts.fetchOnly) {
      const base = await this.baselineHosts(st);
      return {
        mode: st.blocking.mode,
        hosts: b.hosts.length,
        lines: Math.ceil(b.hosts.length / this.platform.perLine),
        diff: diffHosts(base, b.hosts),
        written: false,
        pending: false,
        dryRun: true,
        build: b,
      };
    }
    return this.applyBuild(b, opts.dryRun ?? false, "update");
  }

  /** "Apply": rebuild from the cache (no downloads) after changing sources or the allowlist. */
  async apply(opts: { dryRun?: boolean } = {}): Promise<ApplyResult> {
    const b = await this.build(false);
    return this.applyBuild(b, opts.dryRun ?? false, "apply");
  }

  private renderEnabled(b: BuildResult, cfg: Config): string {
    return renderRegion(b.hosts, {
      ip: cfg.ip,
      perLine: this.platform.perLine,
      eol: this.platform.eol,
      generated: this.now(),
      sources: b.sources,
      status: "enabled",
    });
  }

  private renderOff(status: string): string {
    return renderRegion([], {
      ip: "0.0.0.0",
      perLine: this.platform.perLine,
      eol: this.platform.eol,
      generated: this.now(),
      sources: [],
      status,
    });
  }

  /** The host list the user has "now": the region in the file when enabled, the cached one otherwise. */
  private async baselineHosts(st: State): Promise<string[]> {
    if (st.blocking.mode === "enabled") {
      const region = extractRegion(await this.platform.readHosts(this.hostsFile));
      return region ? regionHosts(region) : [];
    }
    try {
      return regionHosts(await readFile(this.paths.regionFile, "latin1"));
    } catch {
      return [];
    }
  }

  private async applyBuild(b: BuildResult, dryRun: boolean, reason: string): Promise<ApplyResult> {
    if (b.overCeiling) throw new OverCeilingError(b.hosts.length, this.platform.hardCeiling);
    const cfg = await this.config();
    const st = await this.state();
    const region = this.renderEnabled(b, cfg);
    const lines = region.split(this.platform.eol).length - 1;
    const diff = diffHosts(await this.baselineHosts(st), b.hosts);
    const result: ApplyResult = { mode: st.blocking.mode, hosts: b.hosts.length, lines, diff, written: false, pending: false, dryRun, build: b };
    if (dryRun) return result;
    // an enabled source with neither a download nor a cache would silently drop its hosts
    if (b.failed.length) throw new SourcesUnavailableError(b.failed);

    await writeAtomic(this.paths.regionFile, region);
    st.cachedRegion = { builtAt: this.now().toISOString(), hosts: b.hosts.length, lines };

    if (st.blocking.mode !== "enabled") {
      result.pending = true;
      await saveState(this.paths.stateFile, st);
      return result;
    }

    const current = this.checkMarkers(await this.platform.readHosts(this.hostsFile));
    const existing = extractRegion(current);
    if (existing && findRegions(current).length === 1 && regionBody(existing) === regionBody(region)) {
      // same hosts, same sources: skip the write, so Windows does not reload (M0: ~3 s DNS stall per write)
      result.write = { changed: false, flushed: false };
      await saveState(this.paths.stateFile, st);
      return result;
    }
    result.write = await this.writeHosts(current, compose(current, region, this.platform.eol), reason);
    result.written = result.write.changed;
    st.regionHash = sha(region);
    st.lastApply = { at: this.now().toISOString(), hosts: b.hosts.length, lines, mode: "enabled" };
    await saveState(this.paths.stateFile, st);
    return result;
  }

  // ---------------------------------------------------------------- enable / disable / pause

  /** Turn blocking on: writes the cached region (no rebuild) or builds one from the cache. */
  async enable(): Promise<WriteOutcome> {
    const st = await this.state();
    let region: string;
    try {
      region = await readFile(this.paths.regionFile, "latin1");
    } catch {
      const b = await this.build(false);
      if (b.overCeiling) throw new OverCeilingError(b.hosts.length, this.platform.hardCeiling);
      if (b.failed.length) throw new SourcesUnavailableError(b.failed);
      region = this.renderEnabled(b, await this.config());
      await writeAtomic(this.paths.regionFile, region);
      st.cachedRegion = { builtAt: this.now().toISOString(), hosts: b.hosts.length, lines: region.split(this.platform.eol).length - 1 };
    }
    st.blocking = { mode: "enabled" };
    return this.writeRegionAndState(region, st, "enable");
  }

  /** Turn blocking off: the region stays (empty), your own entries stay. */
  async disable(): Promise<WriteOutcome> {
    const st = await this.state();
    st.blocking = { mode: "disabled" };
    return this.writeRegionAndState(this.renderOff("disabled"), st, "disable");
  }

  /** Off until `until`; `resumeIfDue()` turns it back on. */
  async pause(until: Date): Promise<WriteOutcome> {
    const st = await this.state();
    st.blocking = { mode: "paused", until: until.toISOString() };
    return this.writeRegionAndState(this.renderOff(`paused until ${until.toISOString()}`), st, "pause");
  }

  /** If a pause has expired, enable again. Returns true when it did. */
  async resumeIfDue(): Promise<boolean> {
    const st = await this.state();
    if (st.blocking.mode !== "paused") return false;
    if (new Date(st.blocking.until).getTime() > this.now().getTime()) return false;
    await this.enable();
    return true;
  }

  private async writeRegionAndState(region: string, st: State, reason: string): Promise<WriteOutcome> {
    const current = this.checkMarkers(await this.platform.readHosts(this.hostsFile));
    const out = await this.writeHosts(current, compose(current, region, this.platform.eol), reason);
    st.regionHash = sha(region);
    const hosts = regionHosts(region).length;
    st.lastApply = { at: this.now().toISOString(), hosts, lines: region.split(this.platform.eol).length - 1, mode: st.blocking.mode };
    await saveState(this.paths.stateFile, st);
    return out;
  }

  // ---------------------------------------------------------------- restore / remove

  /** Write back a whole snapshot: the file before the last write, or the file before NullHost. */
  async restore(which: "previous" | "original"): Promise<WriteOutcome & { from: string }> {
    const target = which === "original" ? await this.snapshots.original() : (await this.snapshots.list())[0];
    if (!target) throw new Error(which === "original" ? "no original snapshot yet (NullHost has never written this file)" : "no snapshot to restore");
    const text = await this.snapshots.read(target);
    const current = await this.platform.readHosts(this.hostsFile);
    const out = await this.writeHosts(current, text, `restore-${which}`);
    const st = await this.state();
    const region = extractRegion(text);
    st.blocking = region ? modeFromHeader(parseRegionHeader(region).status) : { mode: "disabled" };
    st.regionHash = region ? sha(region) : undefined;
    await saveState(this.paths.stateFile, st);
    return { ...out, from: target.file };
  }

  /** The hosts NullHost blocks: the region in the file, or the cached one while blocking is off. */
  private async coveredHosts(current: string): Promise<Set<string>> {
    const region = extractRegion(current);
    const inFile = region ? regionHosts(region) : [];
    if (inFile.length) return new Set(inFile);
    try {
      return new Set(regionHosts(await readFile(this.paths.regionFile, "latin1")));
    } catch {
      return new Set();
    }
  }

  /** Preview of the clean-up of old block entries outside the region (see tidy.ts). */
  async planTidy(): Promise<Omit<TidyPlan, "next">> {
    const current = await this.platform.readHosts(this.hostsFile);
    const { next: _next, ...plan } = planTidy(current, await this.coveredHosts(current));
    return plan;
  }

  /** Remove block entries outside the region that the region already covers. Snapshot first. */
  async tidy(): Promise<WriteOutcome & { plan: Omit<TidyPlan, "next"> }> {
    const current = this.checkMarkers(await this.platform.readHosts(this.hostsFile));
    const covered = await this.coveredHosts(current);
    if (covered.size === 0) throw new Error("NullHost has no list applied yet; apply first, then clean up");
    const { next, ...plan } = planTidy(current, covered);
    const out = await this.writeHosts(current, next, "tidy");
    return { ...out, plan };
  }

  /** "Remove NullHost from hosts file": delete the managed region, keep everything else. */
  async remove(): Promise<WriteOutcome> {
    const current = this.checkMarkers(await this.platform.readHosts(this.hostsFile));
    const out = await this.writeHosts(current, removeRegion(current), "remove");
    const st = await this.state();
    st.blocking = { mode: "disabled" };
    st.regionHash = undefined;
    await saveState(this.paths.stateFile, st);
    return out;
  }

  /**
   * The Editor's save: the user may change anything outside the managed region.
   * Refused if the region in `text` differs from the one in the file (it is
   * NullHost's; change it through sources, the allowlist or enable/disable).
   * When the file's markers do not pair up, the Editor is how they get fixed, so
   * any edit is accepted then.
   */
  async saveEdited(text: string): Promise<WriteOutcome> {
    const current = await this.platform.readHosts(this.hostsFile);
    if (markersPaired(current)) {
      const before = extractRegion(current);
      const after = extractRegion(text);
      if (!markersPaired(text) || before !== after || findRegions(text).length !== findRegions(current).length) {
        throw new Error("the NullHost region was changed in the editor; only lines outside it can be edited");
      }
    }
    return this.writeHosts(current, text, "editor");
  }

  /** `text` when its markers pair up; RegionMarkersError otherwise (see markersPaired). */
  private checkMarkers(text: string): string {
    if (!markersPaired(text)) throw new RegionMarkersError(this.hostsFile);
    return text;
  }

  private async writeHosts(current: string, next: string, reason: string): Promise<WriteOutcome> {
    if (current === next) return { changed: false, flushed: false };
    const snapshot = await this.snapshots.take(current, reason);
    this.progress("Writing the hosts file");
    const report = await this.platform.writeHosts(this.hostsFile, next);
    const out: WriteOutcome = { changed: true, snapshot, report, flushed: false };
    if (this.flush) {
      this.progress("Flushing the DNS cache");
      try {
        await this.platform.flushDns();
        out.flushed = true;
      } catch (err) {
        out.flushError = (err as Error).message;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- export

  /** The merged selection (from the cache) in another blocker's format. */
  async exportList(format: ExportFormat): Promise<{ text: string; hosts: number }> {
    const b = await this.build(false);
    const cfg = await this.config();
    const header = `NullHost export ${this.now().toISOString()}\n${b.hosts.length} hosts from: ${b.sources.map((s) => `${s.name} (${s.licence || "licence unknown"})`).join(", ")}`;
    return { text: exportList(b.hosts, format, cfg.ip, header), hosts: b.hosts.length };
  }

  // ---------------------------------------------------------------- read-only

  async check(host: string): Promise<CheckResult> {
    const h = normalizeHost(host) ?? host.trim().toLowerCase();
    const cfg = await this.config();
    const b = await this.build(false);
    const names = new Map(b.sources.map((s) => [s.id, s.name]));
    const ids = b.owners.get(h) ?? b.allowlistedOwners.get(h) ?? [];
    const rule = allowedBy(h, compileAllowlist(cfg.allowlist).rules);
    const current = await this.platform.readHosts(this.hostsFile);
    const region = extractRegion(current);
    const blockedNow = region ? regionHosts(region).includes(h) : false;
    const ownEntry = parseHosts(removeRegion(current)).hosts.some((x) => x.toLowerCase() === h);
    return {
      host: h,
      listedBy: ids.map((id) => names.get(id) ?? id),
      allowedBy: rule && ids.length ? rule.pattern : undefined,
      wouldBlock: b.owners.has(h),
      blockedNow,
      ownEntry,
    };
  }

  async status(): Promise<Status> {
    const [st, cfg, text] = await Promise.all([this.state(), this.config(), this.platform.readHosts(this.hostsFile)]);
    const spans = findRegions(text);
    const region = extractRegion(text);
    const header = region ? parseRegionHeader(region) : {};
    const leftovers = planTidy(text, await this.coveredHosts(text));
    return {
      hostsFile: this.hostsFile,
      systemFile: this.isSystemFile,
      platform: this.platform.name,
      blocking: st.blocking,
      region: {
        present: region !== null,
        count: spans.length,
        unterminated: !markersPaired(text),
        hosts: region ? regionHosts(region).length : 0,
        lines: region ? region.split(/\r?\n/).length - 1 : 0,
        generated: header.generated,
        status: header.status,
        modifiedExternally: Boolean(region && st.regionHash && sha(region) !== st.regionHash),
      },
      leftovers: { hosts: leftovers.removeSink0 + leftovers.removeLoopback, linesBefore: leftovers.linesBefore, linesAfter: leftovers.linesAfter },
      config: { enabled: cfg.enabled, userSources: cfg.userSources.length, allowlist: cfg.allowlist.length, budget: cfg.budget },
      lastUpdate: st.lastUpdate,
      lastApply: st.lastApply,
      cachedRegion: st.cachedRegion,
      snapshots: (await this.snapshots.list()).length,
      hasOriginal: (await this.snapshots.original()) !== null,
    };
  }
}

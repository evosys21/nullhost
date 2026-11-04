import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  Engine,
  classify,
  currentPlatform,
  defaultPaths,
  doctor,
  parseAllowText,
  pathsIn,
  type ApplyResult,
  type BlockIndex,
  type Check,
  type DnsLogAction,
  type DnsLogReader,
  type Platform,
  type ScheduleStatus,
  type ScheduledCommand,
  type Scheduler,
  type SourceFormat,
  type WriteReport,
} from "@nullhost/core";
import { DNS_LOG_MINUTES, type AllowText, type AppInfo, type AppUpdate, type ApplySummary, type DnsLogView, type ImportSummary, type DesktopSettings, type NullhostApi, type SourceView, type Theme, type TidyPreview } from "../shared/api.ts";
import { afterCheck, appUpdateView, checkDue, fetchLatestVersion, notifyDue, type StoredAppUpdate } from "./appupdate.ts";
import { downloadVerified, type DownloadFn, type VerifiedFile } from "./selfupdate.ts";
import type { Autostart } from "./autostart";
import type { HelperBroker } from "./helper";

export interface ServiceOptions {
  version: string;
  hostsFile?: string;
  dataDir?: string;
  /** config.toml outside the data dir (the scheduled run passes the user's) */
  configFile?: string;
  platform?: Platform;
  /** the daily-update task; `available` says whether this process may install it directly */
  scheduler: (canInstall: boolean) => Scheduler;
  /** what the task runs: this app, headless, against these paths */
  scheduledCommand: (at: string, paths: { dataDir: string; configFile: string; hostsFile?: string }) => Promise<ScheduledCommand>;
  dev: boolean;
  /** the portable copy: the daily task is not offered (its exe sits in a folder the user can change) */
  portable?: boolean;
  autostart: Autostart;
  /** registers the global hotkey; returns false if the combination is taken */
  registerHotkey: (accelerator: string) => boolean;
  /** light, dark or follow Windows (nativeTheme); absent in headless runs */
  applyTheme?: (theme: Theme) => void;
  openPath: (path: string) => Promise<void>;
  /** native file dialogs for exporting and importing settings; null when cancelled */
  chooseFile?: { save: (defaultName: string) => Promise<string | null>; open: () => Promise<string | null> };
  /** the elevated helper, for an unelevated app that writes the system hosts file */
  makeBroker?: () => HelperBroker;
  /** use the helper even for a copy (tests: exercises the pipe without elevation) */
  forceHelper?: boolean;
  /** the latest NullHost release on GitHub ("1.2.3"); tests pass a fake */
  latestVersion?: () => Promise<string>;
  /** runs a downloaded, verified update (the installer, or the portable swap) and quits; absent in dev */
  applyUpdate?: (file: VerifiedFile) => Promise<void>;
  /** release downloads and the key their checksums are signed with; tests pass fakes */
  downloadFn?: DownloadFn;
  updatePublicKey?: string;
  /** Windows' DNS Client log: read here, switched as admin (directly or through the helper); absent elsewhere */
  dnsLog?: { reader: DnsLogReader; set: (action: DnsLogAction) => Promise<void> };
}

/** lookups read at most per call: the first read shows the newest of these */
const DNS_LOG_FIRST = 500;
const DNS_LOG_MORE = 2000;
/** rebuild the blocked/not index at least this often, besides after every change */
const BLOCK_INDEX_MAX_AGE = 60_000;

interface DesktopFile extends StoredAppUpdate {
  hotkey: string;
  theme: Theme;
  /** NullHost switched the DNS log on and switches it off at this time (ISO); absent when it is not ours */
  dnsLogUntil?: string;
}

const DEFAULT_HOTKEY = "Control+Alt+H";
const THEMES: readonly Theme[] = ["system", "light", "dark"];

function summary(r: ApplyResult): ApplySummary {
  return {
    mode: r.mode,
    hosts: r.hosts,
    lines: r.lines,
    diff: r.diff,
    written: r.written,
    pending: r.pending,
    dryRun: r.dryRun,
    warnings: r.build.warnings,
    runs: r.build.runs,
    waitedMs: r.write?.report?.waitedMs,
  };
}

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** The platform with hosts-file writes and DNS flushes sent to the elevated helper. */
function brokered(base: Platform, broker: HelperBroker, progress: (step: string) => void): Platform {
  return {
    ...base,
    writeHosts: (_path, content) => {
      if (!broker.running) progress("Waiting for administrator approval");
      return broker.request<WriteReport>("write", { content });
    },
    flushDns: async () => {
      await broker.request("flush");
    },
  };
}

/**
 * Everything the window, the tray, the hotkey and the pause timer do. Write
 * operations run one at a time (a queue), and every change notifies listeners.
 *
 * Who writes the hosts file:
 *   admin   this process is elevated (the CLI or scheduled task, or started as admin)
 *   helper  the elevated helper, started with one UAC prompt on the first change
 *   copy    a copy of the hosts file: no elevation needed
 *   none    cannot write (no helper available)
 */
export class Service implements Omit<NullhostApi, "onChanged" | "onProgress"> {
  readonly engine: Engine;
  private readonly o: ServiceOptions;
  private readonly elevated: boolean;
  private readonly broker: HelperBroker | null;
  /** for what needs admin whichever file is edited (the DNS log): `broker`, or one of its own on a copy */
  private readonly adminBroker: HelperBroker | null;
  private hotkeyOk = false;
  private pauseEnded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private progressListeners = new Set<(step: string) => void>();
  private readonly desktopFile: string;
  /** desktop.json changes, one at a time (each reads the file fresh) */
  private desktopQueue: Promise<unknown> = Promise.resolve();
  /** the check for a new version that is running, if any */
  private appUpdateRun: Promise<AppUpdate> | null = null;
  private installRun: Promise<void> | null = null;
  /** what the DNS log classifies against; dropped on every change */
  private blockIndex: { at: number; index: Promise<BlockIndex> } | null = null;
  /** pid -> program name, kept for processes that have exited since */
  private processNames = new Map<number, string>();
  /** fires when NullHost's DNS log time is up */
  private dnsLogTimer: NodeJS.Timeout | undefined;
  /** a switch is running (maybe waiting at the UAC prompt): the log being off then is expected */
  private dnsLogSwitching = false;

  private constructor(o: ServiceOptions, engine: Engine, elevated: boolean, broker: HelperBroker | null, adminBroker: HelperBroker | null) {
    this.o = o;
    this.engine = engine;
    this.elevated = elevated;
    this.broker = broker;
    this.adminBroker = adminBroker;
    this.desktopFile = join(engine.paths.dataDir, "desktop.json");
    engine.onProgress = (step) => this.progress(step);
  }

  static async create(o: ServiceOptions): Promise<Service> {
    const platform = o.platform ?? currentPlatform();
    const base = o.dataDir ? pathsIn(o.dataDir) : defaultPaths();
    const paths = o.configFile ? { ...base, configFile: o.configFile } : base;
    const elevated = await platform.isElevated();
    const systemFile = samePath(o.hostsFile ?? platform.systemHostsPath(), platform.systemHostsPath());
    const useHelper = Boolean(o.makeBroker) && !elevated && (systemFile || Boolean(o.forceHelper));
    const broker = useHelper ? o.makeBroker!() : null;
    // a copy writes without admin, but the DNS log still needs it; this helper never writes the copy
    const adminBroker = broker ?? (o.makeBroker && !elevated ? o.makeBroker() : null);
    // the engine's own steps reach the window through Service.progress (wired in the constructor)
    let service: Service | undefined;
    const engine = new Engine({
      platform: broker ? brokered(platform, broker, (step) => service?.progress(step)) : platform,
      paths,
      hostsFile: o.hostsFile,
    });
    service = new Service(o, engine, elevated, broker, adminBroker);
    return service;
  }

  get writer(): AppInfo["writer"] {
    if (this.elevated) return "admin";
    if (this.broker) return "helper";
    return this.engine.isSystemFile ? "none" : "copy";
  }

  get canWrite(): boolean {
    return this.writer !== "none";
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** each step of a running operation (see NullhostApi.onProgress) */
  onProgress(cb: (step: string) => void): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  private progress(step: string): void {
    for (const cb of this.progressListeners) cb(step);
  }

  /** the helper started or stopped */
  helperStateChanged(): void {
    this.changed();
  }

  private changed(): void {
    this.blockIndex = null;
    for (const cb of this.listeners) cb();
  }

  /** Run a write operation after the previous one finished; refuse if this process may not write. */
  private write<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canWrite) {
      return Promise.reject(new Error("NullHost cannot change the system hosts file from here. Start it again, or as administrator."));
    }
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run.finally(() => this.changed());
  }

  /** stop the helper (the app quits) */
  dispose(): void {
    clearTimeout(this.dnsLogTimer);
    this.broker?.close();
    if (this.adminBroker !== this.broker) this.adminBroker?.close();
  }

  // ------------------------------------------------------------ read

  async info(): Promise<AppInfo> {
    return {
      version: this.o.version,
      platform: this.engine.platform.name,
      hostsFile: this.engine.hostsFile,
      systemFile: this.engine.isSystemFile,
      elevated: this.elevated,
      writer: this.writer,
      helperRunning: this.broker?.running ?? false,
      pauseEnded: this.pauseEnded,
      canWrite: this.canWrite,
      readOnlyReason: this.canWrite ? undefined : "NullHost can show the hosts file here but not change it.",
      dataDir: this.engine.paths.dataDir,
      configFile: this.engine.paths.configFile,
      dev: this.o.dev,
      portable: this.o.portable ?? false,
    };
  }

  status() {
    return this.engine.status();
  }

  async sources(): Promise<SourceView[]> {
    const [all, st] = await Promise.all([this.engine.allSources(), this.engine.state()]);
    const runs = st.lastUpdate?.sources ?? {};
    return all.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      format: s.format,
      licence: s.licence,
      tier: s.tier,
      category: s.category,
      warning: s.warning,
      enabled: s.enabled,
      lastRun: runs[s.id],
    }));
  }

  async allowlist(): Promise<string[]> {
    return (await this.engine.config()).allowlist;
  }

  check(host: string) {
    return this.engine.check(host);
  }

  readHosts(): Promise<string> {
    return this.engine.platform.readHosts(this.engine.hostsFile);
  }

  // ------------------------------------------------------------ config (no hosts write)

  async setSource(id: string, enabled: boolean): Promise<void> {
    await this.engine.setSourceEnabled(id, enabled);
    this.changed();
  }

  async addSource(url: string, name?: string, format?: SourceFormat): Promise<SourceView> {
    const s = await this.engine.addUserSource(url.trim(), name?.trim() || undefined, format ?? "hosts");
    this.changed();
    return { ...s, enabled: true };
  }

  async removeSource(id: string): Promise<void> {
    await this.engine.removeUserSource(id);
    this.changed();
  }

  async allowAdd(pattern: string): Promise<void> {
    await this.engine.allowAdd(pattern.trim());
    this.changed();
  }

  async allowRemove(pattern: string): Promise<void> {
    await this.engine.allowRemove(pattern);
    this.changed();
  }

  async allowSave(text: string): Promise<AllowText> {
    const r = parseAllowText(text);
    await this.engine.allowSet(r.patterns);
    this.changed();
    return r;
  }

  // ------------------------------------------------------------ hosts writes

  update(fetchOnly = false): Promise<ApplySummary> {
    if (fetchOnly) return this.engine.update({ fetchOnly: true }).then(summary).finally(() => this.changed());
    return this.write(async () => summary(await this.engine.update()));
  }

  apply(): Promise<ApplySummary> {
    return this.write(async () => summary(await this.engine.apply()));
  }

  enable(): Promise<void> {
    return this.write(async () => {
      await this.engine.enable();
      this.pauseEnded = false;
    });
  }

  disable(): Promise<void> {
    return this.write(async () => {
      await this.engine.disable();
      this.pauseEnded = false;
    });
  }

  async toggle(): Promise<void> {
    const st = await this.engine.state();
    return st.blocking.mode === "enabled" ? this.disable() : this.enable();
  }

  pause(untilIso: string): Promise<void> {
    const until = new Date(untilIso);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) return Promise.reject(new Error("pause needs a time in the future"));
    return this.write(async () => {
      await this.engine.pause(until);
      this.pauseEnded = false;
    });
  }

  /**
   * The pause timer: called every 30 s by the main process. With the helper not
   * running, a UAC prompt out of nowhere would be confusing: say the pause ended
   * and let the user enable blocking with one click instead.
   */
  async resumeIfDue(): Promise<boolean> {
    if (!this.canWrite) return false;
    const st = await this.engine.state();
    if (st.blocking.mode !== "paused" || new Date(st.blocking.until).getTime() > Date.now()) return false;
    if (this.broker && !this.broker.running) {
      if (!this.pauseEnded) {
        this.pauseEnded = true;
        this.changed();
      }
      return false;
    }
    await this.write(() => this.engine.resumeIfDue());
    this.pauseEnded = false;
    return true;
  }

  saveHosts(text: string): Promise<void> {
    return this.write(async () => { await this.engine.saveEdited(text); });
  }

  restore(which: "previous" | "original"): Promise<void> {
    return this.write(async () => { await this.engine.restore(which); });
  }

  planTidy(): Promise<TidyPreview> {
    return this.engine.planTidy();
  }

  tidy(): Promise<TidyPreview> {
    return this.write(async () => (await this.engine.tidy()).plan);
  }

  removeRegion(): Promise<void> {
    return this.write(async () => { await this.engine.remove(); });
  }

  // ------------------------------------------------------------ settings

  private async desktop(): Promise<DesktopFile> {
    const defaults: DesktopFile = { hotkey: DEFAULT_HOTKEY, theme: "system" };
    try {
      const d = { ...defaults, ...(JSON.parse(await readFile(this.desktopFile, "utf8")) as Partial<DesktopFile>) };
      return THEMES.includes(d.theme) ? d : { ...d, theme: "system" };
    } catch {
      return defaults;
    }
  }

  /** Change desktop.json: read it, apply fn, write it; queued, so no change overwrites another. */
  private updateDesktop(fn: (d: DesktopFile) => DesktopFile): Promise<DesktopFile> {
    const run = this.desktopQueue.then(async () => {
      const d = fn(await this.desktop());
      await mkdir(dirname(this.desktopFile), { recursive: true });
      await writeFile(this.desktopFile, JSON.stringify(d, null, 2) + "\n", "utf8");
      return d;
    });
    this.desktopQueue = run.catch(() => undefined);
    return run;
  }

  /** Register the saved hotkey (called once at start). */
  async registerSavedHotkey(): Promise<void> {
    this.hotkeyOk = this.o.registerHotkey((await this.desktop()).hotkey);
  }

  /** Apply the saved theme (called once at start, before the window opens). */
  async applySavedTheme(): Promise<void> {
    this.o.applyTheme?.((await this.desktop()).theme);
  }

  async settings(): Promise<DesktopSettings> {
    const [d, c] = await Promise.all([this.desktop(), this.engine.config()]);
    return {
      theme: d.theme,
      startAtLogin: await this.o.autostart.isEnabled(),
      startAtLoginAvailable: this.o.autostart.available,
      hotkey: d.hotkey,
      hotkeyRegistered: this.hotkeyOk,
      ip: c.ip,
      budget: c.budget,
      hardCeiling: this.engine.platform.hardCeiling,
      checkAppUpdates: d.checkAppUpdates !== false,
    };
  }

  async setSettings(s: Partial<Pick<DesktopSettings, "theme" | "startAtLogin" | "hotkey" | "ip" | "budget" | "checkAppUpdates">>): Promise<DesktopSettings> {
    if (s.theme !== undefined) {
      if (!THEMES.includes(s.theme)) throw new Error(`Unknown theme: ${s.theme}`);
      const theme = s.theme;
      await this.updateDesktop((d) => ({ ...d, theme }));
      this.o.applyTheme?.(theme);
    }
    if (s.checkAppUpdates !== undefined) {
      const on = Boolean(s.checkAppUpdates);
      await this.updateDesktop((d) => ({ ...d, checkAppUpdates: on }));
    }
    if (s.ip !== undefined || s.budget !== undefined) await this.engine.setOptions({ ip: s.ip, budget: s.budget });
    if (s.hotkey !== undefined) {
      const d = await this.desktop();
      const ok = this.o.registerHotkey(s.hotkey);
      if (!ok) {
        this.hotkeyOk = this.o.registerHotkey(d.hotkey);
        throw new Error(`${s.hotkey} could not be registered (taken by another app?); kept ${d.hotkey}`);
      }
      this.hotkeyOk = true;
      const hotkey = s.hotkey;
      await this.updateDesktop((x) => ({ ...x, hotkey }));
    }
    if (s.startAtLogin !== undefined) {
      if (!this.o.autostart.available) throw new Error("Start at login is available in the installed app.");
      if (s.startAtLogin) await this.o.autostart.enable();
      else await this.o.autostart.disable();
    }
    this.changed();
    return this.settings();
  }

  // ------------------------------------------------------------ new NullHost versions

  async appUpdate(): Promise<AppUpdate> {
    return appUpdateView(await this.desktop(), this.o.version, this.canInstallUpdate);
  }

  private get canInstallUpdate(): boolean {
    return !this.o.dev && Boolean(this.o.applyUpdate);
  }

  /** "Update": download the newer release, check it against the signed checksums, run it */
  installAppUpdate(): Promise<void> {
    if (this.installRun) return this.installRun;
    this.installRun = (async () => {
      if (!this.canInstallUpdate) throw new Error("Updating itself works in the installed or portable NullHost app.");
      const u = await this.appUpdate();
      if (!u.newer || !u.latest) throw new Error("There is no newer NullHost version to install.");
      const file = await downloadVerified({
        version: u.latest,
        portable: this.o.portable ?? false,
        dir: join(this.engine.paths.dataDir, "update"),
        current: this.o.version,
        fetchFn: this.o.downloadFn,
        publicKey: this.o.updatePublicKey,
        onProgress: (step) => this.progress(step),
      });
      this.progress(this.o.portable ? "Restarting into the new version" : "Waiting for administrator approval");
      await this.o.applyUpdate!(file);
    })().finally(() => (this.installRun = null));
    return this.installRun;
  }

  /** Ask GitHub, then merge the answer (or the error) into desktop.json as it is by then. */
  private fetchAppUpdate(clearSkip: boolean): Promise<AppUpdate> {
    if (this.appUpdateRun) return this.appUpdateRun;
    const latest = this.o.latestVersion ?? (() => fetchLatestVersion(this.o.version));
    this.appUpdateRun = (async () => {
      const result = await latest().then((version) => ({ version }), (err: Error) => ({ error: err.message }));
      await this.updateDesktop((d) => ({ ...d, ...afterCheck(d, result, new Date(), clearSkip) }));
      this.changed();
      return this.appUpdate();
    })().finally(() => (this.appUpdateRun = null));
    return this.appUpdateRun;
  }

  /** "Check now" in Settings */
  checkAppUpdate(): Promise<AppUpdate> {
    return this.fetchAppUpdate(true);
  }

  /** the background check: only when checking is on and the last attempt is a day old */
  async checkAppUpdateIfDue(now = Date.now()): Promise<AppUpdate | null> {
    return checkDue(await this.desktop(), now) ? this.fetchAppUpdate(false) : null;
  }

  async skipAppUpdate(version: string): Promise<AppUpdate> {
    const skipped = String(version);
    await this.updateDesktop((d) => ({ ...d, skippedVersion: skipped }));
    this.changed();
    return this.appUpdate();
  }

  /** a newer version the Windows notification has not been shown for; marks it shown */
  async takeAppUpdateNotice(): Promise<AppUpdate | null> {
    let due = false;
    const d = await this.updateDesktop((x) => {
      due = notifyDue(x, this.o.version);
      return due ? { ...x, notifiedVersion: x.latestVersion } : x;
    });
    return due ? appUpdateView(d, this.o.version, this.canInstallUpdate) : null;
  }

  // ------------------------------------------------------------ schedule, troubleshoot, catalog

  /** for the status query (read-only) and for installing directly when this process is elevated */
  private scheduler(): Scheduler {
    return this.o.scheduler(this.elevated);
  }

  async schedule(): Promise<ScheduleStatus> {
    const st = await this.scheduler().status();
    // the helper can install it on the user's behalf
    return { ...st, available: st.available || (this.writer === "helper" && !this.o.dev && !this.o.portable) };
  }

  async setSchedule(at: string | null): Promise<ScheduleStatus> {
    const p = this.engine.paths;
    const paths = { dataDir: p.dataDir, configFile: p.configFile, hostsFile: this.engine.isSystemFile ? undefined : this.engine.hostsFile };
    if (this.elevated) {
      const s = this.scheduler();
      if (at === null) await s.remove();
      else await s.install(await this.o.scheduledCommand(at, paths));
    } else if (this.broker) {
      await this.broker.request<ScheduleStatus>("schedule", { at, ...paths });
    } else {
      throw new Error("Automatic updates need administrator rights; start NullHost with them to switch them on.");
    }
    this.changed();
    return this.schedule();
  }

  async doctor(): Promise<Check[]> {
    return doctor(this.engine, { schedule: await this.schedule(), writer: this.writer === "helper" ? { helper: true, running: this.broker?.running ?? false } : undefined });
  }

  async conflicts(): Promise<string[]> {
    return (await this.engine.platform.diagnostics?.otherHostsTools()) ?? [];
  }

  // ------------------------------------------------------------ DNS log

  private get canSwitchDnsLog(): boolean {
    return Boolean(this.o.dnsLog) && (this.elevated || Boolean(this.adminBroker));
  }

  /** this process is admin, or the helper is running: switching needs no prompt */
  private get haveAdmin(): boolean {
    return this.elevated || (this.adminBroker?.running ?? false);
  }

  /** "Run as administrator": start the helper now, with its one UAC prompt */
  async elevate(): Promise<void> {
    if (this.elevated) return;
    if (!this.adminBroker) throw new Error("NullHost can't ask for administrator rights here; start it as administrator.");
    await this.adminBroker.ensure();
    this.changed();
  }

  private currentBlockIndex(): Promise<BlockIndex> {
    if (!this.blockIndex || Date.now() - this.blockIndex.at > BLOCK_INDEX_MAX_AGE) {
      const index = this.engine.blockIndex();
      index.catch(() => (this.blockIndex = null));
      this.blockIndex = { at: Date.now(), index };
    }
    return this.blockIndex.index;
  }

  /**
   * When NullHost's own logging ends, or undefined when the log is not NullHost's.
   * A log switched off elsewhere meanwhile is not NullHost's any more.
   */
  private async ownDnsLog(enabled: boolean): Promise<string | undefined> {
    const until = (await this.desktop()).dnsLogUntil;
    if (until && !enabled && !this.dnsLogSwitching) {
      await this.updateDesktop((d) => ({ ...d, dnsLogUntil: undefined }));
      return undefined;
    }
    return until;
  }

  private async dnsLogView(state: { enabled: boolean } | null, after: number, now = Date.now()): Promise<DnsLogView> {
    const until = state ? await this.ownDnsLog(state.enabled) : undefined;
    return {
      available: state !== null,
      enabled: state?.enabled ?? false,
      canSwitch: this.canSwitchDnsLog,
      admin: this.haveAdmin,
      ours: until !== undefined,
      until,
      overdue: until !== undefined && Date.parse(until) <= now,
      entries: [],
      last: after,
    };
  }

  /** one action as administrator: here when elevated, else through the helper (its first start prompts) */
  private async runDnsLog(action: DnsLogAction): Promise<void> {
    const log = this.o.dnsLog;
    if (!log) throw new Error("The DNS log is a Windows feature.");
    if (this.elevated) await log.set(action);
    else if (this.adminBroker) {
      if (!this.adminBroker.running) this.progress("Waiting for administrator approval");
      await this.adminBroker.request("dnslog", { action });
    } else throw new Error("Switching the DNS log needs administrator rights; start NullHost with them.");
  }

  private armDnsLogTimer(until: string | undefined): void {
    clearTimeout(this.dnsLogTimer);
    if (!until) return;
    this.dnsLogTimer = setTimeout(() => void this.stopDnsLogIfDue().catch(() => undefined), Math.max(0, Date.parse(until) - Date.now()) + 500);
    this.dnsLogTimer.unref?.();
  }

  async dnsLog(after = 0): Promise<DnsLogView> {
    const log = this.o.dnsLog;
    if (!log) return this.dnsLogView(null, after);
    const state = await log.reader.state();
    const view = await this.dnsLogView(state, after);
    if (!state) return view;
    try {
      const events = await log.reader.read(after, after > 0 ? DNS_LOG_MORE : DNS_LOG_FIRST);
      if (!events.length) return view;
      if (events.some((e) => e.pid && !this.processNames.has(e.pid))) {
        for (const [pid, name] of await log.reader.processes()) this.processNames.set(pid, name);
      }
      const index = await this.currentBlockIndex();
      view.entries = events.map((e) => classify(e, index, this.processNames.get(e.pid)));
      view.last = Math.max(after, ...events.map((e) => e.record));
    } catch (err) {
      view.error = (err as Error).message;
    }
    return view;
  }

  /**
   * enable: on for `minutes` from now, then NullHost switches it off again (already on: only the
   * time is set, and a log NullHost has no record of becomes its own). disable: Stop logging, the
   * user's own choice, so it works on any log (only the automatic stops are limited to NullHost's
   * own). clear: empty it.
   * Returns the state only: the tab keeps reading from where it was (from the start after a clear).
   */
  async setDnsLog(action: DnsLogAction, minutes: number = DNS_LOG_MINUTES[0]): Promise<DnsLogView> {
    const log = this.o.dnsLog;
    if (!log) throw new Error("The DNS log is a Windows feature.");
    const before = await log.reader.state();
    // forgets a record of a log that was switched off elsewhere meanwhile
    await this.ownDnsLog(before?.enabled ?? false);
    if (action === "enable") {
      if (!(DNS_LOG_MINUTES as readonly number[]).includes(minutes)) throw new Error(`Logging runs for ${DNS_LOG_MINUTES.join(", ")} minutes.`);
      // already on without a record (another program, or an older NullHost): giving it a time is the
      // user's choice, so from now on it is NullHost's and is switched off when the time is up
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      // recorded first: if NullHost stops between switching the log on and recording it, it is still NullHost's
      this.dnsLogSwitching = true;
      try {
        await this.updateDesktop((d) => ({ ...d, dnsLogUntil: until }));
        // already ours: only the time changes, no prompt
        if (!before?.enabled) await this.runDnsLog("enable");
      } catch (err) {
        await this.updateDesktop((d) => ({ ...d, dnsLogUntil: undefined }));
        throw err;
      } finally {
        this.dnsLogSwitching = false;
      }
      this.armDnsLogTimer(until);
    } else if (action === "disable") {
      await this.runDnsLog("disable");
      await this.updateDesktop((d) => ({ ...d, dnsLogUntil: undefined }));
      this.armDnsLogTimer(undefined);
    } else {
      await this.runDnsLog(action);
      this.processNames.clear();
    }
    this.changed();
    return this.dnsLogView(await log.reader.state(), 0);
  }

  /**
   * NullHost's logging time is up: switch the log off. Without administrator rights
   * (the helper not running, e.g. after a restart) nothing pops up: the tab shows it overdue.
   * Called by the timer, every 30 s by the main process, and once at start.
   */
  async stopDnsLogIfDue(now = Date.now()): Promise<boolean> {
    const log = this.o.dnsLog;
    if (!log) return false;
    const until = (await this.desktop()).dnsLogUntil;
    if (!until) return false;
    const state = await log.reader.state();
    if (!state) return false;
    if (!state.enabled) {
      await this.ownDnsLog(false);
      return false;
    }
    if (Date.parse(until) > now) {
      if (!this.dnsLogTimer) this.armDnsLogTimer(until);
      return false;
    }
    if (!this.haveAdmin) return false;
    await this.runDnsLog("disable");
    await this.updateDesktop((d) => ({ ...d, dnsLogUntil: undefined }));
    this.armDnsLogTimer(undefined);
    this.changed();
    return true;
  }

  /** Quitting: switch NullHost's own log off while administrator rights are still there (no prompt on the way out). */
  async stopDnsLogOnQuit(): Promise<void> {
    if (!this.o.dnsLog || !this.haveAdmin) return;
    try {
      await this.stopDnsLogIfDue(Number.POSITIVE_INFINITY);
    } catch {
      /* the next start shows it overdue */
    }
  }

  openBackupFolder(): Promise<void> {
    return this.o.openPath(this.engine.paths.snapshotDir);
  }

  // ------------------------------------------------------------ move settings to another PC

  private get chooseFile(): NonNullable<ServiceOptions["chooseFile"]> {
    if (!this.o.chooseFile) throw new Error("Export and import need the app window.");
    return this.o.chooseFile;
  }

  /** config.toml to a file the user picks; returns its path, or null when cancelled */
  async exportSettings(): Promise<string | null> {
    const file = await this.chooseFile.save("nullhost-settings.toml");
    if (!file) return null;
    await writeFile(file, await this.engine.exportConfig(), "utf8");
    return file;
  }

  /** replace config.toml with a file the user picks; the hosts file changes on the next Update */
  async importSettings(): Promise<ImportSummary | null> {
    const file = await this.chooseFile.open();
    if (!file) return null;
    const c = await this.engine.importConfig(await readFile(file, "utf8"));
    this.changed();
    return { file, enabled: c.enabled.length, userSources: c.userSources.length, allowlist: c.allowlist.length };
  }
}

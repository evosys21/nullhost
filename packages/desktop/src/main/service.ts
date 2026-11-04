import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  Engine,
  currentPlatform,
  defaultPaths,
  doctor,
  parseAllowText,
  pathsIn,
  type ApplyResult,
  type Check,
  type Platform,
  type ScheduleStatus,
  type ScheduledCommand,
  type Scheduler,
  type SourceFormat,
  type WriteReport,
} from "@nullhost/core";
import type { AllowText, AppInfo, AppUpdate, ApplySummary, ImportSummary, DesktopSettings, NullhostApi, SourceView, Theme, TidyPreview } from "../shared/api";
import { afterCheck, appUpdateView, checkDue, fetchLatestVersion, notifyDue, type StoredAppUpdate } from "./appupdate.ts";
import { downloadVerified, type DownloadFn } from "./selfupdate.ts";
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
  applyUpdate?: (file: string) => Promise<void>;
  /** release downloads; tests pass a fake */
  downloadFn?: DownloadFn;
}

interface DesktopFile extends StoredAppUpdate {
  hotkey: string;
  theme: Theme;
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

  private constructor(o: ServiceOptions, engine: Engine, elevated: boolean, broker: HelperBroker | null) {
    this.o = o;
    this.engine = engine;
    this.elevated = elevated;
    this.broker = broker;
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
    // the engine's own steps reach the window through Service.progress (wired in the constructor)
    let service: Service | undefined;
    const engine = new Engine({
      platform: broker ? brokered(platform, broker, (step) => service?.progress(step)) : platform,
      paths,
      hostsFile: o.hostsFile,
    });
    service = new Service(o, engine, elevated, broker);
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
    this.broker?.close();
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

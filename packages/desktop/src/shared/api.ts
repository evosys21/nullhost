// The contract between the renderer (UI) and the main process. The preload script
// exposes exactly these methods as `window.nullhost`; each is one IPC channel.
import type { AllowText, Blocking, Check, CheckResult, Diff, DnsLogAction, DnsLogEntry, DnsVerdict, ScheduleStatus, SourceFormat, SourceRun, Status, Tier } from "@nullhost/core";

export type { AllowText, Blocking, Check, CheckResult, Diff, DnsLogAction, DnsLogEntry, DnsVerdict, ScheduleStatus, SourceRun, Status };

export interface AppInfo {
  version: string;
  platform: string;
  hostsFile: string;
  systemFile: boolean;
  elevated: boolean;
  /** who writes the hosts file: this process (admin), the elevated helper, a copy (no admin), or nobody */
  writer: "admin" | "helper" | "copy" | "none";
  /** the elevated helper is running for this session */
  helperRunning: boolean;
  /** a pause expired while the helper was not running: blocking waits for a click */
  pauseEnded: boolean;
  /** false when NullHost may not write this hosts file */
  canWrite: boolean;
  readOnlyReason?: string;
  dataDir: string;
  configFile: string;
  /** running from source (dev), not the installed app */
  dev: boolean;
  /** the portable copy (zip): no daily task, no start at login */
  portable: boolean;
}

export interface SourceView {
  id: string;
  name: string;
  url: string;
  format: SourceFormat;
  licence: string;
  tier: Tier;
  category?: string;
  warning?: string;
  enabled: boolean;
  /** result of the last update for this source, if any */
  lastRun?: SourceRun;
}

export interface ApplySummary {
  mode: Blocking["mode"];
  hosts: number;
  lines: number;
  diff: Diff;
  written: boolean;
  pending: boolean;
  dryRun: boolean;
  warnings: string[];
  runs: Record<string, SourceRun>;
  /** waited for the hosts file lock, ms */
  waitedMs?: number;
}

export interface TidyPreview {
  removeSink0: number;
  removeLoopback: number;
  linesDropped: number;
  linesShortened: number;
  keptOwnBlocks: number;
  linesBefore: number;
  linesAfter: number;
  sampleRemoved: string[];
  sampleKept: string[];
}

/** "system" follows Windows' app mode (Settings › Personalisation › Colours) */
export type Theme = "system" | "light" | "dark";

export interface DesktopSettings {
  theme: Theme;
  startAtLogin: boolean;
  /** false in dev: the logon task needs the installed exe */
  startAtLoginAvailable: boolean;
  hotkey: string;
  hotkeyRegistered: boolean;
  ip: string;
  budget: number;
  hardCeiling: number;
  /** ask GitHub once a day whether a newer NullHost is out */
  checkAppUpdates: boolean;
}

/** a newer NullHost on GitHub Releases; NullHost only points to it, the user installs it */
export interface AppUpdate {
  /** checking is on (Settings) */
  enabled: boolean;
  /** this app's version */
  current: string;
  /** the newest published release, once checked */
  latest?: string;
  /** that release's download page, when it is newer */
  url?: string;
  /** latest is newer than this app, whatever the settings say ("Check now" reports it) */
  newer: boolean;
  /** newer, checking on, and not skipped: show the notice */
  available: boolean;
  checkedAt?: string;
  /** the last check failed (offline, GitHub unreachable); nothing is shown for it */
  error?: string;
  /** this copy can download and install it itself (the installed app or the portable zip, not dev) */
  canInstall: boolean;
}

/** Windows' DNS Client log, read after a record number (DNS log tab) */
export interface DnsLogView {
  /** the log exists and can be read here (Windows) */
  available: boolean;
  /** Windows is writing lookups to it */
  enabled: boolean;
  /** this process may switch it (as admin, or through the helper) */
  canSwitch: boolean;
  /** administrator rights are already there (admin, or the helper running): switching asks nothing */
  admin: boolean;
  /** NullHost switched the log on, so it switches it off again; a log switched on elsewhere is left alone */
  ours: boolean;
  /** when NullHost switches its log off (ISO), while `ours` */
  until?: string;
  /** that time has passed but the log is still on: switching it off needs a click (administrator rights) */
  overdue: boolean;
  /** new lookups after the record asked for, oldest first */
  entries: DnsLogEntry[];
  /** pass this as `after` next time */
  last: number;
  /** the log was cleared outside NullHost: `entries` start over, drop the rows shown so far */
  reset?: boolean;
  /** reading failed (shown in the tab) */
  error?: string;
}

/** how long Start logging runs before NullHost switches the log off again */
export const DNS_LOG_MINUTES = [5, 15, 30, 60] as const;

/** what Import settings brought in */
export interface ImportSummary {
  file: string;
  /** enabled lists, catalog and own */
  enabled: number;
  userSources: number;
  allowlist: number;
}

export interface NullhostApi {
  info(): Promise<AppInfo>;
  status(): Promise<Status>;
  sources(): Promise<SourceView[]>;
  setSource(id: string, enabled: boolean): Promise<void>;
  addSource(url: string, name?: string, format?: SourceFormat): Promise<SourceView>;
  removeSource(id: string): Promise<void>;
  allowlist(): Promise<string[]>;
  allowAdd(pattern: string): Promise<void>;
  allowRemove(pattern: string): Promise<void>;
  /** replace the allowlist with the patterns found in pasted text; returns what was kept and skipped */
  allowSave(text: string): Promise<AllowText>;
  check(host: string): Promise<CheckResult>;
  /** fetch changed sources and apply ("Update lists"); fetchOnly = "Check lists" */
  update(fetchOnly?: boolean): Promise<ApplySummary>;
  /** rebuild from the cache and write, no downloads */
  apply(): Promise<ApplySummary>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  toggle(): Promise<void>;
  /** pause until an ISO time */
  pause(untilIso: string): Promise<void>;
  readHosts(): Promise<string>;
  saveHosts(text: string): Promise<void>;
  restore(which: "previous" | "original"): Promise<void>;
  removeRegion(): Promise<void>;
  /** preview / run the clean-up of old block entries outside the region */
  planTidy(): Promise<TidyPreview>;
  tidy(): Promise<TidyPreview>;
  settings(): Promise<DesktopSettings>;
  setSettings(s: Partial<Pick<DesktopSettings, "theme" | "startAtLogin" | "hotkey" | "ip" | "budget" | "checkAppUpdates">>): Promise<DesktopSettings>;
  openBackupFolder(): Promise<void>;
  /** save config.toml to a file the user picks; the path, or null when cancelled */
  exportSettings(): Promise<string | null>;
  /** replace config.toml with a file the user picks (the old one is kept as config.toml.before-import) */
  importSettings(): Promise<ImportSummary | null>;
  /** read-only health checks (Troubleshoot) */
  doctor(): Promise<Check[]>;
  /** the daily-update task */
  schedule(): Promise<ScheduleStatus>;
  /** "HH:MM" installs or moves the task; null removes it */
  setSchedule(at: string | null): Promise<ScheduleStatus>;
  /** what the last check for a new NullHost version found (no network) */
  appUpdate(): Promise<AppUpdate>;
  /** check GitHub now ("Check now"); also clears a skipped version */
  checkAppUpdate(): Promise<AppUpdate>;
  /** "Skip this version": no notice until a newer one */
  skipAppUpdate(version: string): Promise<AppUpdate>;
  /** download the newer version, check its signature, install it and restart (resolves just before NullHost quits) */
  installAppUpdate(): Promise<void>;
  /** other hosts-file tools running right now, e.g. "HostsMan (hm.exe)" */
  conflicts(): Promise<string[]>;
  /** lookups the DNS Client logged after record `after` (0: the newest few hundred), each marked blocked or not */
  dnsLog(after?: number): Promise<DnsLogView>;
  /** switch the DNS Client log on for `minutes` (one of DNS_LOG_MINUTES) or off, or clear it (asks for administrator rights) */
  setDnsLog(action: DnsLogAction, minutes?: number): Promise<DnsLogView>;
  /** "Run as administrator": start the elevated helper now (one UAC prompt), changing nothing */
  elevate(): Promise<void>;
  /** called after anything changed (any window, the tray, the hotkey, the pause timer) */
  onChanged(cb: () => void): () => void;
  /** each step of a running operation, in words ("Downloading AdAway (2 of 3)") */
  onProgress(cb: (step: string) => void): () => void;
}

/** Methods carried over IPC; `onChanged` and `onProgress` are events, wired separately in the preload. */
export const API_METHODS = [
  "info",
  "status",
  "sources",
  "setSource",
  "addSource",
  "removeSource",
  "allowlist",
  "allowAdd",
  "allowRemove",
  "allowSave",
  "check",
  "update",
  "apply",
  "enable",
  "disable",
  "toggle",
  "pause",
  "readHosts",
  "saveHosts",
  "restore",
  "removeRegion",
  "planTidy",
  "tidy",
  "settings",
  "setSettings",
  "openBackupFolder",
  "exportSettings",
  "importSettings",
  "doctor",
  "schedule",
  "setSchedule",
  "appUpdate",
  "checkAppUpdate",
  "skipAppUpdate",
  "installAppUpdate",
  "conflicts",
  "dnsLog",
  "setDnsLog",
  "elevate",
] as const satisfies ReadonlyArray<Exclude<keyof NullhostApi, "onChanged" | "onProgress">>;

export type ApiMethod = (typeof API_METHODS)[number];

export const CHANGED_EVENT = "nullhost:changed";
export const PROGRESS_EVENT = "nullhost:progress";
export const channel = (m: ApiMethod) => `nullhost:${m}`;

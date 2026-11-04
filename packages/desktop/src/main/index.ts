import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import { BrowserWindow, Menu, Notification, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, shell, type MenuItemConstructorOptions } from "electron";
import { currentPlatform, defaultPaths, quoteArg, windowsScheduler, type ScheduledCommand } from "@nullhost/core";
import { API_METHODS, CHANGED_EVENT, PROGRESS_EVENT, channel, type AppUpdate, type Theme } from "../shared/api";
import { loginItemAutostart, removeLegacyLogonTask } from "./autostart";
import { HelperBroker, runHelper, type HelperContext } from "./helper";
import { shieldPng, type IconState } from "./icons";
import { SWAP_FAILED, elevatedInstallScript, encodePowerShell, portableSwapScript, psQuote, type VerifiedFile } from "./selfupdate";
import { Service } from "./service";

const runAsync = promisify(execFile);

const smokeArg = process.argv.find((a) => a.startsWith("--smoke"));
const smokeDir = smokeArg ? (smokeArg.split("=")[1] ?? join(process.cwd(), "out", "smoke")) : null;
const startHidden = process.argv.includes("--hidden");
/** headless daily update, started by the scheduled task (as the user, elevated) */
const scheduledRun = process.argv.includes("--scheduled-update");
/** run by the uninstaller: remove NullHost's region, login item and tasks, then exit */
const uninstallCleanup = process.argv.includes("--uninstall-cleanup");
/** the elevated helper, started by the app on the first change of a session */
const helperRun = process.argv.includes("--helper");
/** Windows Sandbox only (its fixed user name) and only when asked: lets the smoke run use the sandbox's real hosts file */
const inSandboxTest = process.env.USERNAME === "WDAGUtilityAccount" && process.env.NULLHOST_SANDBOX_TEST === "1";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
/**
 * The scheduled run and the uninstall clean-up run elevated without a prompt, and any
 * unelevated program of the user's can set their environment (HKCU\Environment). So
 * those two only ever act on the system hosts file: no override from the environment
 * or the command line. The data dir still comes from the task's own --data-dir, which
 * scheduledCommand pins to the account's standard one.
 */
const elevatedRun = scheduledRun || uninstallCleanup;
const hostsFileArg = elevatedRun ? undefined : (argValue("--hosts-file") ?? process.env.NULLHOST_HOSTS_FILE);
const dataDirArg = argValue("--data-dir") ?? (elevatedRun ? undefined : process.env.NULLHOST_DATA_DIR);
const configArg = argValue("--config");
/** tests: route writes through an unelevated helper on a copy, to exercise the pipe without UAC */
const forceHelper = process.env.NULLHOST_FORCE_HELPER === "1" && Boolean(hostsFileArg);

/**
 * The portable copy (the zip) has this file next to NullHost.exe; the installer never
 * ships it. Its exe sits wherever the zip was unpacked, often a folder the user can
 * change, so nothing runs it with administrator rights unattended: no daily task, and
 * no login item pointing at a folder that may move. The UAC-prompted helper still works.
 */
const PORTABLE_MARKER = "NullHost.portable";
const portable = app.isPackaged && existsSync(join(dirname(process.execPath), PORTABLE_MARKER));
/** the installed app in Program Files: the only build that may set up the task and login item */
const installed = app.isPackaged && !portable;

const samePath = (a: string, b: string) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();

/**
 * The daily task: this installed executable, headless, as the account running this
 * (elevated) process, on that account's own standard config and data. Only from the
 * installed app: in a dev build process.execPath is electron.exe in node_modules,
 * which the user can change, and the task runs it with administrator rights. The
 * paths must be this account's own, so an administrator elevating for another user
 * never gets a task that acts on files that user can change.
 */
async function scheduledCommand(at: string, p: { dataDir: string; configFile: string; hostsFile?: string }): Promise<ScheduledCommand> {
  if (!installed) throw new Error("Automatic updates can only be switched on in the installed NullHost app.");
  if (p.hostsFile) throw new Error("Automatic updates only update the system hosts file.");
  const own = defaultPaths(process.env);
  if (!samePath(p.dataDir, own.dataDir) || !samePath(p.configFile, own.configFile)) {
    throw new Error("Automatic updates work only with your standard NullHost settings, and only for the account that switches them on.");
  }
  const user = (await runAsync("whoami", [], { windowsHide: true })).stdout.trim();
  return { command: process.execPath, args: ["--scheduled-update", "--data-dir", own.dataDir, "--config", own.configFile], user, at };
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: Service;
let quitting = false;
let currentHotkey: string | null = null;

const icons = new Map<IconState, Electron.NativeImage>();
function icon(state: IconState): Electron.NativeImage {
  let img = icons.get(state);
  if (!img) {
    img = nativeImage.createFromBuffer(shieldPng(state, 32), { scaleFactor: 2 });
    icons.set(state, img);
  }
  return img;
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** --bg in styles.css, light and dark: shown before the page paints */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#101317" : "#F6F7F9");

/** The title bar, the tray menu and the page's prefers-color-scheme all follow themeSource. */
function applyTheme(theme: Theme): void {
  nativeTheme.themeSource = theme;
  win?.setBackgroundColor(windowBackground());
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "NullHost",
    icon: icon("enabled"),
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      offscreen: Boolean(smokeDir),
    },
  });
  win.setMenu(null);
  win.once("ready-to-show", () => {
    if (!startHidden && !smokeDir) win?.show();
  });
  // Close hides to the tray; Quit is in the tray menu.
  win.on("close", (e) => {
    if (!quitting && !smokeDir) {
      e.preventDefault();
      win?.hide();
    }
  });
  // 'closed' follows every destroy, so `win?.` is the one guard the rest of the file needs
  win.on("closed", () => { win = null; });
  // No navigation away from the app, no new windows; https links open in the browser.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

async function trayState(): Promise<{ state: IconState; label: string; tip: string }> {
  const s = await service.status();
  const b = s.blocking;
  if (b.mode === "paused") {
    const t = new Date(b.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const ended = new Date(b.until).getTime() <= Date.now();
    return ended
      ? { state: "paused", label: "Pause ended: blocking still off", tip: "NullHost: pause ended, click Enable blocking" }
      : { state: "paused", label: `Paused until ${t}`, tip: `NullHost: paused until ${t}` };
  }
  if (b.mode === "disabled") return { state: "disabled", label: "Hosts blocking is disabled", tip: "NullHost: blocking disabled" };
  const hosts = s.region.hosts.toLocaleString("en-US");
  return { state: "enabled", label: "Hosts blocking is enabled", tip: `NullHost: blocking enabled (${hosts} hosts)` };
}

function tomorrowAt(h: number, m: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d;
}

async function trayTemplate(): Promise<MenuItemConstructorOptions[]> {
  const t = await trayState();
  const info = await service.info();
  const update = await service.appUpdate();
  const run = (fn: () => Promise<unknown>) => () => void fn().catch((err: Error) => console.error(err.message));
  const pause = (until: Date) => run(() => service.pause(until.toISOString()));
  return [
    { label: t.label, enabled: false },
    ...(update.available && update.url
      ? [update.canInstall
          ? { label: `Update NullHost to ${update.latest}…`, click: showWindow }
          : { label: `Download NullHost ${update.latest}…`, click: () => void shell.openExternal(update.url!) }]
      : []),
    { type: "separator" },
    {
      label: t.state === "enabled" ? "Disable blocking" : "Enable blocking",
      accelerator: currentHotkey ?? undefined,
      enabled: info.canWrite,
      click: run(() => (t.state === "enabled" ? service.disable() : service.enable())),
    },
    {
      label: "Pause",
      enabled: info.canWrite && t.state === "enabled",
      submenu: [
        { label: "15 minutes", click: pause(new Date(Date.now() + 15 * 60_000)) },
        { label: "1 hour", click: pause(new Date(Date.now() + 60 * 60_000)) },
        { label: "Until tomorrow 07:30", click: pause(tomorrowAt(7, 30)) },
      ],
    },
    { type: "separator" },
    { label: "Update lists now", enabled: info.canWrite, click: run(() => service.update()) },
    { label: "Open NullHost", click: showWindow },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ];
}

/** Tell the renderer something; a no-op once the window is gone (quitting). */
function toRenderer(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args);
}

/** Bring the tray (and the window icon) up to date; never throws, so callers can fire and forget. */
async function refreshTray(): Promise<void> {
  try {
    if (!tray) return;
    const t = await trayState();
    const menu = Menu.buildFromTemplate(await trayTemplate());
    if (tray.isDestroyed()) return; // quitting while we awaited
    tray.setImage(icon(t.state));
    tray.setToolTip(t.tip);
    tray.setContextMenu(menu);
    win?.setIcon(icon(t.state));
  } catch (err) {
    console.error((err as Error).message);
  }
}

function createTray(): void {
  tray = new Tray(icon("enabled"));
  tray.on("click", () => (win?.isVisible() ? win.hide() : showWindow()));
  void refreshTray();
}

/** A Windows notification for a new NullHost version; clicking it opens NullHost (its Update button), or the release page. */
function notifyAppUpdate(u: AppUpdate): void {
  if (!u.url || !Notification.isSupported()) return;
  const body = u.canInstall ? `You have ${u.current}. Open NullHost to update.` : `You have ${u.current}. Click to open the download page.`;
  const n = new Notification({ title: `NullHost ${u.latest} is available`, body, icon: icon("enabled") });
  const url = u.url;
  n.on("click", () => (u.canInstall ? showWindow() : void shell.openExternal(url)));
  n.show();
}

/**
 * Run a downloaded, verified update, then quit. The installed app: one UAC prompt for a
 * short PowerShell that copies the installer where only administrators can write,
 * checks it again and runs it silently; it upgrades in place and starts NullHost again
 * as the user (--force-run). The portable copy: a hidden PowerShell script that waits
 * for NullHost to end, swaps the folder for the new one and starts it.
 */
async function applyUpdate(f: VerifiedFile): Promise<void> {
  if (portable) {
    const script = join(dirname(f.path), "swap.ps1");
    const failedLog = join(dirname(f.path), SWAP_FAILED);
    const appDir = dirname(process.execPath);
    // the BOM makes Windows PowerShell read it as UTF-8 (non-ASCII user or folder names)
    await writeFile(script, "﻿" + portableSwapScript({ pid: process.pid, zip: f.path, appDir, exe: process.execPath, failedLog }), "utf8");
    // started from the folder's parent: a process standing in the folder would keep it in use
    spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script], { cwd: dirname(appDir), detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else {
    const elevated = encodePowerShell(elevatedInstallScript({ file: f.path, sha256: f.sha256, folder: `NullHost-update-${randomBytes(8).toString("hex")}` }));
    const start = `Start-Process -FilePath 'powershell.exe' -ArgumentList ${psQuote(`-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${elevated}`)} -Verb RunAs -WindowStyle Hidden`;
    try {
      await runAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", start], { windowsHide: true, timeout: 180_000 });
    } catch {
      throw new Error("Administrator rights were not granted, so NullHost was not updated.");
    }
  }
  // let the answer reach the window, then go: the installer or the script needs this process gone
  setTimeout(() => { quitting = true; app.quit(); }, 500);
}

/** a portable swap that failed left its reason; the old copy started again, so say so once */
async function reportFailedSwap(): Promise<void> {
  const log = join(service.engine.paths.dataDir, "update", SWAP_FAILED);
  const why = await readFile(log, "utf8").then((s) => s.trim(), () => null);
  if (why === null) return;
  await rm(log, { force: true });
  void dialog.showMessageBox({ type: "warning", title: "NullHost", message: "NullHost was not updated.", detail: `The new version could not replace this folder, so this copy started again unchanged.\n\n${why}` });
}

function registerHotkey(accelerator: string): boolean {
  if (smokeDir) return false; // never grab the user's keyboard during a smoke run
  if (currentHotkey) globalShortcut.unregister(currentHotkey);
  currentHotkey = null;
  try {
    const ok = globalShortcut.register(accelerator, () => void service.toggle().catch((err: Error) => console.error(err.message)));
    if (ok) currentHotkey = accelerator;
    return ok;
  } catch {
    return false;
  }
}

const SETTINGS_FILTERS = [{ name: "NullHost settings", extensions: ["toml"] }, { name: "All files", extensions: ["*"] }];

async function saveDialog(defaultName: string): Promise<string | null> {
  const o = { title: "Export settings", defaultPath: join(app.getPath("documents"), defaultName), filters: SETTINGS_FILTERS };
  const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
  return r.canceled || !r.filePath ? null : r.filePath;
}

async function openDialog(): Promise<string | null> {
  const o = { title: "Import settings", defaultPath: app.getPath("documents"), filters: SETTINGS_FILTERS, properties: ["openFile" as const] };
  const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o);
  return r.canceled ? null : (r.filePaths[0] ?? null);
}

function registerIpc(): void {
  for (const m of API_METHODS) {
    ipcMain.handle(channel(m), async (e, ...args: unknown[]) => {
      if (e.sender !== win?.webContents) throw new Error("unknown sender");
      const fn = service[m] as (...a: unknown[]) => Promise<unknown>;
      try {
        return await fn.apply(service, args);
      } catch (err) {
        // send only the message; Electron prefixes it with the channel name
        throw new Error((err as Error).message);
      }
    });
  }
}

// ---------------------------------------------------------------- the elevated helper

/** this executable in helper mode; dev passes the app folder to electron.exe */
function helperArgs(pipe: string, token: string, extra: string[] = []): string[] {
  return [...(app.isPackaged ? [] : [app.getAppPath()]), "--helper", "--pipe", pipe, "--token", token, "--parent", String(process.pid), ...extra];
}

/** Start the helper: elevated with one UAC prompt, or (tests on a copy) unelevated without one. */
async function launchHelper(pipe: string, token: string): Promise<void> {
  if (forceHelper) {
    spawn(process.execPath, helperArgs(pipe, token, ["--hosts-file", hostsFileArg!]), { stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const argLine = helperArgs(pipe, token).map(quoteArg).join(" ");
  const script = `Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(argLine)} -Verb RunAs -WindowStyle Hidden`;
  try {
    await runAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 180_000 });
  } catch {
    throw new Error("Administrator rights were not granted, so the hosts file was not changed.");
  }
}

/** `NullHost.exe --helper ...`: no window, no tray; serves the app until it quits. */
async function helperMain(): Promise<void> {
  const platform = currentPlatform();
  const elevated = await platform.isElevated();
  const override = argValue("--hosts-file");
  // another file than the system hosts file is only for unelevated tests
  if (override && elevated) {
    app.exit(2);
    return;
  }
  const ctx: HelperContext = {
    hostsPath: override ?? platform.systemHostsPath(),
    elevated,
    write: (path, content) => platform.writeHosts(path, content),
    flush: async () => {
      if (!override) await platform.flushDns();
    },
    schedule: async (at, paths) => {
      const s = windowsScheduler(elevated && installed);
      if (at === null) await s.remove();
      else await s.install(await scheduledCommand(at, paths));
      return s.status();
    },
  };
  const code = await runHelper({ pipe: argValue("--pipe") ?? "", token: argValue("--token") ?? "", parentPid: Number(argValue("--parent")) || undefined, ctx });
  app.exit(code);
}

// ---------------------------------------------------------------- smoke test

async function smoke(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // The smoke run updates, cleans up and toggles the file it is given: never the real one
  // (except inside Windows Sandbox, whose hosts file is disposable).
  if (service.engine.isSystemFile && !inSandboxTest) {
    await writeFile(join(dir, "result.json"), JSON.stringify({ ok: false, error: "smoke runs only against a copy: set NULLHOST_HOSTS_FILE (and NULLHOST_DATA_DIR) first" }, null, 2));
    quitting = true;
    app.exit(2);
    return;
  }
  const w = win!;
  await new Promise<void>((r) => (w.webContents.isLoading() ? w.webContents.once("did-finish-load", () => r()) : r()));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name: string) => {
    await wait(900);
    const img = await w.webContents.capturePage();
    await writeFile(join(dir, `${name}.png`), img.toPNG());
  };
  const nav = (screen: string) => w.webContents.executeJavaScript(`window.__nullhostNav(${JSON.stringify(screen)})`);
  const result: Record<string, unknown> = { info: await service.info() };
  try {
    result.update = await service.update();
    result.infoAfterFirstWrite = await service.info();
    await nav("dashboard");
    await shot("dashboard");
    // the HostsMan-leftovers clean-up: open the review, then run it (on the copy)
    await w.webContents.executeJavaScript(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Review clean-up"))?.click()`,
    );
    await shot("dashboard-tidy-review");
    result.tidyPlan = await service.planTidy();
    result.tidy = await service.tidy();
    await nav("sources");
    await nav("dashboard");
    await shot("dashboard-after-tidy");
    for (const screen of ["sources", "allowlist", "editor", "settings"]) {
      await nav(screen);
      await shot(screen);
    }
    // Troubleshoot: run the read-only checks from the Settings screen
    await w.webContents.executeJavaScript(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Run checks")?.click()`,
    );
    await wait(4_000);
    await shot("settings-checks");
    result.doctor = await service.doctor();
    if (inSandboxTest) {
      // the installed app inside Windows Sandbox: switch on both for real;
      // the sandbox test script then uninstalls and checks they are gone
      result.startAtLogin = await service.setSettings({ startAtLogin: true });
      result.scheduleInstalled = await service.setSchedule("07:30");
      await nav("dashboard");
      await shot("dashboard-setup-done");
    }
    result.schedule = await service.schedule();
    await service.disable();
    await nav("dashboard");
    await shot("dashboard-disabled");
    result.trayMenu = (await trayTemplate()).map((i) => i.label ?? `(${i.type})`);
    await service.enable();
    result.status = await service.status();
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = (err as Error).stack;
  }
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  service.dispose();
  quitting = true;
  app.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------- start-up modes

function createService(): Promise<Service> {
  return Service.create({
    version: app.getVersion(),
    hostsFile: hostsFileArg,
    dataDir: dataDirArg,
    configFile: configArg,
    dev: !app.isPackaged,
    portable,
    applyUpdate: app.isPackaged ? applyUpdate : undefined,
    scheduler: (canInstall) => windowsScheduler(canInstall && installed),
    scheduledCommand,
    autostart: loginItemAutostart(app, installed),
    registerHotkey,
    applyTheme,
    openPath: async (p) => { await mkdir(p, { recursive: true }); await shell.openPath(p); },
    chooseFile: { save: saveDialog, open: openDialog },
    makeBroker: process.platform === "win32"
      ? () => new HelperBroker({ launch: launchHelper, onState: () => service?.helperStateChanged() })
      : undefined,
    forceHelper,
  });
}

/** `NullHost.exe --scheduled-update`: update once, log one line, exit (0 = ok) for Task Scheduler. */
async function scheduledUpdate(): Promise<void> {
  let code = 0;
  let line: string;
  let logDir: string | undefined;
  try {
    service = await createService();
    logDir = service.engine.paths.dataDir;
    await service.resumeIfDue();
    const r = await service.update();
    line = `ok: ${r.hosts} hosts, +${r.diff.added} -${r.diff.removed}, ${r.pending ? `blocking ${r.mode}, not written` : r.written ? "written" : "unchanged"}${r.warnings.length ? `; warnings: ${r.warnings.join(" | ")}` : ""}`;
  } catch (err) {
    code = 1;
    line = `failed: ${(err as Error).message}`;
  }
  try {
    if (logDir) {
      await mkdir(logDir, { recursive: true });
      await appendFile(join(logDir, "scheduled-update.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
    }
  } catch {
    /* the exit code still tells Task Scheduler */
  }
  app.exit(code);
}

async function main(): Promise<void> {
  service = await createService();
  registerIpc();
  await service.applySavedTheme();
  createWindow();
  createTray();
  await service.registerSavedHotkey();
  service.onChange(() => {
    void refreshTray();
    toRenderer(CHANGED_EVENT);
  });
  service.onProgress((step) => toRenderer(PROGRESS_EVENT, step));
  // the pause timer, and noticing writes by the scheduled update or the CLI
  let seen = "";
  const fingerprint = async () => {
    const parts = await Promise.all([service.engine.paths.stateFile, service.engine.hostsFile].map((f) => stat(f).then((x) => `${x.mtimeMs}:${x.size}`, () => "-")));
    return parts.join("|");
  };
  seen = await fingerprint();
  const tick = () =>
    void (async () => {
      await service.resumeIfDue();
      const now = await fingerprint();
      if (now !== seen) {
        seen = now;
        void refreshTray();
        toRenderer(CHANGED_EVENT);
      }
    })().catch((err: Error) => console.error(err.message));
  setInterval(tick, 30_000);
  tick();
  // new NullHost versions: the installed app asks GitHub a little after start, then once a day
  if (portable && !smokeDir) void reportFailedSwap().catch((err: Error) => console.error(err.message));
  if (app.isPackaged && !smokeDir) {
    const updateTick = () =>
      void (async () => {
        await service.checkAppUpdateIfDue();
        const u = await service.takeAppUpdateNotice();
        if (u) notifyAppUpdate(u);
      })().catch((err: Error) => console.error(err.message));
    setTimeout(updateTick, 20_000);
    setInterval(updateTick, 3 * 3600_000);
  }
  if (smokeDir) void smoke(smokeDir);
}

/** `NullHost.exe --uninstall-cleanup`: what the uninstaller runs before deleting the files. */
async function cleanupForUninstall(): Promise<void> {
  const notes: string[] = [];
  let code = 0;
  try {
    service = await createService();
    const st = await service.engine.status();
    if (st.region.present) {
      await service.engine.remove();
      notes.push("region removed");
    } else notes.push("no region");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["login item", () => loginItemAutostart(app, true).disable()],
      ["old logon task", () => removeLegacyLogonTask()],
      ["update task", () => windowsScheduler(true).remove()],
    ];
    for (const [what, step] of steps) {
      try {
        await step();
        notes.push(`${what} removed`);
      } catch (err) {
        notes.push(`${what}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    code = 1;
    notes.push(`failed: ${(err as Error).message}`);
  }
  try {
    const dir = service?.engine.paths.dataDir;
    if (dir) {
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, "uninstall.log"), `${new Date().toISOString()} ${notes.join("; ")}\n`, "utf8");
    }
  } catch {
    /* uninstall continues regardless */
  }
  app.exit(code);
}

app.setAppUserModelId("ch.evo21.nullhost");
// a smoke run keeps its own Electron profile, so it never collides with an open NullHost
if (smokeDir) app.setPath("userData", join(smokeDir, "userdata"));

if (helperRun) {
  void app.whenReady().then(helperMain);
} else if (uninstallCleanup) {
  void app.whenReady().then(cleanupForUninstall);
} else if (scheduledRun) {
  // no window, no tray, no single-instance lock: the open app (if any) keeps running
  void app.whenReady().then(scheduledUpdate);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    service?.dispose();
  });
  // keep running in the tray when the window is closed
  app.on("window-all-closed", () => undefined);
  void app.whenReady().then(main);
}

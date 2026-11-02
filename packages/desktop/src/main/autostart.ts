import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Autostart {
  /** false when there is no installed exe to start (dev) or not on Windows */
  readonly available: boolean;
  isEnabled(): Promise<boolean>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}

/** The part of Electron's `app` used here (an interface, so tests can fake it). */
export interface LoginItems {
  getLoginItemSettings(o: { args: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(o: { openAtLogin: boolean; args: string[] }): void;
}

const ARGS = ["--hidden"];

/**
 * Start at login as an ordinary login item (the user's Run key). NullHost runs
 * as a normal user and asks for administrator rights on its first change, so no
 * elevated scheduled task is needed and nothing prompts at login.
 */
export function loginItemAutostart(items: LoginItems, packaged: boolean): Autostart {
  const available = packaged && process.platform === "win32";
  return {
    available,
    isEnabled: async () => available && items.getLoginItemSettings({ args: ARGS }).openAtLogin,
    enable: async () => {
      if (!available) throw new Error("start at login needs the installed app");
      items.setLoginItemSettings({ openAtLogin: true, args: ARGS });
    },
    disable: async () => {
      if (available) items.setLoginItemSettings({ openAtLogin: false, args: ARGS });
    },
  };
}

/** Earlier builds started NullHost through this elevated logon task; the uninstaller removes it. */
export const LEGACY_LOGON_TASK = "NullHost Autostart";

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const realExec: Exec = async (cmd, args) => {
  try {
    const r = await run(cmd, args, { windowsHide: true, timeout: 15_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

/** Delete the legacy logon task if present. Resolves true when it existed. */
export async function removeLegacyLogonTask(exec: Exec = realExec): Promise<boolean> {
  if ((await exec("schtasks", ["/Query", "/TN", LEGACY_LOGON_TASK])).code !== 0) return false;
  const r = await exec("schtasks", ["/Delete", "/TN", LEGACY_LOGON_TASK, "/F"]);
  if (r.code !== 0) throw new Error(`could not delete the old logon task: ${(r.stderr || r.stdout).trim() || `schtasks exit ${r.code}`}`);
  return true;
}

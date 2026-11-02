import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ScheduleStatus } from "../doctor.ts";

const run = promisify(execFile);

export const UPDATE_TASK = "NullHost Update";

/**
 * The task's name for one account. Each task runs as the user who switched it on, so
 * on a machine with several users each gets their own: one shared name would let a
 * second user's install replace the first one's task, and their switch-off delete it.
 * The name comes from the process token, not the environment.
 */
export function updateTaskName(user = userInfo().username): string {
  return `${UPDATE_TASK} (${user.replace(/[\\/:*?"<>|]/g, "_")})`;
}

export interface ScheduledCommand {
  /** the executable the task starts: the installed app, never a file the user can change */
  command: string;
  /** its arguments: the user's own config and data */
  args: string[];
  /** the account it runs as, `DOMAIN\name`: the user switching it on, never SYSTEM */
  user: string;
  /** "HH:MM", local time */
  at: string;
}

export interface Scheduler {
  /** false: this build cannot install the task (not Windows, or no runnable command) */
  readonly available: boolean;
  status(): Promise<ScheduleStatus>;
  install(cmd: ScheduledCommand): Promise<void>;
  remove(): Promise<void>;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Quote one argument for a Windows command line (CommandLineToArgvW rules). */
export function quoteArg(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Task Scheduler XML for the daily update. Runs as the user who switched it on,
 * with their administrator rights and without a UAC prompt, only while they are
 * logged on (InteractiveToken). Not SYSTEM: the run reads and writes that user's
 * own files, which any program of theirs can change, and SYSTEM must never act on
 * those. StartWhenAvailable catches up a run missed while the PC was off or they
 * were logged off; RunOnlyIfNetworkAvailable skips offline starts; a random delay
 * spreads load on the list servers.
 */
export function updateTaskXml(cmd: ScheduledCommand, now = new Date(), name = updateTaskName()): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(cmd.at);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`time must be HH:MM, got ${cmd.at}`);
  if (!/^[^\\\u0000-\u001f]+\\[^\\\u0000-\u001f]+$/.test(cmd.user)) throw new Error(`the task's account must be DOMAIN\\name, got ${cmd.user}`);
  const start = new Date(now);
  start.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  const boundary = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}:00`;
  const args = cmd.args.map(quoteArg).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>NullHost: download changed blocklists and update the hosts file once a day.</Description>
    <URI>\\${xmlEscape(name)}</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${boundary}</StartBoundary>
      <Enabled>true</Enabled>
      <RandomDelay>PT10M</RandomDelay>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(cmd.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(cmd.command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const realExec: Exec = async (cmd, args) => {
  try {
    const r = await run(cmd, args, { windowsHide: true, timeout: 30_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

/** "has not yet run" (0x41303): no last run to report */
const NOT_YET_RUN = 267011;

/** Parse the JSON line printed by the status query (exported for tests). */
export function parseTaskStatus(json: string): ScheduleStatus {
  const t = JSON.parse(json) as { start?: string; last?: string; result?: number; next?: string };
  const hhmm = t.start ? /T(\d{2}:\d{2})/.exec(t.start)?.[1] : undefined;
  const never = t.result === NOT_YET_RUN || !t.last || t.last.startsWith("1999");
  return {
    installed: true,
    available: true,
    at: hhmm,
    lastRun: never ? undefined : t.last,
    lastResult: never ? undefined : t.result,
    nextRun: t.next && !t.next.startsWith("0001") ? t.next : undefined,
  };
}

/**
 * The daily update as a Windows scheduled task. Installing and removing need an
 * elevated process; the status query is read-only and works for any user.
 */
export function windowsScheduler(available: boolean, exec: Exec = realExec, task = updateTaskName()): Scheduler {
  const ps = (script: string) => exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return {
    available: available && process.platform === "win32",
    async status() {
      const r = await ps(
        `$ErrorActionPreference='Stop'; try { $t = Get-ScheduledTask -TaskName '${task.replace(/'/g, "''")}'; $i = $t | Get-ScheduledTaskInfo; ` +
          `[pscustomobject]@{ start = [string]$t.Triggers[0].StartBoundary; last = $i.LastRunTime.ToString('o'); result = $i.LastTaskResult; next = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { '' }) } | ConvertTo-Json -Compress } catch { 'none' }`,
      );
      const out = r.stdout.trim();
      if (r.code !== 0 || !out || out === "none") return { installed: false, available: this.available };
      return { ...parseTaskStatus(out), available: this.available };
    },
    async install(cmd) {
      if (!this.available) throw new Error("automatic updates can only be installed by NullHost running as administrator");
      const dir = await mkdtemp(join(tmpdir(), "nullhost-task-"));
      const file = join(dir, "task.xml");
      try {
        // Task Scheduler wants UTF-16 LE with a byte-order mark when the XML says UTF-16
        await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(updateTaskXml(cmd, new Date(), task), "utf16le")]));
        const r = await exec("schtasks", ["/Create", "/TN", task, "/XML", file, "/F"]);
        if (r.code !== 0) throw new Error(`could not create the scheduled task: ${(r.stderr || r.stdout).trim() || `schtasks exit ${r.code}`}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      // The one shared task of earlier builds goes only when it ran as this account: it may be
      // another user's. Best effort: switching on has worked once the new task exists.
      try {
        const r = await ps(`try { (Get-ScheduledTask -TaskName '${UPDATE_TASK}' -ErrorAction Stop).Principal.UserId } catch { 'none' }`);
        if (r.code === 0 && sameAccount(r.stdout.trim(), cmd.user)) await deleteTask(exec, UPDATE_TASK);
      } catch {
        // left in place
      }
    },
    async remove() {
      await deleteTask(exec, task);
    },
  };
}

/** Is a task's Principal.UserId ("name" or "DOMAIN\name") the account `user` (DOMAIN\name)? (exported for tests) */
export function sameAccount(owner: string, user: string): boolean {
  const o = owner.toLowerCase();
  const u = user.toLowerCase();
  return o === u || (!o.includes("\\") && o === u.slice(u.indexOf("\\") + 1));
}

/** Delete a task; one that does not exist is not an error. */
async function deleteTask(exec: Exec, name: string): Promise<void> {
  const r = await exec("schtasks", ["/Delete", "/TN", name, "/F"]);
  if (r.code !== 0 && !/cannot find|not exist/i.test(r.stderr + r.stdout)) {
    throw new Error(`could not delete the scheduled task: ${(r.stderr || r.stdout).trim() || `schtasks exit ${r.code}`}`);
  }
}

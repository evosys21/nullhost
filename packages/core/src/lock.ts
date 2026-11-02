import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Another NullHost process (the app, the CLI, the scheduled update) is writing. */
export class BusyError extends Error {
  constructor(holder: string) {
    super(`another NullHost process is changing the hosts file (${holder}); try again in a moment`);
    this.name = "BusyError";
  }
}

export interface LockOptions {
  /** how long to wait for another process to finish */
  timeoutMs?: number;
  /** a lock not refreshed for this long is taken over (its process crashed or hung) */
  staleMs?: number;
  intervalMs?: number;
  /** who holds it, written into the lock file */
  owner?: string;
}

/** A lock file with no readable holder (a crash between create and write) is stale after this. */
const BROKEN_GRACE_MS = 5_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but belongs to someone else (e.g. an elevated process vs the user)
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cross-process exclusive lock on `file` (created with O_EXCL). Released when `fn`
 * settles. The holder touches the file while `fn` runs, so a long update keeps its
 * lock; a lock whose process is gone, that has not been touched for `staleMs`, or that
 * never got its holder written is taken over, so a crash never blocks NullHost for good.
 * Each lock carries a token: only the file that was judged stale is removed, and a
 * holder whose lock was taken over never removes the new holder's.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, o: LockOptions = {}): Promise<T> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  const staleMs = o.staleMs ?? 10 * 60_000;
  const intervalMs = o.intervalMs ?? 250;
  const body = JSON.stringify({ pid: process.pid, owner: o.owner ?? "nullhost", at: new Date().toISOString(), token: randomUUID() });
  const readBody = () => readFile(file, "utf8").catch(() => null);
  await mkdir(dirname(file), { recursive: true });
  const t0 = Date.now();
  let holder = "unknown";
  for (;;) {
    let h;
    try {
      h = await open(file, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const text = await readBody();
      const mtime = await stat(file).then((s) => s.mtimeMs, () => null);
      if (mtime === null) continue; // released between our open and read
      if (text === null) {
        // there but not readable (a directory, access denied, held open): wait for it like a live holder
        if (Date.now() - t0 >= timeoutMs) throw new BusyError(holder);
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      let info: { pid?: unknown; owner?: unknown } = {};
      try {
        info = JSON.parse(text) as typeof info;
      } catch {
        // empty or half-written: judged by its age below
      }
      const pid = typeof info.pid === "number" ? info.pid : null;
      holder = `${typeof info.owner === "string" ? info.owner : "nullhost"}, pid ${pid ?? "?"}`;
      const age = Date.now() - mtime;
      if ((pid !== null && !alive(pid)) || age > staleMs || (pid === null && age > BROKEN_GRACE_MS)) {
        // remove only the lock we judged: if it changed meanwhile, another process has it
        if ((await readBody()) === text) await unlink(file).catch(() => undefined);
        continue;
      }
      if (Date.now() - t0 >= timeoutMs) throw new BusyError(holder);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    try {
      await h.writeFile(body, "utf8");
    } catch (err) {
      // never leave an empty lock behind
      await h.close().catch(() => undefined);
      await unlink(file).catch(() => undefined);
      throw err;
    }
    await h.close();
    break;
  }
  const beat = setInterval(() => {
    const now = new Date();
    utimes(file, now, now).catch(() => undefined);
  }, Math.max(1_000, staleMs / 4));
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    if ((await readBody()) === body) await unlink(file).catch(() => undefined);
  }
}

import { readFile as fsReadFile, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { HostsAccessError, HostsBusyError, HostsVerifyError, HostsWriteError } from "../errors.ts";
import type { WriteReport } from "./types.ts";

export interface WriteDeps {
  writeFile: (path: string, data: Buffer) => Promise<void>;
  readFile: (path: string) => Promise<Buffer>;
  isReadOnly: (path: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const realWriteDeps: WriteDeps = {
  writeFile: (p, d) => fsWriteFile(p, d),
  readFile: (p) => fsReadFile(p),
  isReadOnly: async (p) => {
    try {
      return ((await stat(p)).mode & 0o200) === 0;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export interface WriteOptions {
  /** total time to keep retrying a locked file (M0: the DNS Client holds it while parsing) */
  timeoutMs?: number;
  intervalMs?: number;
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

/**
 * Write `content` over `path` in place (keeps the file's ACL and attributes, and
 * does not need the delete-share access a rename would). Retries on a sharing
 * violation (EBUSY) until `timeoutMs`, then reads back to verify. If the write fails
 * part-way (HostsWriteError) or the read-back differs (HostsVerifyError), the previous
 * bytes are written back; the error's `restored` says whether that worked.
 */
export async function writeWithRetry(
  path: string,
  content: string,
  opts: WriteOptions = {},
  deps: WriteDeps = realWriteDeps,
): Promise<WriteReport> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 250;
  // `content` is bytes as latin1 characters; latin1 encoding would silently keep only
  // the low byte of anything wider, so refuse instead of writing something else
  if (/[^\x00-\xff]/.test(content)) throw new Error("not written: the new content has characters that are not single bytes (encode text as UTF-8 bytes first)");
  const data = Buffer.from(content, "latin1");
  let previous: Buffer | null = null;
  try {
    previous = await deps.readFile(path);
  } catch {
    previous = null;
  }

  /**
   * Put the previous bytes back after a failed or wrong write, and say whether the
   * file now holds them. A file that did not exist before cannot be put back.
   */
  const recover = async (): Promise<boolean> => {
    if (!previous) return false;
    try {
      if ((await deps.readFile(path)).equals(previous)) return true; // the failure happened before anything was written
    } catch {
      /* unreadable: try writing anyway */
    }
    try {
      await deps.writeFile(path, previous);
      return (await deps.readFile(path)).equals(previous);
    } catch {
      return false;
    }
  };

  const t0 = deps.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      await deps.writeFile(path, data);
      break;
    } catch (err) {
      const c = code(err);
      // EBUSY, EPERM and EACCES come from opening the file, before it is truncated
      if (c === "EBUSY") {
        if (deps.now() - t0 >= timeoutMs) throw new HostsBusyError(path, deps.now() - t0);
        await deps.sleep(intervalMs);
        continue;
      }
      if (c === "EPERM" || c === "EACCES") {
        throw new HostsAccessError(path, (await deps.isReadOnly(path)) ? "read-only" : "elevation");
      }
      // anything else (ENOSPC, EIO) may have left the file truncated or half written
      throw new HostsWriteError(path, err, await recover());
    }
  }
  const waitedMs = deps.now() - t0;

  let back: Buffer | null;
  try {
    back = await deps.readFile(path);
  } catch {
    back = null;
  }
  if (!back || !back.equals(data)) throw new HostsVerifyError(path, await recover());
  return { attempts, waitedMs, bytes: data.length };
}

export async function readHostsFile(path: string): Promise<string> {
  try {
    return await fsReadFile(path, "latin1");
  } catch (err) {
    if (code(err) === "ENOENT") return "";
    throw err;
  }
}

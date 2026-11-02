import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SnapshotInfo {
  file: string;
  name: string;
  at: Date;
  reason: string;
  bytes: number;
}

const ORIGINAL = "original.hosts";
// <stamp>-<seq>-<reason>.hosts; seq is zero-padded so names sort by time, also within one millisecond
const NAME = /^(\d{8}T\d{9}Z)-(\d{3})-([a-z0-9-]+)\.hosts$/;

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function parseStamp(s: string): Date {
  // 20261026T161852123Z
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`;
  return new Date(iso);
}

/**
 * Automatic copies of the hosts file, taken before every write. Keeps the newest
 * `keep` plus `original.hosts`, the file as it was before NullHost first wrote it.
 * Files are written byte for byte (latin1), like the hosts file itself.
 */
export class Snapshots {
  readonly dir: string;
  readonly keep: number;
  private readonly now: () => Date;

  constructor(dir: string, keep = 10, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.keep = keep;
    this.now = now;
  }

  /** Save `text`; the very first call also saves it as the original. Returns the snapshot path. */
  async take(text: string, reason: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const original = join(this.dir, ORIGINAL);
    try {
      await stat(original);
    } catch {
      await writeFile(original, text, "latin1");
    }
    const safeReason = reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "write";
    const base = stamp(this.now());
    const taken = (await readdir(this.dir)).filter((n) => n.startsWith(base + "-")).length;
    const file = join(this.dir, `${base}-${String(taken + 1).padStart(3, "0")}-${safeReason}.hosts`);
    await writeFile(file, text, "latin1");
    await this.prune();
    return file;
  }

  /** Newest first, original excluded. */
  async list(): Promise<SnapshotInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: SnapshotInfo[] = [];
    for (const name of names) {
      const m = NAME.exec(name);
      if (!m) continue;
      const file = join(this.dir, name);
      out.push({ file, name, at: parseStamp(m[1]!), reason: m[3]!, bytes: (await stat(file)).size });
    }
    out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    return out;
  }

  async original(): Promise<SnapshotInfo | null> {
    const file = join(this.dir, ORIGINAL);
    try {
      const s = await stat(file);
      return { file, name: ORIGINAL, at: s.mtime, reason: "original", bytes: s.size };
    } catch {
      return null;
    }
  }

  async read(info: SnapshotInfo): Promise<string> {
    return readFile(info.file, "latin1");
  }

  private async prune(): Promise<void> {
    const all = await this.list();
    for (const s of all.slice(this.keep)) await unlink(s.file);
  }
}

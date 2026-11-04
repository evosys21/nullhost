// Downloading a new NullHost version, on the user's click. The releases are not
// code-signed, so CI signs SHA256SUMS.txt with an Ed25519 key (a repo secret) and
// this app carries the public half: a file is used only when its SHA-256 is in a
// sums file with a valid signature. Nothing here runs or unpacks it; index.ts does.
import { createHash, verify } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseVersion } from "./appupdate.ts";

/** the public half of the release-signing key; the private half is the UPDATE_SIGNING_KEY secret */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABEG2lpkOUMGd84gIXUrMG+bhPbg1egKw4HazemDVDC8=
-----END PUBLIC KEY-----
`;

const DOWNLOADS = "https://github.com/evosys21/nullhost/releases/download";
/** larger than any NullHost download (about 140 MB); stops an endless stream */
const MAX_BYTES = 400 * 1024 * 1024;

export const SUMS = "SHA256SUMS.txt";
export const SUMS_SIG = "SHA256SUMS.txt.sig";

/** the release file this copy updates from */
export const assetName = (version: string, portable: boolean) =>
  portable ? `NullHost-${version}-portable.zip` : `NullHost-Setup-${version}.exe`;

export const downloadUrl = (version: string, file: string) => `${DOWNLOADS}/v${version}/${file}`;

export type DownloadFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** `sha256sum` output: "<64 hex>  <name>" per line */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)$/i.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

/** the sums file was signed by the release key (the signature is base64) */
export function sumsSigned(sums: Buffer, signature: string, publicKey = UPDATE_PUBLIC_KEY): boolean {
  try {
    return verify(null, sums, publicKey, Buffer.from(signature.trim(), "base64"));
  } catch {
    return false;
  }
}

export interface DownloadOptions {
  version: string;
  portable: boolean;
  /** where the file goes (a folder of its own, emptied first) */
  dir: string;
  current: string;
  fetchFn?: DownloadFn;
  publicKey?: string;
  onProgress?: (step: string) => void;
}

async function get(fetchFn: DownloadFn, url: string, current: string, timeoutMs: number) {
  let res: Awaited<ReturnType<DownloadFn>>;
  try {
    res = await fetchFn(url, { headers: { "User-Agent": `NullHost/${current}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("GitHub could not be reached");
  }
  if (res.status === 404) throw new Error(`the release has no ${url.slice(url.lastIndexOf("/") + 1)}`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res;
}

/**
 * Download the release file for `version` into `dir` and return its path, once its
 * SHA-256 matches the signed sums file. Throws a short message otherwise, and leaves
 * nothing behind but an empty folder.
 */
export async function downloadVerified(o: DownloadOptions): Promise<string> {
  if (!parseVersion(o.version)) throw new Error(`not a version: ${o.version}`);
  const fetchFn = o.fetchFn ?? (fetch as unknown as DownloadFn);
  const file = assetName(o.version, o.portable);
  o.onProgress?.("Checking the release signature");
  const sums = Buffer.from(await (await get(fetchFn, downloadUrl(o.version, SUMS), o.current, 20_000)).arrayBuffer());
  const sig = Buffer.from(await (await get(fetchFn, downloadUrl(o.version, SUMS_SIG), o.current, 20_000)).arrayBuffer()).toString("utf8");
  if (!sumsSigned(sums, sig, o.publicKey)) throw new Error("the release signature does not match; nothing was installed");
  const want = parseSums(sums.toString("utf8")).get(file);
  if (!want) throw new Error(`the signed checksums do not list ${file}`);

  await rm(o.dir, { recursive: true, force: true });
  await mkdir(o.dir, { recursive: true });
  const part = join(o.dir, `${file}.part`);
  const res = await get(fetchFn, downloadUrl(o.version, file), o.current, 15 * 60_000);
  if (!res.body) throw new Error("GitHub sent an empty answer");
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  const out = createWriteStream(part);
  let got = 0;
  let shown = -1;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > MAX_BYTES) throw new Error("the download is larger than any NullHost release");
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== shown && pct % 5 === 0) {
        shown = pct;
        o.onProgress?.(`Downloading ${file}: ${pct} %`);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await rm(part, { force: true });
    throw err instanceof Error && !/^GitHub/.test(err.message) && got <= MAX_BYTES ? new Error("the download broke off") : err;
  }
  if (hash.digest("hex") !== want) {
    await rm(part, { force: true });
    throw new Error("the download does not match the signed checksum; nothing was installed");
  }
  const path = join(o.dir, file);
  await rename(part, path);
  return path;
}

/** PowerShell single-quoted string */
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The script that swaps a portable copy for the new one after NullHost exits: waits
 * for the process, unpacks the zip next to the folder, moves the old folder aside, the
 * new one into its place, starts it, and removes the old one. On a failure it moves
 * the old folder back, so the copy the user had keeps working.
 */
export function portableSwapScript(o: { pid: number; zip: string; appDir: string; exe: string }): string {
  const stage = `${o.appDir}.update`;
  const old = `${o.appDir}.old`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `try { Wait-Process -Id ${o.pid} -Timeout 60 } catch {}`,
    `$stage = ${ps(stage)}; $app = ${ps(o.appDir)}; $old = ${ps(old)}`,
    "Remove-Item -LiteralPath $stage, $old -Recurse -Force -ErrorAction SilentlyContinue",
    "New-Item -ItemType Directory -Path $stage | Out-Null",
    `& (Join-Path $env:SystemRoot 'System32\\tar.exe') -x -f ${ps(o.zip)} -C $stage`,
    "if ($LASTEXITCODE -ne 0) { throw 'unpacking failed' }",
    "$new = Get-ChildItem -LiteralPath $stage -Directory | Select-Object -First 1",
    "if (-not $new -or -not (Test-Path (Join-Path $new.FullName 'NullHost.exe'))) { throw 'the zip has no NullHost.exe' }",
    "Move-Item -LiteralPath $app -Destination $old",
    "try { Move-Item -LiteralPath $new.FullName -Destination $app } catch { Move-Item -LiteralPath $old -Destination $app; throw }",
    `Start-Process -FilePath ${ps(o.exe)}`,
    "Remove-Item -LiteralPath $stage, $old -Recurse -Force -ErrorAction SilentlyContinue",
  ].join("\r\n");
}

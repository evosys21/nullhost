// Downloading a new NullHost version, on the user's click. The releases are not
// code-signed, so CI signs SHA256SUMS.txt with an Ed25519 key (a repo secret) and
// this app carries the public half: a file is used only when its SHA-256 is in a
// sums file with a valid signature. Nothing here runs or unpacks it; index.ts does,
// with the scripts built at the end of this file.
import { createHash, verify } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseVersion } from "./appupdate.ts";

/** the public half of the release-signing key; the private half is the UPDATE_SIGNING_KEY secret */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABEG2lpkOUMGd84gIXUrMG+bhPbg1egKw4HazemDVDC8=
-----END PUBLIC KEY-----
`;

const DOWNLOADS = "https://github.com/evosys21/nullhost/releases/download";
/** larger than any NullHost download (about 140 MB); stops an endless stream */
const MAX_BYTES = 400 * 1024 * 1024;
/** a download that sends nothing for this long is given up (slow is fine, stuck is not) */
export const STALL_MS = 60_000;

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
  /** tests: a shorter stall limit */
  stallMs?: number;
}

/** a downloaded file and the SHA-256 the signed sums give for it */
export interface VerifiedFile {
  path: string;
  sha256: string;
}

async function get(fetchFn: DownloadFn, url: string, current: string, signal: AbortSignal) {
  let res: Awaited<ReturnType<DownloadFn>>;
  try {
    res = await fetchFn(url, { headers: { "User-Agent": `NullHost/${current}` }, signal });
  } catch {
    throw new Error("GitHub could not be reached");
  }
  if (res.status === 404) throw new Error(`the release has no ${url.slice(url.lastIndexOf("/") + 1)}`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

/**
 * Download the release file for `version` into `dir` and return it, once its SHA-256
 * matches the signed sums file. Throws a short message otherwise, and leaves nothing
 * behind but an empty folder.
 */
export async function downloadVerified(o: DownloadOptions): Promise<VerifiedFile> {
  if (!parseVersion(o.version)) throw new Error(`not a version: ${o.version}`);
  const fetchFn = o.fetchFn ?? (fetch as unknown as DownloadFn);
  const file = assetName(o.version, o.portable);
  o.onProgress?.("Checking the release signature");
  const small = async (name: string) => Buffer.from(await (await get(fetchFn, downloadUrl(o.version, name), o.current, AbortSignal.timeout(20_000))).arrayBuffer());
  const [sums, sig] = await Promise.all([small(SUMS), small(SUMS_SIG)]);
  if (!sumsSigned(sums, sig.toString("utf8"), o.publicKey)) throw new Error("the release signature does not match; nothing was installed");
  const want = parseSums(sums.toString("utf8")).get(file);
  if (!want) throw new Error(`the signed checksums do not list ${file}`);

  await rm(o.dir, { recursive: true, force: true });
  await mkdir(o.dir, { recursive: true });
  const part = join(o.dir, `${file}.part`);
  // no limit on the whole download, only on silence: a slow line still gets there
  const stall = new AbortController();
  const stallMs = o.stallMs ?? STALL_MS;
  let timer = setTimeout(() => stall.abort(), stallMs);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), stallMs);
  };
  const hash = createHash("sha256");
  let got = 0;
  let shown = -1;
  try {
    const res = await get(fetchFn, downloadUrl(o.version, file), o.current, stall.signal);
    if (!res.body) throw new Error("GitHub sent an empty answer");
    const total = Number(res.headers.get("content-length")) || 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        alive();
        got += chunk.length;
        if (got > MAX_BYTES) return done(new Error("the download is larger than any NullHost release"));
        hash.update(chunk);
        // percent when the size is known, else every 5 MB
        const step = total ? Math.floor((got / total) * 20) : Math.floor(got / (5 * 1024 * 1024));
        if (step !== shown) {
          shown = step;
          o.onProgress?.(total ? `Downloading ${file}: ${step * 5} %` : `Downloading ${file}: ${mb(got)}`);
        }
        done(null, chunk);
      },
    });
    // pipeline carries an error from any side (the network, the disk) to this await
    await pipeline(Readable.from(res.body), meter, createWriteStream(part));
  } catch (err) {
    // the clean-up must not hide the reason
    await rm(part, { force: true, recursive: true }).catch(() => undefined);
    const msg = (err as Error).message;
    if (stall.signal.aborted) throw new Error(`the download stopped for ${Math.round(stallMs / 1000)} s; try again`);
    if (/^(GitHub|the download is larger|the release has no)/.test(msg)) throw err;
    throw new Error(`the download could not be saved or broke off (${msg})`);
  } finally {
    clearTimeout(timer);
  }
  if (hash.digest("hex") !== want) {
    await rm(part, { force: true });
    throw new Error("the download does not match the signed checksum; nothing was installed");
  }
  const path = join(o.dir, file);
  await rename(part, path);
  return { path, sha256: want };
}

/** a PowerShell single-quoted string */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** for powershell -EncodedCommand: UTF-16LE, base64 */
export const encodePowerShell = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/**
 * What the installed app runs elevated (as -EncodedCommand, so no script file a user
 * program could change): copy the installer into a new folder under Program Files, where
 * a normal user can neither write nor create files, check its SHA-256 there again, and
 * run it silently. The copy in the user's folder could be swapped after the first check;
 * this one not. Program Files comes from the known-folder API, not the environment.
 */
export function elevatedInstallScript(o: { file: string; sha256: string; folder: string }): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$dir = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ${psQuote(o.folder)}`,
    // -ErrorAction Stop on an existing folder: never reuse one another account made
    "New-Item -ItemType Directory -Path $dir | Out-Null",
    "$exe = Join-Path $dir 'NullHost-Setup.exe'",
    `Copy-Item -LiteralPath ${psQuote(o.file)} -Destination $exe`,
    `if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne ${psQuote(o.sha256.toUpperCase())}) { Remove-Item -LiteralPath $dir -Recurse -Force; exit 3 }`,
    "Start-Process -FilePath $exe -ArgumentList '/S --updated --force-run' -Wait",
    "Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue",
  ].join("\r\n");
}

/** where a failed portable swap leaves its reason, for the restarted app to show */
export const SWAP_FAILED = "swap-failed.txt";

/**
 * The script that swaps a portable copy for the new one after NullHost exits. It waits
 * until no NullHost process runs any more (the app, its renderers, the admin helper;
 * an elevated one shows no path, so it goes by name), unpacks the zip next to the
 * folder, moves the old folder aside (retrying while files are still in use), the new
 * one into its place, and starts it. On any failure it puts the old folder back,
 * writes the reason to `failedLog`, and starts the old copy, so NullHost always comes back.
 */
export function portableSwapScript(o: { pid: number; zip: string; appDir: string; exe: string; failedLog: string }): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$stage = ${psQuote(`${o.appDir}.update`)}; $app = ${psQuote(o.appDir)}; $old = ${psQuote(`${o.appDir}.old`)}; $exe = ${psQuote(o.exe)}`,
    `try { Wait-Process -Id ${o.pid} -Timeout 60 } catch {}`,
    "$until = (Get-Date).AddSeconds(30)",
    "while ((Get-Date) -lt $until -and (Get-Process -Name NullHost -ErrorAction SilentlyContinue | Where-Object { -not $_.Path -or $_.Path.StartsWith($app + '\\', 'OrdinalIgnoreCase') })) { Start-Sleep -Milliseconds 300 }",
    "$moved = $false",
    "try {",
    "  Remove-Item -LiteralPath $stage, $old -Recurse -Force -ErrorAction SilentlyContinue",
    "  New-Item -ItemType Directory -Path $stage | Out-Null",
    `  & (Join-Path $env:SystemRoot 'System32\\tar.exe') -x -f ${psQuote(o.zip)} -C $stage`,
    "  if ($LASTEXITCODE -ne 0) { throw 'the zip could not be unpacked' }",
    "  $new = Get-ChildItem -LiteralPath $stage -Directory | Select-Object -First 1",
    "  if (-not $new -or -not (Test-Path (Join-Path $new.FullName 'NullHost.exe'))) { throw 'the zip has no NullHost.exe' }",
    "  for ($i = 0; -not $moved; $i++) { try { Move-Item -LiteralPath $app -Destination $old; $moved = $true } catch { if ($i -ge 20) { throw } Start-Sleep -Milliseconds 500 } }",
    "  Move-Item -LiteralPath $new.FullName -Destination $app",
    "  Remove-Item -LiteralPath $stage, $old -Recurse -Force -ErrorAction SilentlyContinue",
    "} catch {",
    "  if ($moved -and -not (Test-Path -LiteralPath $app)) { Move-Item -LiteralPath $old -Destination $app }",
    "  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue",
    `  Set-Content -LiteralPath ${psQuote(o.failedLog)} -Value "$_" -Encoding UTF8`,
    "}",
    "Start-Process -FilePath $exe",
  ].join("\r\n");
}

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UPDATE_PUBLIC_KEY, assetName, downloadUrl, downloadVerified, elevatedInstallScript, encodePowerShell, parseSums, portableSwapScript, psQuote, sumsSigned, type DownloadFn } from "../src/main/selfupdate.ts";
import { service } from "./service-helper.ts";

const keys = generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("asset names and download links come from the version", () => {
  assert.equal(assetName("0.2.0", false), "NullHost-Setup-0.2.0.exe");
  assert.equal(assetName("0.2.0", true), "NullHost-0.2.0-portable.zip");
  assert.equal(downloadUrl("0.2.0", "SHA256SUMS.txt"), "https://github.com/evosys21/nullhost/releases/download/v0.2.0/SHA256SUMS.txt");
  assert.match(UPDATE_PUBLIC_KEY, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]{40,}\n-----END PUBLIC KEY-----\n$/, "the real key is in place");
});

test("sums: sha256sum lines; anything else is ignored", () => {
  const a = "a".repeat(64), b = "B".repeat(64);
  const m = parseSums(`${a}  NullHost-Setup-0.2.0.exe\r\n${b} *NullHost-0.2.0-portable.zip\njunk\n${"c".repeat(63)}  short.exe\n`);
  assert.deepEqual([...m], [["NullHost-Setup-0.2.0.exe", a], ["NullHost-0.2.0-portable.zip", "b".repeat(64)]]);
});

test("signature: only the release key's signature over these exact bytes", () => {
  const sums = Buffer.from("x  NullHost-Setup-0.2.0.exe\n");
  const sig = sign(null, sums, keys.privateKey).toString("base64");
  assert.equal(sumsSigned(sums, sig, pub), true);
  assert.equal(sumsSigned(Buffer.from("y  NullHost-Setup-0.2.0.exe\n"), sig, pub), false, "other bytes");
  assert.equal(sumsSigned(sums, sig, UPDATE_PUBLIC_KEY), false, "another key");
  assert.equal(sumsSigned(sums, "not base64 at all", pub), false);
  assert.equal(sumsSigned(sums, "", pub), false);
});

interface Fake {
  /** no content-length header */
  noLength?: boolean;
  /** the file's body sends one chunk, then nothing */
  stallAfterFirst?: boolean;
  /** called when the file itself is requested (before the body flows) */
  onFile?: () => Promise<unknown>;
}

/** a fake GitHub serving these files for v0.2.0 */
function release(files: Record<string, Buffer | undefined>, fake: Fake = {}): { fn: DownloadFn; urls: string[] } {
  const urls: string[] = [];
  const fn: DownloadFn = async (url, init) => {
    urls.push(url);
    const name = url.slice(url.lastIndexOf("/") + 1);
    const body = url.startsWith("https://github.com/evosys21/nullhost/releases/download/v0.2.0/") ? files[name] : undefined;
    const isFile = Boolean(body) && !name.startsWith("SHA256SUMS");
    if (isFile) await fake.onFile?.();
    return {
      ok: Boolean(body),
      status: body ? 200 : 404,
      headers: { get: (h: string) => (h === "content-length" && body && !fake.noLength ? String(body.length) : null) },
      body: body
        ? (async function* () {
            for (let i = 0; i < body.length; i += 1000) {
              yield body.subarray(i, i + 1000);
              if (isFile && fake.stallAfterFirst) {
                await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
              }
            }
          })()
        : null,
      arrayBuffer: async () => (body ?? Buffer.alloc(0)).buffer.slice(body?.byteOffset ?? 0, (body?.byteOffset ?? 0) + (body?.length ?? 0)) as ArrayBuffer,
    };
  };
  return { fn, urls };
}

function signedRelease(exe: Buffer, listed = exe, signWith = keys.privateKey) {
  const sums = Buffer.from(`${sha(listed)}  NullHost-Setup-0.2.0.exe\n${sha(Buffer.from("zip"))}  NullHost-0.2.0-portable.zip\n`);
  return { "NullHost-Setup-0.2.0.exe": exe, "SHA256SUMS.txt": sums, "SHA256SUMS.txt.sig": Buffer.from(sign(null, sums, signWith).toString("base64") + "\n") };
}

async function inTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-selfupdate-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("download: a signed, matching file lands in the folder; nothing else stays", () => inTemp(async (dir) => {
  const exe = Buffer.alloc(25_000, 7);
  const r = release(signedRelease(exe));
  const steps: string[] = [];
  const f = await downloadVerified({ version: "0.2.0", portable: false, dir: join(dir, "u"), current: "0.1.2", fetchFn: r.fn, publicKey: pub, onProgress: (s) => steps.push(s) });
  assert.deepEqual(f, { path: join(dir, "u", "NullHost-Setup-0.2.0.exe"), sha256: sha(exe) });
  assert.deepEqual(await readFile(f.path), exe);
  assert.deepEqual(await readdir(join(dir, "u")), ["NullHost-Setup-0.2.0.exe"]);
  assert.ok(steps.includes("Downloading NullHost-Setup-0.2.0.exe: 100 %"));
  assert.deepEqual(r.urls.map((u) => u.slice(u.lastIndexOf("/") + 1)).sort(), ["NullHost-Setup-0.2.0.exe", "SHA256SUMS.txt", "SHA256SUMS.txt.sig"]);
}));

test("download: without a size, progress is shown in MB", () => inTemp(async (dir) => {
  const steps: string[] = [];
  await downloadVerified({ version: "0.2.0", portable: false, dir: join(dir, "u"), current: "0.1.2", fetchFn: release(signedRelease(Buffer.alloc(3_000, 2)), { noLength: true }).fn, publicKey: pub, onProgress: (s) => steps.push(s) });
  assert.deepEqual(steps, ["Checking the release signature", "Downloading NullHost-Setup-0.2.0.exe: 0 MB"]);
}));

test("download: refused for a bad signature, a changed file, a missing signature or entry", () => inTemp(async (dir) => {
  const run = (files: Record<string, Buffer | undefined>, portable = false) =>
    downloadVerified({ version: "0.2.0", portable, dir: join(dir, "u"), current: "0.1.2", fetchFn: release(files).fn, publicKey: pub });
  const exe = Buffer.alloc(5_000, 1);
  const other = generateKeyPairSync("ed25519").privateKey;
  await assert.rejects(run(signedRelease(exe, exe, other)), /signature does not match/);
  await assert.rejects(run(signedRelease(exe, Buffer.from("what was signed"))), /does not match the signed checksum/);
  assert.deepEqual(await readdir(join(dir, "u")), [], "no partial file left");
  await assert.rejects(run({ ...signedRelease(exe), "SHA256SUMS.txt.sig": undefined }), /no SHA256SUMS\.txt\.sig/);
  await assert.rejects(run(signedRelease(exe), true), /release has no NullHost-0\.2\.0-portable\.zip/);
  await assert.rejects(downloadVerified({ version: "../evil", portable: false, dir, current: "0.1.2", fetchFn: release({}).fn, publicKey: pub }), /not a version/);
}));

test("download: a file that cannot be written is an error, not a crash or a hang", () => inTemp(async (dir) => {
  const u = join(dir, "u");
  // a folder where the .part file should go: opening it for writing fails
  const fn = release(signedRelease(Buffer.alloc(5_000, 3)), { onFile: () => mkdir(join(u, "NullHost-Setup-0.2.0.exe.part")) }).fn;
  await assert.rejects(downloadVerified({ version: "0.2.0", portable: false, dir: u, current: "0.1.2", fetchFn: fn, publicKey: pub }), /could not be saved or broke off/);
}));

test("download: slow is fine, but a download that stops sending is given up", () => inTemp(async (dir) => {
  const fn = release(signedRelease(Buffer.alloc(5_000, 4)), { stallAfterFirst: true }).fn;
  await assert.rejects(downloadVerified({ version: "0.2.0", portable: false, dir: join(dir, "u"), current: "0.1.2", fetchFn: fn, publicKey: pub, stallMs: 200 }), /stopped for 0 s; try again/);
  assert.deepEqual(await readdir(join(dir, "u")), [], "no partial file left");
}));

test("installed: the elevated step checks the copy it runs, in a folder of its own under Program Files", () => {
  const s = elevatedInstallScript({ file: "C:\\Users\\o'brien\\AppData\\Local\\NullHost\\update\\NullHost-Setup-0.2.0.exe", sha256: "ab".repeat(32), folder: "NullHost-update-1234" });
  assert.match(s, /\[Environment\]::GetFolderPath\('ProgramFiles'\)\) 'NullHost-update-1234'/);
  assert.match(s, /'C:\\Users\\o''brien\\AppData/);
  assert.ok(s.includes(`-ne '${"AB".repeat(32)}') { Remove-Item`));
  const order = ["New-Item -ItemType Directory", "Copy-Item", "Get-FileHash", "Start-Process -FilePath $exe -ArgumentList '/S --updated --force-run'"];
  const at = order.map((x) => s.indexOf(x));
  assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1]!)), "copy, check, then run");
  assert.equal(Buffer.from(encodePowerShell(s), "base64").toString("utf16le"), s);
  assert.equal(psQuote("it's"), "'it''s'");
});

test("portable swap: waits for every NullHost, retries the move, always starts a copy again", () => {
  const s = portableSwapScript({ pid: 4242, zip: "C:\\Users\\o'brien\\up\\NullHost-0.2.0-portable.zip", appDir: "D:\\Tools\\NullHost", exe: "D:\\Tools\\NullHost\\NullHost.exe", failedLog: "C:\\data\\update\\swap-failed.txt" });
  assert.match(s, /Wait-Process -Id 4242/);
  assert.match(s, /Get-Process -Name NullHost/, "the helper and child processes too");
  assert.match(s, /'C:\\Users\\o''brien\\up\\NullHost-0\.2\.0-portable\.zip'/, "quotes are doubled");
  assert.match(s, /\$stage = 'D:\\Tools\\NullHost\.update'; \$app = 'D:\\Tools\\NullHost'; \$old = 'D:\\Tools\\NullHost\.old'/);
  const order = [
    "Wait-Process", "Get-Process -Name NullHost", "Set-Location -LiteralPath (Split-Path -Parent $app)", "tar.exe",
    "Move-Item -LiteralPath $app -Destination $old", "Move-Item -LiteralPath $new.FullName", "Start-Process -FilePath $exe",
    // a failed start of the new copy rolls back too: the new folder goes, the old one returns and starts
    "\r\n} catch {", "if ($swapped) { Remove-Item -LiteralPath $app", "Move-Item -LiteralPath $old -Destination $app", "swap-failed.txt", "Start-Process -FilePath $exe",
  ];
  let pos = -1;
  for (const step of order) {
    const i = s.indexOf(step, pos + 1);
    assert.ok(i > pos, `"${step}" after the step before it`);
    pos = i;
  }
});

test("service: Update downloads the newer version for this copy and hands the checked file over", async () => {
  const exe = Buffer.alloc(8_000, 5);
  const got: Array<{ path: string; sha256: string }> = [];
  const t = await service(async () => "0.2.0", { dev: false, applyUpdate: async (f) => { got.push(f); }, downloadFn: release(signedRelease(exe)).fn, updatePublicKey: pub });
  try {
    await t.svc.checkAppUpdate();
    assert.equal((await t.svc.appUpdate()).canInstall, true);
    await t.svc.installAppUpdate();
    assert.deepEqual(got, [{ path: join(t.dir, "data", "update", "NullHost-Setup-0.2.0.exe"), sha256: sha(exe) }]);
    assert.deepEqual(await readFile(got[0]!.path), exe);
  } finally {
    await t.done();
  }
});

test("service: no Update without a newer version, and none from a release signed with another key", async () => {
  const exe = Buffer.alloc(1_000, 6);
  const applied: unknown[] = [];
  const t = await service(async () => "0.1.0", { dev: false, applyUpdate: async (f) => { applied.push(f); }, downloadFn: release(signedRelease(exe)).fn, updatePublicKey: pub });
  const u = await service(async () => "0.2.0", { dev: false, applyUpdate: async (f) => { applied.push(f); }, downloadFn: release(signedRelease(exe)).fn });
  try {
    await t.svc.checkAppUpdate();
    await assert.rejects(t.svc.installAppUpdate(), /no newer NullHost version/);
    await u.svc.checkAppUpdate();
    await assert.rejects(u.svc.installAppUpdate(), /signature does not match/, "the built-in key, not the test key");
    assert.deepEqual(applied, []);
  } finally {
    await t.done();
    await u.done();
  }
});

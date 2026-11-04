import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UPDATE_PUBLIC_KEY, assetName, downloadUrl, downloadVerified, parseSums, portableSwapScript, sumsSigned, type DownloadFn } from "../src/main/selfupdate.ts";

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

/** a fake GitHub serving these files for v0.2.0 */
function release(files: Record<string, Buffer | undefined>): { fn: DownloadFn; urls: string[] } {
  const urls: string[] = [];
  const fn: DownloadFn = async (url) => {
    urls.push(url);
    const name = url.slice(url.lastIndexOf("/") + 1);
    const body = url.startsWith("https://github.com/evosys21/nullhost/releases/download/v0.2.0/") ? files[name] : undefined;
    return {
      ok: Boolean(body),
      status: body ? 200 : 404,
      headers: { get: (h: string) => (h === "content-length" && body ? String(body.length) : null) },
      body: body ? (async function* () { for (let i = 0; i < body.length; i += 1000) yield body.subarray(i, i + 1000); })() : null,
      arrayBuffer: async () => (body ?? Buffer.alloc(0)).buffer.slice(body?.byteOffset ?? 0, (body?.byteOffset ?? 0) + (body?.length ?? 0)) as ArrayBuffer,
    };
  };
  return { fn, urls };
}

function signedRelease(exe: Buffer, listed = exe, signWith = keys.privateKey) {
  const sums = Buffer.from(`${sha(listed)}  NullHost-Setup-0.2.0.exe\n${sha(Buffer.from("zip"))}  NullHost-0.2.0-portable.zip\n`);
  return { "NullHost-Setup-0.2.0.exe": exe, "SHA256SUMS.txt": sums, "SHA256SUMS.txt.sig": Buffer.from(sign(null, sums, signWith).toString("base64") + "\n") };
}

test("download: a signed, matching file lands in the folder; nothing else stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-selfupdate-"));
  try {
    const exe = Buffer.alloc(25_000, 7);
    const r = release(signedRelease(exe));
    const steps: string[] = [];
    const path = await downloadVerified({ version: "0.2.0", portable: false, dir: join(dir, "u"), current: "0.1.2", fetchFn: r.fn, publicKey: pub, onProgress: (s) => steps.push(s) });
    assert.equal(path, join(dir, "u", "NullHost-Setup-0.2.0.exe"));
    assert.deepEqual(await readFile(path), exe);
    assert.deepEqual(await readdir(join(dir, "u")), ["NullHost-Setup-0.2.0.exe"]);
    assert.ok(steps.includes("Downloading NullHost-Setup-0.2.0.exe: 100 %"));
    assert.deepEqual(r.urls.map((u) => u.slice(u.lastIndexOf("/") + 1)), ["SHA256SUMS.txt", "SHA256SUMS.txt.sig", "NullHost-Setup-0.2.0.exe"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download: refused for a bad signature, a changed file, a missing signature or entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-selfupdate-"));
  const run = (files: Record<string, Buffer | undefined>, portable = false) =>
    downloadVerified({ version: "0.2.0", portable, dir: join(dir, "u"), current: "0.1.2", fetchFn: release(files).fn, publicKey: pub });
  try {
    const exe = Buffer.alloc(5_000, 1);
    const other = generateKeyPairSync("ed25519").privateKey;
    await assert.rejects(run(signedRelease(exe, exe, other)), /signature does not match/);
    await assert.rejects(run(signedRelease(exe, Buffer.from("what was signed"))), /does not match the signed checksum/);
    assert.deepEqual(await readdir(join(dir, "u")), [], "no partial file left");
    await assert.rejects(run({ ...signedRelease(exe), "SHA256SUMS.txt.sig": undefined }), /no SHA256SUMS\.txt\.sig/);
    await assert.rejects(run(signedRelease(exe), true), /release has no NullHost-0\.2\.0-portable\.zip/);
    await assert.rejects(downloadVerified({ version: "../evil", portable: false, dir, current: "0.1.2", fetchFn: release({}).fn, publicKey: pub }), /not a version/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable swap: waits for the app, keeps the old folder until the new one is in place", () => {
  const s = portableSwapScript({ pid: 4242, zip: "C:\\Users\\o'brien\\up\\NullHost-0.2.0-portable.zip", appDir: "D:\\Tools\\NullHost", exe: "D:\\Tools\\NullHost\\NullHost.exe" });
  assert.match(s, /Wait-Process -Id 4242/);
  assert.match(s, /'C:\\Users\\o''brien\\up\\NullHost-0\.2\.0-portable\.zip'/, "quotes are doubled");
  assert.match(s, /\$stage = 'D:\\Tools\\NullHost\.update'; \$app = 'D:\\Tools\\NullHost'; \$old = 'D:\\Tools\\NullHost\.old'/);
  const order = ["Wait-Process", "tar.exe", "Move-Item -LiteralPath $app -Destination $old", "Move-Item -LiteralPath $new.FullName", "Start-Process", "Remove-Item -LiteralPath $stage, $old"];
  const at = order.map((x) => s.lastIndexOf(x));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "steps in this order");
  assert.ok(at.every((i) => i >= 0));
});

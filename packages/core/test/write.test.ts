import assert from "node:assert/strict";
import { test } from "node:test";
import { HostsAccessError, HostsBusyError, HostsVerifyError, HostsWriteError, writeWithRetry, type WriteDeps } from "../src/index.ts";

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** In-memory file with a fake clock: `busyFor` write attempts fail with EBUSY first. */
/** `partial`: the first `times` writes commit `bytes` bytes, then fail with `code` (a full disk). */
function fakeDeps(init: string, o: { busyFor?: number; failWith?: string; readOnly?: boolean; tamper?: boolean; partial?: { bytes: number; code: string; times: number } } = {}) {
  let content = Buffer.from(init, "latin1");
  let clock = 0;
  let calls = 0;
  const writes: string[] = [];
  const deps: WriteDeps = {
    writeFile: async (_p, d) => {
      calls++;
      if (o.failWith) throw errno(o.failWith);
      if (calls <= (o.busyFor ?? 0)) throw errno("EBUSY");
      if (o.partial && calls <= o.partial.times) {
        content = Buffer.from(d.subarray(0, o.partial.bytes));
        throw errno(o.partial.code);
      }
      content = o.tamper && writes.length === 0 ? Buffer.from("tampered", "latin1") : Buffer.from(d);
      writes.push(d.toString("latin1"));
    },
    readFile: async () => content,
    isReadOnly: async () => o.readOnly ?? false,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { deps, get content() { return content.toString("latin1"); }, writes, get calls() { return calls; } };
}

test("writes in one attempt when the file is free", async () => {
  const f = fakeDeps("old");
  const r = await writeWithRetry("hosts", "new", {}, f.deps);
  assert.equal(r.attempts, 1);
  assert.equal(f.content, "new");
});

test("retries while the DNS Client holds the lock, then succeeds", async () => {
  const f = fakeDeps("old", { busyFor: 3 });
  const r = await writeWithRetry("hosts", "new", { intervalMs: 250 }, f.deps);
  assert.equal(r.attempts, 4);
  assert.equal(r.waitedMs, 750);
  assert.equal(f.content, "new");
});

test("gives up with HostsBusyError after the timeout and leaves the file alone", async () => {
  const f = fakeDeps("old", { busyFor: 1_000 });
  await assert.rejects(writeWithRetry("hosts", "new", { timeoutMs: 2_000, intervalMs: 250 }, f.deps), HostsBusyError);
  assert.equal(f.content, "old");
});

test("access denied: elevation vs read-only attribute", async () => {
  await assert.rejects(writeWithRetry("hosts", "new", {}, fakeDeps("old", { failWith: "EPERM" }).deps), (e: unknown) => e instanceof HostsAccessError && e.reason === "elevation");
  await assert.rejects(writeWithRetry("hosts", "new", {}, fakeDeps("old", { failWith: "EPERM", readOnly: true }).deps), (e: unknown) => e instanceof HostsAccessError && e.reason === "read-only");
});

test("read-back mismatch puts the previous bytes back", async () => {
  const f = fakeDeps("old", { tamper: true });
  await assert.rejects(writeWithRetry("hosts", "new", {}, f.deps), HostsVerifyError);
  assert.equal(f.content, "old");
});

test("bytes outside ASCII survive (latin1 round trip)", async () => {
  const utf8Comment = Buffer.from("# naïve café\r\n", "utf8").toString("latin1");
  const f = fakeDeps(utf8Comment);
  await writeWithRetry("hosts", utf8Comment + "0.0.0.0 a.example.com\r\n", {}, f.deps);
  assert.equal(Buffer.from(f.content, "latin1").toString("utf8"), "# naïve café\r\n0.0.0.0 a.example.com\r\n");
});

test("a write that fails part-way puts the previous bytes back (finding 1)", async () => {
  const f = fakeDeps("# hosts\r\n127.0.0.1 keep.local\r\n", { partial: { bytes: 4, code: "ENOSPC", times: 1 } });
  await assert.rejects(
    writeWithRetry("hosts", "0.0.0.0 ads.example.com\r\n", {}, f.deps),
    (e: unknown) => e instanceof HostsWriteError && e.restored && /ENOSPC/.test(e.message),
  );
  assert.equal(f.content, "# hosts\r\n127.0.0.1 keep.local\r\n", "not left as the truncated 0.0.");
});

test("a failed recovery is reported, not swallowed (finding 1)", async () => {
  const partial = fakeDeps("old content", { partial: { bytes: 4, code: "EIO", times: Infinity } });
  await assert.rejects(
    writeWithRetry("hosts", "new content", {}, partial.deps),
    (e: unknown) => e instanceof HostsWriteError && !e.restored && /restore previous/.test(e.message),
  );
  const tampered = fakeDeps("old", { tamper: true });
  await assert.rejects(writeWithRetry("hosts", "new", {}, tampered.deps), (e: unknown) => e instanceof HostsVerifyError && e.restored);
});

test("refuses content with characters wider than a byte, instead of cutting them short", async () => {
  const f = fakeDeps("old");
  await assert.rejects(writeWithRetry("hosts", "0.0.0.0 a.example.com # cafő\n", {}, f.deps), /not single bytes/);
  assert.equal(f.writes.length, 0);
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { fetchErrorMessage, fetchSource } from "../src/index.ts";

async function tmp() {
  return mkdtemp(join(tmpdir(), "nullhost-fetch-"));
}

test("local file: read, cached, change reported with the previous text", async () => {
  const dir = await tmp();
  const file = join(dir, "list.txt");
  await writeFile(file, "0.0.0.0 a.example.com\n");
  const cacheDir = join(dir, "cache");
  const one = await fetchSource(file, { cacheDir, network: true });
  assert.equal(one.from, "local");
  assert.equal(one.previous, undefined);
  await writeFile(file, "0.0.0.0 b.example.com\n");
  const two = await fetchSource(pathToFileURL(file).href === file ? file : file, { cacheDir, network: false });
  assert.equal(two.previous, "0.0.0.0 a.example.com\n");
});

test("remote: download, 304 uses cache, offline falls back, Apply does not hit the network", async () => {
  const cacheDir = join(await tmp(), "cache");
  const url = "https://lists.example.test/hosts";
  const seen: Array<Record<string, string>> = [];
  let mode: "ok" | "304" | "down" | "changed" = "ok";
  let calls = 0;
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    calls++;
    seen.push({ ...(init?.headers as Record<string, string>) });
    if (mode === "down") throw new Error("ENOTFOUND");
    if (mode === "304") return new Response(null, { status: 304 });
    const body = mode === "changed" ? "0.0.0.0 new.example.com\n" : "0.0.0.0 a.example.com\n";
    return new Response(body, { status: 200, headers: { etag: mode === "changed" ? '"v2"' : '"v1"' } });
  }) as typeof fetch;

  const first = await fetchSource(url, { cacheDir, network: true, fetchImpl });
  assert.equal(first.from, "network");

  mode = "304";
  const second = await fetchSource(url, { cacheDir, network: true, fetchImpl });
  assert.equal(second.from, "cache-304");
  assert.equal(seen.at(-1)!["if-none-match"], '"v1"');

  mode = "down";
  const before = calls;
  const retries: string[] = [];
  const third = await fetchSource(url, { cacheDir, network: true, fetchImpl, retryDelayMs: 0, onRetry: (why) => retries.push(why) });
  assert.equal(calls - before, 2, "one retry after no answer");
  assert.deepEqual(retries, ["ENOTFOUND"]);
  assert.equal(third.from, "cache-fallback");
  assert.match(third.error ?? "", /ENOTFOUND/);

  const seenBefore = seen.length;
  const apply = await fetchSource(url, { cacheDir, network: false, fetchImpl });
  assert.equal(apply.from, "cache");
  assert.equal(seen.length, seenBefore, "Apply must not download");

  mode = "changed";
  const fourth = await fetchSource(url, { cacheDir, network: true, fetchImpl });
  assert.equal(fourth.previous, "0.0.0.0 a.example.com\n");
});

test("remote without cache and without network throws", async () => {
  const cacheDir = join(await tmp(), "cache");
  const fetchImpl = (async () => { throw new Error("offline"); }) as typeof fetch;
  await assert.rejects(fetchSource("https://x.example.test/h", { cacheDir, network: true, fetchImpl, retryDelayMs: 0 }), /offline/);
});

test("fetchErrorMessage shows the reason Node keeps in `cause`", () => {
  const dns = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN adaway.org"), { code: "EAI_AGAIN" }) });
  assert.equal(fetchErrorMessage(dns), "fetch failed: getaddrinfo EAI_AGAIN adaway.org");
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  assert.equal(fetchErrorMessage(reset), "fetch failed: ECONNRESET");
  assert.equal(fetchErrorMessage(Object.assign(new Error("aborted"), { name: "TimeoutError" }), 30_000), "no answer within 30 s");
  assert.equal(fetchErrorMessage(new Error("HTTP 404")), "HTTP 404");
});

test("remote: a 200 that is not a list (a login page) keeps the cached copy instead of replacing it", async () => {
  const cacheDir = join(await tmp(), "cache");
  const url = "https://lists.example.test/portal";
  let body = "0.0.0.0 a.example.com\n";
  const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const accept = (text: string) => (text.includes("0.0.0.0") ? null : "no host entries");
  assert.equal((await fetchSource(url, { cacheDir, network: true, fetchImpl, accept })).from, "network");
  body = "<html><body>Please sign in to the Wi-Fi</body></html>";
  const two = await fetchSource(url, { cacheDir, network: true, fetchImpl, accept });
  assert.equal(two.from, "cache-fallback");
  assert.equal(two.text, "0.0.0.0 a.example.com\n");
  assert.match(two.error ?? "", /no host entries/);
  const fresh = join(await tmp(), "cache");
  await assert.rejects(fetchSource(url, { cacheDir: fresh, network: true, fetchImpl, accept }), /no host entries/);
});

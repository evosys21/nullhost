import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchFrom } from "./types.ts";

export interface FetchOutcome {
  text: string;
  /**
   * network        downloaded now
   * cache-304      server said unchanged, cached copy used
   * cache          network not requested (Apply), cached copy used
   * cache-fallback network failed, cached copy used
   * local          read from a local file
   */
  from: FetchFrom;
  bytes: number;
  ms: number;
  /** the previously cached text, only when the content changed */
  previous?: string;
  /** network error that forced a cache fallback */
  error?: string;
}

export interface FetchOptions {
  cacheDir: string;
  /** false = use the cached copy when there is one (Apply); true = conditional request (Update) */
  network: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** extra attempts after a request got no answer (default 1); HTTP errors are not retried */
  retries?: number;
  /** wait before a retry (default 3 s) */
  retryDelayMs?: number;
  /** called before each retry with the reason */
  onRetry?: (reason: string, delayMs: number) => void;
  /**
   * Checks a downloaded body before it replaces the cache: returns why it is not a
   * list (a captive portal or an error page served with 200), or null. A rejected
   * body is handled like a failed request: the cached copy is kept and used.
   */
  accept?: (text: string) => string | null;
}

/**
 * Why a request failed, in words. Node's fetch says only "fetch failed" and keeps
 * the reason (DNS, refused, reset, certificate) in `cause`.
 */
export function fetchErrorMessage(err: unknown, timeoutMs?: number): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError") return timeoutMs ? `no answer within ${Math.round(timeoutMs / 1000)} s` : "timed out";
  const c = e?.cause;
  const detail = c?.message && c.message !== e.message ? c.message : c?.code;
  return detail ? `${e.message}: ${detail}` : String(e?.message ?? err);
}

interface Meta {
  url: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: string;
}

const UA = "NullHost/0.1 (+https://github.com/evosys21/nullhost)";

export function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function localPath(url: string): string {
  return /^file:\/\//i.test(url) ? fileURLToPath(url) : url;
}

async function readOr<T>(p: string, fallback: T, parse: (s: string) => T): Promise<T> {
  try {
    return parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeAtomic(p: string, text: string): Promise<void> {
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, p);
}

/**
 * Get a source's text. Remote URLs use an on-disk cache with ETag /
 * If-Modified-Since; a failed request falls back to the cache. Local files are
 * read directly but also cached, so changes can be counted.
 * Throws only when there is neither a network answer nor a cached copy.
 */
export async function fetchSource(url: string, o: FetchOptions): Promise<FetchOutcome> {
  await mkdir(o.cacheDir, { recursive: true });
  const key = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const bodyPath = join(o.cacheDir, `${key}.body`);
  const metaPath = join(o.cacheDir, `${key}.meta.json`);
  const meta = await readOr<Meta | null>(metaPath, null, (s) => JSON.parse(s) as Meta);
  const cached = meta ? await readOr<string | null>(bodyPath, null, (s) => s) : null;
  const t0 = performance.now();

  const remember = async (text: string, m: Meta): Promise<string | undefined> => {
    const changed = cached !== null && cached !== text;
    if (cached !== text) await writeAtomic(bodyPath, text);
    await writeAtomic(metaPath, JSON.stringify(m, null, 2));
    return changed ? cached ?? undefined : undefined;
  };

  if (!isRemote(url)) {
    const text = await readFile(localPath(url), "utf8");
    const previous = await remember(text, { url, fetchedAt: new Date().toISOString() });
    return { text, from: "local", bytes: text.length, ms: performance.now() - t0, previous };
  }

  if (!o.network && cached !== null) {
    return { text: cached, from: "cache", bytes: cached.length, ms: performance.now() - t0 };
  }

  const headers: Record<string, string> = { "user-agent": UA };
  if (cached !== null && meta?.etag) headers["if-none-match"] = meta.etag;
  if (cached !== null && meta?.lastModified) headers["if-modified-since"] = meta.lastModified;
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const retries = o.retries ?? 1;
  try {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        // no answer at all (DNS, refused, reset, timeout): often brief, e.g. while the
        // Windows DNS Client reloads a hosts file NullHost just wrote. Try again once.
        if (attempt >= retries) throw err;
        const delayMs = o.retryDelayMs ?? 3_000;
        o.onRetry?.(fetchErrorMessage(err, timeoutMs), delayMs);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (res.status === 304 && cached !== null) {
        return { text: cached, from: "cache-304", bytes: cached.length, ms: performance.now() - t0 };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rejected = o.accept?.(text);
      if (rejected) throw new Error(rejected);
      const previous = await remember(text, {
        url,
        etag: res.headers.get("etag") ?? undefined,
        lastModified: res.headers.get("last-modified") ?? undefined,
        fetchedAt: new Date().toISOString(),
      });
      return { text, from: "network", bytes: text.length, ms: performance.now() - t0, previous };
    }
  } catch (err) {
    const message = fetchErrorMessage(err, timeoutMs);
    if (cached !== null) {
      return { text: cached, from: "cache-fallback", bytes: cached.length, ms: performance.now() - t0, error: message };
    }
    throw new Error(`${url}: ${message}`);
  }
}

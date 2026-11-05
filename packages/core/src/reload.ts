// How long the Windows DNS Client takes to reload the hosts file after a write,
// measured on this PC. Windows 11 26H2 made the reload about 9x slower than the
// build before (spike/README.md, 2026-11-05), so a fixed budget can go stale with
// the next Windows build; the measured cost per host shows what this PC can take.
import type { ReloadSample } from "./types.ts";

/** a reload slower than this is a DNS stall worth warning about (26H2: ~20k hosts) */
export const RELOAD_WARN_MS = 6_000;
/** the suggested budget keeps a reload near this (the old 10k default on 26H2) */
export const RELOAD_TARGET_MS = 3_000;
/** stop waiting for the DNS Client after this long */
export const RELOAD_TIMEOUT_MS = 60_000;
/** samples kept in state.json */
export const RELOAD_KEEP = 10;
/** below this many hosts the fixed part of a reload swamps the per-host cost */
export const RELOAD_MIN_HOSTS = 1_000;

const SINKS = new Set(["0.0.0.0", "127.0.0.1"]);

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), ms); });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A name whose answer changes only once the DNS Client has read the new file.
 * A host the write added answers with the block address once the reload is done;
 * before that it goes upstream. A removed host answers with the block address
 * until the reload is done. A host in both files tells nothing (the old table
 * already has it), so there is no probe when the write changed no blocked names.
 */
export interface ReloadProbe {
  host: string;
  expect: "sink" | "other";
}

export function pickProbe(before: string[], after: string[]): ReloadProbe | null {
  const old = new Set(before);
  for (const h of after) if (!old.has(h)) return { host: h, expect: "sink" };
  const now = new Set(after);
  for (const h of before) if (!now.has(h)) return { host: h, expect: "other" };
  return null;
}

export interface MeasureOptions {
  /** when the write finished, in `clock()` time */
  startedAt: number;
  clock: () => number;
  timeoutMs?: number;
  /** pause between lookups that still see the old table */
  intervalMs?: number;
}

/**
 * Ask the resolver for `probe.host` until it answers from the new file. The time
 * counts from the end of the write, so it includes the flush and any lookup that
 * stalls while the DNS Client parses. Resolver errors count as "not the block
 * address": for an added host they mean "not loaded yet", for a removed one "gone".
 */
export async function measureReload(
  resolve: (host: string) => Promise<string>,
  probe: ReloadProbe,
  o: MeasureOptions,
): Promise<{ ms: number; timedOut: boolean }> {
  const timeout = o.timeoutMs ?? RELOAD_TIMEOUT_MS;
  const interval = o.intervalMs ?? 100;
  const deadline = o.startedAt + timeout;
  for (;;) {
    const left = deadline - o.clock();
    if (left <= 0) return { ms: timeout, timedOut: true };
    let sink = false;
    try {
      const a = await withTimeout(resolve(probe.host), left);
      if (a === "timeout") return { ms: timeout, timedOut: true };
      sink = SINKS.has(a);
    } catch {
      sink = false;
    }
    if (sink === (probe.expect === "sink")) return { ms: Math.max(0, o.clock() - o.startedAt), timedOut: false };
    await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(0, deadline - o.clock()))));
  }
}

/** Append `s`, keeping the newest RELOAD_KEEP. */
export function addSample(samples: ReloadSample[] | undefined, s: ReloadSample): ReloadSample[] {
  return [...(samples ?? []), s].slice(-RELOAD_KEEP);
}

export interface ReloadCost {
  /** the most recent measurement */
  last: ReloadSample;
  /** the last reload took longer than RELOAD_WARN_MS, or never answered */
  slow: boolean;
  /** median ms per host over recent writes of RELOAD_MIN_HOSTS or more; missing until there is one */
  perHostMs?: number;
  /** hosts that reload in about RELOAD_TARGET_MS at that cost, in 1,000s, capped at the ceiling */
  suggestedBudget?: number;
  /** measurements behind perHostMs */
  basis: number;
}

export function reloadCost(samples: ReloadSample[] | undefined, ceiling: number): ReloadCost | undefined {
  if (!samples?.length) return undefined;
  const last = samples[samples.length - 1]!;
  const out: ReloadCost = { last, slow: Boolean(last.timedOut) || last.ms > RELOAD_WARN_MS, basis: 0 };
  // a timed-out sample is a lower bound on the cost; it still counts, it only errs low
  const costs = samples.filter((s) => s.hosts >= RELOAD_MIN_HOSTS).slice(-5).map((s) => s.ms / s.hosts).sort((a, b) => a - b);
  if (!costs.length) return out;
  const mid = costs.length >> 1;
  const perHost = costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
  out.perHostMs = perHost;
  out.basis = costs.length;
  // the epsilon keeps 3000 / 0.6 at 5,000 rather than 4,999.999...
  const fit = perHost > 0 ? Math.floor(RELOAD_TARGET_MS / perHost / 1_000 + 1e-9) * 1_000 : ceiling;
  out.suggestedBudget = Math.min(ceiling, Math.max(1_000, fit));
  return out;
}

/** "2.9 s" */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

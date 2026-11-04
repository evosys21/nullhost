// New NullHost versions: asks GitHub for the latest published release. It only reads;
// downloading and installing one is selfupdate.ts, and only when the user clicks Update.
import type { AppUpdate } from "../shared/api";

export const RELEASES_API = "https://api.github.com/repos/evosys21/nullhost/releases/latest";
const RELEASES_PAGE = "https://github.com/evosys21/nullhost/releases";

/** background checks: at most one a day, counting failed ones */
export const CHECK_EVERY_MS = 24 * 3600_000;

/** what desktop.json keeps between runs */
export interface StoredAppUpdate {
  /** off in Settings; on unless set to false */
  checkAppUpdates?: boolean;
  /** newest release seen, "1.2.3", and when GitHub said so */
  latestVersion?: string;
  latestCheckedAt?: string;
  /** the last check, successful or not: background checks wait a day after it */
  lastAttemptAt?: string;
  /** why the last check failed; cleared by the next successful one */
  lastError?: string;
  /** "Skip this version" */
  skippedVersion?: string;
  /** the version the Windows notification was shown for (once per version) */
  notifiedVersion?: string;
}

type Triple = [number, number, number];

/** "v1.2.3" or "1.2.3"; anything else (pre-releases included) is null */
export function parseVersion(v: unknown): Triple | null {
  const m = typeof v === "string" ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string | undefined, current: string): boolean {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** the release page for a version; built here, never taken from the API answer */
export const releaseUrl = (version: string) => `${RELEASES_PAGE}/tag/v${version}`;

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The latest published release ("1.2.3"); throws a short message when it cannot tell. */
export async function fetchLatestVersion(current: string, fetchFn: FetchFn = fetch, timeoutMs = 10_000): Promise<string> {
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `NullHost/${current}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("GitHub could not be reached");
  }
  if (res.status === 404) throw new Error("no release is published yet");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown };
  const v = parseVersion(body.tag_name);
  if (!v) throw new Error(`unexpected release tag ${JSON.stringify(body.tag_name)}`);
  return v.join(".");
}

/** a background check is due: checking is on and the last attempt is a day old (or there was none) */
export function checkDue(s: StoredAppUpdate, now: number): boolean {
  if (s.checkAppUpdates === false) return false;
  const stamp = s.lastAttemptAt ?? s.latestCheckedAt;
  const last = stamp ? new Date(stamp).getTime() : NaN;
  return !(now - last < CHECK_EVERY_MS);
}

/** the state after a check: the release found, or the error; the last known release stays on failure */
export function afterCheck(s: StoredAppUpdate, result: { version: string } | { error: string }, at: Date, clearSkip: boolean): StoredAppUpdate {
  const iso = at.toISOString();
  const next: StoredAppUpdate = { ...s, lastAttemptAt: iso };
  if ("version" in result) Object.assign(next, { latestVersion: result.version, latestCheckedAt: iso, lastError: undefined });
  else next.lastError = result.error;
  if (clearSkip) next.skippedVersion = undefined;
  return next;
}

export function appUpdateView(s: StoredAppUpdate, current: string, canInstall = false): AppUpdate {
  const enabled = s.checkAppUpdates !== false;
  const latest = parseVersion(s.latestVersion) ? s.latestVersion : undefined;
  const newer = isNewer(latest, current);
  return {
    enabled,
    current,
    latest,
    url: latest && newer ? releaseUrl(latest) : undefined,
    newer,
    available: enabled && newer && s.skippedVersion !== latest,
    checkedAt: s.latestCheckedAt,
    error: s.lastError,
    canInstall,
  };
}

/** the Windows notification is due: a newer version the user was not notified about yet */
export function notifyDue(s: StoredAppUpdate, current: string): boolean {
  const v = appUpdateView(s, current);
  return v.available && s.notifiedVersion !== v.latest;
}

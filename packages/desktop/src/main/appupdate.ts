// New NullHost versions: asks GitHub for the latest published release. It only reads;
// it never downloads or installs anything. The user opens the release page and runs
// the installer, which upgrades in place.
import type { AppUpdate } from "../shared/api";

export const RELEASES_API = "https://api.github.com/repos/evosys21/nullhost/releases/latest";
const RELEASES_PAGE = "https://github.com/evosys21/nullhost/releases";

/** checks while the app runs: at most one a day */
export const CHECK_EVERY_MS = 20 * 3600_000;

/** what desktop.json keeps between runs */
export interface StoredAppUpdate {
  /** off in Settings; on unless set to false */
  checkAppUpdates?: boolean;
  /** newest release seen, "1.2.3" */
  latestVersion?: string;
  latestCheckedAt?: string;
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

/** a background check is due: checking is on and the last one is old enough (or never ran) */
export function checkDue(s: StoredAppUpdate, now: number): boolean {
  if (s.checkAppUpdates === false) return false;
  const last = s.latestCheckedAt ? new Date(s.latestCheckedAt).getTime() : NaN;
  return !(now - last < CHECK_EVERY_MS);
}

export function appUpdateView(s: StoredAppUpdate, current: string, error?: string): AppUpdate {
  const enabled = s.checkAppUpdates !== false;
  const latest = parseVersion(s.latestVersion) ? s.latestVersion : undefined;
  const newer = isNewer(latest, current);
  return {
    enabled,
    current,
    latest,
    url: latest && newer ? releaseUrl(latest) : undefined,
    available: enabled && newer && s.skippedVersion !== latest,
    checkedAt: s.latestCheckedAt,
    error,
  };
}

/** the Windows notification is due: a newer version the user was not notified about yet */
export function notifyDue(s: StoredAppUpdate, current: string): boolean {
  const v = appUpdateView(s, current);
  return v.available && s.notifiedVersion !== v.latest;
}

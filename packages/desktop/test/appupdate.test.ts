import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_EVERY_MS, RELEASES_API, appUpdateView, checkDue, fetchLatestVersion, isNewer, notifyDue, parseVersion, releaseUrl, type FetchFn } from "../src/main/appupdate.ts";

test("versions: plain x.y.z with an optional v; pre-releases and junk are not versions", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("0.10.0"), [0, 10, 0]);
  for (const bad of ["1.2", "v1.2.3-beta.1", "latest", "", undefined, 3]) assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(isNewer("0.1.1", "0.1.0"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true, "numeric, not text, comparison");
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.0.9", "0.1.0"), false);
  assert.equal(isNewer(undefined, "0.1.0"), false);
  assert.equal(isNewer("v1.0.0-rc.1", "0.1.0"), false);
});

function fakeFetch(status: number, body: unknown): { fn: FetchFn; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fn, calls };
}

test("latest release: asks GitHub's releases API, reads the tag", async () => {
  const f = fakeFetch(200, { tag_name: "v0.2.0", html_url: "https://evil.example/download" });
  assert.equal(await fetchLatestVersion("0.1.0", f.fn), "0.2.0");
  assert.equal(f.calls[0]!.url, RELEASES_API);
  assert.equal(f.calls[0]!.headers["User-Agent"], "NullHost/0.1.0");
  // the download link is built from the version, never taken from the answer
  assert.equal(releaseUrl("0.2.0"), "https://github.com/evosys21/nullhost/releases/tag/v0.2.0");
});

test("latest release: failures are short messages", async () => {
  await assert.rejects(fetchLatestVersion("0.1.0", fakeFetch(404, {}).fn), /no release is published yet/);
  await assert.rejects(fetchLatestVersion("0.1.0", fakeFetch(403, {}).fn), /GitHub answered 403/);
  await assert.rejects(fetchLatestVersion("0.1.0", fakeFetch(200, { tag_name: "nightly" }).fn), /unexpected release tag/);
  await assert.rejects(fetchLatestVersion("0.1.0", async () => { throw new TypeError("fetch failed"); }), /could not be reached/);
});

test("background check: due once a day, never when switched off", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.equal(checkDue({}, now), true, "never checked");
  assert.equal(checkDue({ latestCheckedAt: new Date(now - 3600_000).toISOString() }, now), false);
  assert.equal(checkDue({ latestCheckedAt: new Date(now - CHECK_EVERY_MS).toISOString() }, now), true);
  assert.equal(checkDue({ latestCheckedAt: "garbage" }, now), true);
  assert.equal(checkDue({ checkAppUpdates: false }, now), false);
});

test("notice: newer and not skipped; the notification once per version", () => {
  const seen = { latestVersion: "0.2.0", latestCheckedAt: "2026-11-03T12:00:00Z" };
  const v = appUpdateView(seen, "0.1.0");
  assert.equal(v.available, true);
  assert.equal(v.url, "https://github.com/evosys21/nullhost/releases/tag/v0.2.0");
  assert.equal(appUpdateView(seen, "0.2.0").available, false, "already on it");
  assert.equal(appUpdateView(seen, "0.2.0").url, undefined);
  assert.equal(appUpdateView({ ...seen, skippedVersion: "0.2.0" }, "0.1.0").available, false);
  assert.equal(appUpdateView({ ...seen, skippedVersion: "0.1.5" }, "0.1.0").available, true, "an older skip does not hide a newer one");
  assert.equal(appUpdateView({ ...seen, checkAppUpdates: false }, "0.1.0").available, false);
  assert.equal(appUpdateView({ latestVersion: "<script>" }, "0.1.0").latest, undefined);

  assert.equal(notifyDue(seen, "0.1.0"), true);
  assert.equal(notifyDue({ ...seen, notifiedVersion: "0.2.0" }, "0.1.0"), false);
  assert.equal(notifyDue({ ...seen, notifiedVersion: "0.1.5" }, "0.1.0"), true);
});

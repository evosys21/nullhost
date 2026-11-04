import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_EVERY_MS, RELEASES_API, afterCheck, appUpdateView, checkDue, fetchLatestVersion, isNewer, notifyDue, parseVersion, releaseUrl, type FetchFn } from "../src/main/appupdate.ts";
import { service } from "./service-helper.ts";

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

test("background check: due once a day (24 h), never when switched off", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  assert.equal(CHECK_EVERY_MS, 24 * 3600_000);
  assert.equal(checkDue({}, now), true, "never checked");
  assert.equal(checkDue({ latestCheckedAt: ago(1) }, now), false);
  assert.equal(checkDue({ latestCheckedAt: ago(21) }, now), false, "21 h is not a day");
  assert.equal(checkDue({ latestCheckedAt: ago(24) }, now), true);
  assert.equal(checkDue({ latestCheckedAt: "garbage" }, now), true);
  assert.equal(checkDue({ checkAppUpdates: false }, now), false);
  // a failed attempt counts: no retry every few hours
  assert.equal(checkDue({ latestCheckedAt: ago(48), lastAttemptAt: ago(2) }, now), false);
});

test("after a check: success records the release; failure keeps it and records the attempt", () => {
  const at = new Date("2026-11-03T12:00:00Z");
  const known = { latestVersion: "0.2.0", latestCheckedAt: "2026-11-01T12:00:00Z", skippedVersion: "0.2.0", lastError: "old" };
  const ok = afterCheck(known, { version: "0.3.0" }, at, false);
  assert.deepEqual([ok.latestVersion, ok.latestCheckedAt, ok.lastAttemptAt, ok.lastError, ok.skippedVersion], ["0.3.0", at.toISOString(), at.toISOString(), undefined, "0.2.0"]);
  const failed = afterCheck(known, { error: "GitHub answered 403" }, at, false);
  assert.deepEqual([failed.latestVersion, failed.latestCheckedAt, failed.lastAttemptAt, failed.lastError], ["0.2.0", "2026-11-01T12:00:00Z", at.toISOString(), "GitHub answered 403"]);
  assert.equal(afterCheck(known, { version: "0.2.0" }, at, true).skippedVersion, undefined, "Check now clears a skip");
  assert.equal(appUpdateView(failed, "0.1.0").error, "GitHub answered 403");
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
  const off = appUpdateView({ ...seen, checkAppUpdates: false }, "0.1.0");
  assert.equal(off.available, false, "no banner when checking is off");
  assert.equal(off.newer, true, "but Check now still reports the newer release");
  assert.equal(appUpdateView({ latestVersion: "<script>" }, "0.1.0").latest, undefined);

  assert.equal(notifyDue(seen, "0.1.0"), true);
  assert.equal(notifyDue({ ...seen, notifiedVersion: "0.2.0" }, "0.1.0"), false);
  assert.equal(notifyDue({ ...seen, notifiedVersion: "0.1.5" }, "0.1.0"), true);
});

test("service: settings changed while GitHub answers are kept", async () => {
  let answer!: (v: string) => void;
  const t = await service(() => new Promise((r) => (answer = r)));
  try {
    const pending = t.svc.checkAppUpdateIfDue();
    await t.svc.setSettings({ checkAppUpdates: false, theme: "dark", hotkey: "Control+Alt+J" });
    answer("0.2.0");
    const u = await pending;
    assert.equal(u?.latest, "0.2.0");
    assert.equal(u?.enabled, false, "the check did not switch checking back on");
    const d = await t.desktopJson();
    assert.deepEqual([d.checkAppUpdates, d.theme, d.hotkey, d.latestVersion], [false, "dark", "Control+Alt+J", "0.2.0"]);
  } finally {
    await t.done();
  }
});

test("service: a failed check waits a day; Check now reports a newer release even when checking is off", async () => {
  let calls = 0;
  let fail = true;
  const t = await service(async () => { calls++; if (fail) throw new Error("GitHub answered 403"); return "0.2.0"; });
  try {
    const u = await t.svc.checkAppUpdateIfDue();
    assert.equal(u?.error, "GitHub answered 403");
    assert.equal(await t.svc.checkAppUpdateIfDue(), null, "not again right after a failure");
    assert.equal(await t.svc.checkAppUpdateIfDue(Date.now() + CHECK_EVERY_MS + 1000) !== null, true, "again a day later");
    assert.equal(calls, 2);

    fail = false;
    await t.svc.setSettings({ checkAppUpdates: false });
    const now = await t.svc.checkAppUpdate();
    assert.deepEqual([now.newer, now.available, now.latest, now.error], [true, false, "0.2.0", undefined]);
    assert.equal(await t.svc.takeAppUpdateNotice(), null, "no notification while checking is off");
  } finally {
    await t.done();
  }
});

test("service: the notification once per version, and not for a skipped one", async () => {
  const t = await service(async () => "0.2.0");
  try {
    await t.svc.checkAppUpdate();
    assert.equal((await t.svc.takeAppUpdateNotice())?.latest, "0.2.0");
    assert.equal(await t.svc.takeAppUpdateNotice(), null);
    await t.svc.skipAppUpdate("0.2.0");
    assert.equal((await t.svc.appUpdate()).available, false);
  } finally {
    await t.done();
  }
});

test("service: a dev build reports a newer version but cannot install it", async () => {
  const t = await service(async () => "0.2.0");
  try {
    const u = await t.svc.checkAppUpdate();
    assert.deepEqual([u.newer, u.canInstall], [true, false]);
    await assert.rejects(t.svc.installAppUpdate(), /installed or portable NullHost app/);
  } finally {
    await t.done();
  }
});

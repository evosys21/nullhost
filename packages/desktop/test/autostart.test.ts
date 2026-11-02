import assert from "node:assert/strict";
import { test } from "node:test";
import { loginItemAutostart, removeLegacyLogonTask, type LoginItems } from "../src/main/autostart.ts";

function fakeItems() {
  const calls: Array<{ openAtLogin: boolean; args: string[] }> = [];
  let on = false;
  const items: LoginItems = {
    getLoginItemSettings: () => ({ openAtLogin: on }),
    setLoginItemSettings: (o) => {
      calls.push(o);
      on = o.openAtLogin;
    },
  };
  return { items, calls };
}

test("login item: off in dev; on/off with --hidden when installed", async () => {
  const dev = fakeItems();
  const a = loginItemAutostart(dev.items, false);
  assert.equal(a.available, false);
  assert.equal(await a.isEnabled(), false);
  await assert.rejects(a.enable(), /installed app/);
  await a.disable();
  assert.deepEqual(dev.calls, []);

  if (process.platform !== "win32") return;
  const inst = fakeItems();
  const b = loginItemAutostart(inst.items, true);
  await b.enable();
  assert.equal(await b.isEnabled(), true);
  await b.disable();
  assert.equal(await b.isEnabled(), false);
  assert.deepEqual(inst.calls, [
    { openAtLogin: true, args: ["--hidden"] },
    { openAtLogin: false, args: ["--hidden"] },
  ]);
});

test("legacy logon task: deleted only when present", async () => {
  const calls: string[][] = [];
  const absent = await removeLegacyLogonTask(async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
  });
  assert.equal(absent, false);
  assert.deepEqual(calls, [["schtasks", "/Query", "/TN", "NullHost Autostart"]]);

  calls.length = 0;
  const present = await removeLegacyLogonTask(async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: "SUCCESS", stderr: "" };
  });
  assert.equal(present, true);
  assert.deepEqual(calls.at(-1), ["schtasks", "/Delete", "/TN", "NullHost Autostart", "/F"]);
});

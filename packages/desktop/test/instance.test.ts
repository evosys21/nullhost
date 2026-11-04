import assert from "node:assert/strict";
import { test } from "node:test";
import { canSwitchTo, describe, differentCopy, parseInstanceInfo, switchScript, type InstanceInfo } from "../src/main/instance.ts";
import { hiddenPowerShell } from "../src/main/selfupdate.ts";

test("hidden PowerShell: started by a short-lived one, the script as UTF-16, in the folder given", () => {
  const args = hiddenPowerShell("Start-Process -FilePath 'D:\\Töols\\NullHost.exe'", "D:\\Töols");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  const m = /^Start-Process -FilePath 'powershell\.exe' -WindowStyle Hidden -WorkingDirectory 'D:\\Töols' -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)'$/.exec(args[3]!);
  assert.ok(m, args[3]);
  assert.equal(Buffer.from(m[1]!, "base64").toString("utf16le"), "Start-Process -FilePath 'D:\\Töols\\NullHost.exe'");
  assert.doesNotMatch(hiddenPowerShell("x")[3]!, /WorkingDirectory/);
});

const installed: InstanceInfo = { exe: "C:\\Program Files\\NullHost\\NullHost.exe", version: "0.1.3", kind: "installed", args: [] };
const portable: InstanceInfo = { exe: "D:\\Tools\\NullHost-0.1.3-portable\\NullHost.exe", version: "0.1.3", kind: "portable", args: ["--hidden"] };

test("started copy: only well-formed data from another process is used", () => {
  assert.deepEqual(parseInstanceInfo({ ...portable }), portable);
  const bad = [
    undefined, null, "x", {},
    { ...portable, exe: "NullHost.exe" }, { ...portable, version: "latest" }, { ...portable, kind: "evil" },
    { ...portable, exe: `C:\\${"a".repeat(2000)}` }, { ...portable, args: "x" }, { ...portable, args: [1] }, { ...portable, args: Array(40).fill("x") },
  ];
  for (const b of bad) assert.equal(parseInstanceInfo(b), null, JSON.stringify(b)?.slice(0, 60));
});

test("the same copy only brings the window up; another copy or version asks", () => {
  assert.equal(differentCopy(installed, { ...installed, exe: "c:\\program files\\nullhost\\NULLHOST.EXE" }), false, "Windows paths ignore case");
  assert.equal(differentCopy(installed, portable), true);
  assert.equal(differentCopy(installed, { ...installed, version: "0.1.4" }), true, "upgraded in place while running");
  assert.equal(describe(portable), "NullHost 0.1.3 (portable)");
});

test("switch: only to a real NullHost.exe, after this process has ended, with its arguments", () => {
  assert.equal(canSwitchTo(portable), true);
  assert.equal(canSwitchTo({ ...portable, kind: "dev build" }), false);
  assert.equal(canSwitchTo({ ...portable, exe: "D:\\x\\electron.exe" }), false);
  assert.equal(
    switchScript(42, { exe: "D:\\o'brien\\NullHost.exe", args: [] }),
    "try { Wait-Process -Id 42 -Timeout 30 } catch {}; Start-Process -FilePath 'D:\\o''brien\\NullHost.exe'",
  );
  assert.equal(
    switchScript(42, { exe: "D:\\x\\NullHost.exe", args: ["--hidden", "--hosts-file", "D:\\my copy\\hosts"] }),
    `try { Wait-Process -Id 42 -Timeout 30 } catch {}; Start-Process -FilePath 'D:\\x\\NullHost.exe' -ArgumentList '--hidden --hosts-file "D:\\my copy\\hosts"'`,
  );
});

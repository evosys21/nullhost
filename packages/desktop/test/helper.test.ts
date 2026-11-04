import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeWithRetry, type ScheduleStatus } from "@nullhost/core";
import { HelperBroker, MAX_CONTENT, handleHelperRequest, runHelper, type HelperContext } from "../src/main/helper.ts";

async function tempHosts() {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-helper-"));
  const hostsPath = join(dir, "hosts");
  await writeFile(hostsPath, "# hosts\r\n");
  return hostsPath;
}

function ctxFor(hostsPath: string, o: { elevated?: boolean } = {}) {
  const log: string[] = [];
  const ctx: HelperContext = {
    hostsPath,
    elevated: o.elevated ?? false,
    write: (path, content) => {
      log.push(`write ${path}`);
      return writeWithRetry(path, content);
    },
    flush: async () => {
      log.push("flush");
    },
    schedule: async (at, paths): Promise<ScheduleStatus> => {
      log.push(`schedule ${at} ${paths.dataDir} ${paths.hostsFile ?? "-"}`);
      return { installed: at !== null, available: true, at: at ?? undefined };
    },
    dnsLog: async (action) => {
      log.push(`dnslog ${action}`);
    },
  };
  return { ctx, log };
}

test("dnslog: only enable, disable or clear reach the context", async () => {
  const { ctx, log } = ctxFor(await tempHosts());
  for (const action of ["enable", "disable", "clear"]) assert.equal(await handleHelperRequest({ id: 1, op: "dnslog", action }, ctx), null);
  assert.deepEqual(log, ["dnslog enable", "dnslog disable", "dnslog clear"]);
  for (const action of [undefined, "", "Enable", "enable /ms:1", ["enable"], 1]) {
    await assert.rejects(handleHelperRequest({ id: 2, op: "dnslog", action }, ctx), /enable, disable or clear/);
  }
  assert.equal(log.length, 3);
});

test("requests are validated; write always targets the helper's own hosts path", async () => {
  const hostsPath = await tempHosts();
  const { ctx, log } = ctxFor(hostsPath);
  await handleHelperRequest({ id: 1, op: "write", content: "# new\r\n", path: "C:\\Windows\\win.ini" }, ctx);
  assert.deepEqual(log, [`write ${hostsPath}`], "a path in the request is ignored");
  assert.equal(await readFile(hostsPath, "latin1"), "# new\r\n");

  await assert.rejects(handleHelperRequest({ id: 2, op: "write", content: 42 }, ctx), /content/);
  await assert.rejects(handleHelperRequest({ id: 3, op: "write", content: "x".repeat(MAX_CONTENT + 1) }, ctx), /too large/);
  await assert.rejects(handleHelperRequest({ id: 4, op: "rm -rf" }, ctx), /unknown request/);
  await assert.rejects(handleHelperRequest(null, ctx), /bad request/);
  await assert.rejects(handleHelperRequest({ id: 5, op: "schedule", at: "25:00", dataDir: "C:\\d", configFile: "C:\\c" }, ctx), /HH:MM/);
  await assert.rejects(handleHelperRequest({ id: 6, op: "schedule", at: "07:30", dataDir: "relative\\dir", configFile: "C:\\c" }, ctx), /absolute/);
  await assert.rejects(handleHelperRequest({ id: 7, op: "schedule", at: "07:30", dataDir: 'C:\\a" & calc', configFile: "C:\\c" }, ctx), /without quotes/);

  const elevated = ctxFor(hostsPath, { elevated: true }).ctx;
  await assert.rejects(
    handleHelperRequest({ id: 8, op: "schedule", at: "07:30", dataDir: "C:\\d", configFile: "C:\\c", hostsFile: "C:\\Windows\\win.ini" }, elevated),
    /not accepted by an elevated helper/,
  );
  assert.deepEqual(await handleHelperRequest({ id: 9, op: "schedule", at: null, dataDir: "C:\\d", configFile: "C:\\c" }, elevated), { installed: false, available: true, at: undefined });
});

test("broker and helper over a real named pipe: write, flush, schedule, then stop with the app", async () => {
  const hostsPath = await tempHosts();
  const { ctx, log } = ctxFor(hostsPath);
  let helperExit: Promise<number> | undefined;
  let launches = 0;
  const states: boolean[] = [];
  const broker = new HelperBroker({
    launch: async (pipe, token) => {
      launches++;
      helperExit = runHelper({ pipe, token, ctx });
    },
    onState: (running) => states.push(running),
    connectTimeoutMs: 5_000,
  });
  assert.equal(broker.running, false);

  const report = await broker.request<{ bytes: number }>("write", { content: "0.0.0.0 ads.example.com\r\n" });
  assert.equal(report.bytes, 25);
  assert.equal(await readFile(hostsPath, "latin1"), "0.0.0.0 ads.example.com\r\n");
  await broker.request("flush");
  const st = await broker.request<ScheduleStatus>("schedule", { at: "07:30", dataDir: "C:\\data", configFile: "C:\\cfg\\config.toml" });
  assert.equal(st.installed, true);
  await assert.rejects(broker.request("schedule", { at: "nope", dataDir: "C:\\d", configFile: "C:\\c" }), /HH:MM/);
  assert.equal(launches, 1, "one helper (one UAC prompt) for the whole session");
  assert.deepEqual(log, [`write ${hostsPath}`, "flush", "schedule 07:30 C:\\data -"]);

  broker.close();
  assert.equal(await helperExit, 0, "the helper exits when the app goes away");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(broker.running, false);
  assert.deepEqual(states, [true], "the stop we asked for (quitting) is not reported: the window may be gone");

  // a late request while quitting (the pause timer, a tray click) must not start a new helper
  await assert.rejects(broker.request("flush"), /quitting/);
  assert.equal(launches, 1, "no second helper, no UAC prompt while quitting");
  assert.deepEqual(states, [true]);
});

test("close() while the helper is starting: it connects, is let go, and nothing is reported", async () => {
  const { ctx } = ctxFor(await tempHosts());
  let helperExit: Promise<number> | undefined;
  const states: boolean[] = [];
  const broker = new HelperBroker({
    launch: async (pipe, token) => {
      broker.close(); // the app quits while the UAC prompt is up
      helperExit = runHelper({ pipe, token, ctx });
    },
    onState: (running) => states.push(running),
    connectTimeoutMs: 5_000,
  });
  await assert.rejects(broker.request("flush"), /quitting/);
  assert.equal(await helperExit, 0, "the helper that did start exits");
  assert.equal(broker.running, false);
  assert.deepEqual(states, []);
});

test("a client without the secret is refused; the broker reports a helper that never connects", async () => {
  const hostsPath = await tempHosts();
  const { ctx, log } = ctxFor(hostsPath);
  const broker = new HelperBroker({
    launch: async (pipe) => {
      void runHelper({ pipe, token: "0".repeat(64), ctx }); // wrong secret
    },
    connectTimeoutMs: 800,
  });
  await assert.rejects(broker.request("write", { content: "x" }), /did not start in time/);
  assert.deepEqual(log, [], "nothing was written");
  assert.equal(await readFile(hostsPath, "latin1"), "# hosts\r\n");
});

test("a declined UAC prompt surfaces as a clear error and nothing runs", async () => {
  const broker = new HelperBroker({
    launch: async () => {
      throw new Error("Administrator rights were not granted, so the hosts file was not changed.");
    },
  });
  await assert.rejects(broker.request("flush"), /not granted/);
  assert.equal(broker.running, false);
});

test("the helper refuses a foreign pipe name or a malformed secret", async () => {
  const { ctx } = ctxFor(await tempHosts());
  assert.equal(await runHelper({ pipe: "\\\\.\\pipe\\something-else", token: "a".repeat(64), ctx }), 2);
  assert.equal(await runHelper({ pipe: "\\\\.\\pipe\\nullhost-x", token: "short", ctx }), 2);
});

// A Service on a temp copy of a hosts file, for the update tests (not a test file itself).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostsFile, writeWithRetry, type Platform } from "@nullhost/core";
import { Service, type ServiceOptions } from "../src/main/service.ts";

/** a Service on a temp copy, with GitHub replaced by `latest`; `extra` overrides options */
export async function service(latest: () => Promise<string>, extra: Partial<ServiceOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nullhost-appupdate-"));
  const hostsFile = join(dir, "hosts");
  await writeFile(hostsFile, "127.0.0.1 localhost\r\n");
  const platform: Platform = {
    name: "windows", eol: "\r\n", perLine: 9, hardCeiling: 1_000,
    systemHostsPath: () => "C:\\Windows\\System32\\drivers\\etc\\hosts",
    isElevated: async () => false,
    readHosts: readHostsFile,
    writeHosts: (p, c) => writeWithRetry(p, c),
    flushDns: async () => undefined,
  };
  const svc = await Service.create({
    version: "0.1.0", hostsFile, dataDir: join(dir, "data"), platform, dev: true,
    scheduler: () => { throw new Error("not in this test"); },
    scheduledCommand: () => { throw new Error("not in this test"); },
    autostart: { available: false, isEnabled: async () => false, enable: async () => undefined, disable: async () => undefined },
    registerHotkey: () => true,
    openPath: async () => undefined,
    latestVersion: latest,
    ...extra,
  });
  const desktopJson = async () => JSON.parse(await readFile(join(dir, "data", "desktop.json"), "utf8")) as Record<string, unknown>;
  return { svc, dir, desktopJson, done: () => rm(dir, { recursive: true, force: true }) };
}

// Packs dist/win-unpacked (left by electron-builder) into dist/NullHost-<version>-portable.zip,
// with the NullHost.portable marker that makes the app leave out the daily task and
// start at login (src/main/index.ts). Run after `electron-builder`; see `yarn dist`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const unpacked = join(dist, "win-unpacked");
if (!existsSync(join(unpacked, "NullHost.exe"))) throw new Error(`no ${unpacked}\\NullHost.exe: run electron-builder first`);

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const name = `NullHost-${version}-portable`;
const stage = join(dist, name);
const zip = join(dist, `${name}.zip`);

rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
cpSync(unpacked, stage, { recursive: true });
writeFileSync(
  join(stage, "NullHost.portable"),
  "This file marks the portable copy of NullHost: no daily background update and no start at login.\r\n" +
    "Settings live in %APPDATA%\\NullHost and %LOCALAPPDATA%\\NullHost, as for the installed app.\r\n",
);
// Windows' own bsdtar writes a zip with -a and a .zip name (by full path: Git's GNU tar may come first on PATH)
const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
execFileSync(tar, ["-a", "-c", "-f", `${name}.zip`, name], { cwd: dist, stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
console.log(`wrote ${zip}`);

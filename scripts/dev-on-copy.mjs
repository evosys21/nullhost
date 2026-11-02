// Start the NullHost desktop app (dev mode, live reload) against a COPY of the
// system hosts file kept in .dev/ in this repo. The real hosts file and DNS are
// never touched. .dev/ is git-ignored: the copy holds your private host names.
//
//   corepack yarn desktop:copy            reuse .dev/hosts (copied once)
//   corepack yarn desktop:copy --fresh    start over from the current system file
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dev = join(root, ".dev");
const hosts = join(dev, "hosts");
const data = join(dev, "data");
const system = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

if (process.argv.includes("--fresh")) rmSync(dev, { recursive: true, force: true });
mkdirSync(dev, { recursive: true });
if (!existsSync(hosts)) {
  copyFileSync(system, hosts);
  console.log(`copied ${system} -> ${hosts}`);
}
console.log(`hosts file: ${hosts}\ndata:       ${data}`);

const child = spawn("corepack", ["yarn", "workspace", "@nullhost/desktop", "dev"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NULLHOST_HOSTS_FILE: hosts, NULLHOST_DATA_DIR: data },
});
child.on("exit", (code) => process.exit(code ?? 0));

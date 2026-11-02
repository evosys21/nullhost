// Start the NullHost desktop app in dev mode (live reload) on the REAL hosts file,
// the way the installed app runs: as a normal user, with NULLHOST_* variables
// cleared. The first change (Update now, Apply, the switch, pause, the hotkey)
// asks for administrator rights once; an elevated helper then writes the hosts
// file and flushes DNS for the rest of the session.
//
//   corepack yarn desktop:live             start
//   corepack yarn desktop:live --dry-run   only show what it would do
//
// Before the first run: quit HostsMan (hm.exe) and any other NullHost instance.
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

function running(imageName) {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    return out.toLowerCase().includes(`"${imageName.toLowerCase()}"`);
  } catch {
    return false;
  }
}

const warnings = [];
if (running("hm.exe")) warnings.push("HostsMan (hm.exe) is running: its updater rewrites the hosts file and removes NullHost's region. Quit it first.");
if (running("NullHost.exe")) warnings.push("The installed NullHost is running: only one NullHost can run. Quit it from its tray icon first.");
const stray = Object.keys(process.env).filter((k) => k.toUpperCase().startsWith("NULLHOST_"));

console.log(`repo:        ${root}`);
console.log("hosts file:  the real system hosts file; DNS is flushed after each write");
console.log("admin:       asked for once, on the first change of the session (UAC)");
console.log(`clearing:    ${stray.length ? stray.join(", ") : "(no NULLHOST_* variables set)"}`);
for (const w of warnings) console.log(`warning:     ${w}`);
if (dryRun) process.exit(0);

const env = { ...process.env };
for (const k of stray) delete env[k];
const child = spawn("corepack", ["yarn", "workspace", "@nullhost/desktop", "dev"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));

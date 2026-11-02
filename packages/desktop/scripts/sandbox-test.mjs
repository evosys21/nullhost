// Prepare and start the Windows Sandbox test of the built installer.
//   corepack yarn workspace @nullhost/desktop dist
//   node packages/desktop/scripts/sandbox-test.mjs
// Maps dist/ read-only and dist/sandbox-results/ writable into a throwaway
// Windows, where sandbox/sandbox-test.ps1 installs, exercises and uninstalls
// NullHost against the sandbox's own hosts file. Nothing touches this PC's
// hosts file. Needs the Windows Sandbox feature.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");
const results = join(dist, "sandbox-results");
const sandboxExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe");

if (!existsSync(sandboxExe)) {
  console.error("Windows Sandbox is not enabled. In an admin PowerShell, then reboot:");
  console.error("  Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All");
  process.exit(2);
}
rmSync(results, { recursive: true, force: true });
mkdirSync(results, { recursive: true });
copyFileSync(join(pkg, "sandbox", "sandbox-test.ps1"), join(results, "sandbox-test.ps1"));

const x = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const wsb = `<Configuration>
  <Networking>Enable</Networking>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>${x(dist)}</HostFolder><SandboxFolder>C:\\dist</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${x(results)}</HostFolder><SandboxFolder>C:\\results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\results\\sandbox-test.ps1</Command>
  </LogonCommand>
</Configuration>
`;
const wsbFile = join(dist, "nullhost-test.wsb");
writeFileSync(wsbFile, wsb, "utf8");
console.log(`starting Windows Sandbox; results will appear in ${results}`);
spawn(sandboxExe, [wsbFile], { detached: true, stdio: "ignore" }).unref();

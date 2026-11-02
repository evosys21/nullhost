# Runs INSIDE Windows Sandbox (started by nullhost-test.wsb). Installs NullHost,
# exercises it against the sandbox's own hosts file, uninstalls it, and writes
# everything to C:\results (mapped to the host). The sandbox is thrown away after.
$ErrorActionPreference = "Continue"
$out = "C:\results"
$log = Join-Path $out "sandbox-test.log"
function Log($m) { "$(Get-Date -Format o) $m" | Tee-Object -FilePath $log -Append }
$r = [ordered]@{ started = (Get-Date).ToString("o"); user = $env:USERNAME }
$hosts = "$env:SystemRoot\System32\drivers\etc\hosts"
$exe = "C:\Program Files\NullHost\NullHost.exe"

try {
  $setup = Get-ChildItem C:\dist -Filter "NullHost-Setup-*.exe" | Select-Object -First 1
  Log "installing $($setup.Name) silently"
  $p = Start-Process $setup.FullName -ArgumentList "/S" -Wait -PassThru
  $r.installExit = $p.ExitCode
  $r.installed = Test-Path $exe
  Log "install exit $($p.ExitCode), exe present: $($r.installed)"

  # the scheduled task's job: headless update on the real (sandbox) hosts file
  Log "headless update"
  $p = Start-Process $exe -ArgumentList "--scheduled-update" -Wait -PassThru
  $r.updateExit = $p.ExitCode
  $text = Get-Content $hosts -Raw
  $r.regionWritten = $text.Contains("# >>> nullhost managed")
  $r.hostsLines = ($text -split "`n").Count
  $r.updateLog = Get-Content "$env:LOCALAPPDATA\NullHost\scheduled-update.log" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
  try { $r.resolveAdDoubleclick = (Resolve-DnsName ad.doubleclick.net -Type A -ErrorAction Stop | Where-Object IPAddress | Select-Object -First 1).IPAddress } catch { $r.resolveAdDoubleclick = "error: $($_.Exception.Message)" }
  Log "update exit $($r.updateExit), region $($r.regionWritten), ad.doubleclick.net -> $($r.resolveAdDoubleclick)"

  # the elevated UI, screenshots, plus start at login + daily updates switched on
  Log "smoke run"
  $env:NULLHOST_SANDBOX_TEST = "1"
  $p = Start-Process $exe -ArgumentList "--smoke=$out\shots" -Wait -PassThru
  $r.smokeExit = $p.ExitCode
  $r.tasksAfterSmoke = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object TaskName -like "NullHost*" | ForEach-Object { "$($_.TaskName): $($_.Principal.UserId) $($_.Principal.RunLevel)" })
  Log "smoke exit $($r.smokeExit); tasks: $($r.tasksAfterSmoke -join ', ')"

  # uninstall: the clean-up must remove the region and both tasks, keep the rest
  Log "uninstalling silently"
  $un = Get-ChildItem "C:\Program Files\NullHost" -Filter "Uninstall*.exe" | Select-Object -First 1
  $p = Start-Process $un.FullName -ArgumentList "/S" -Wait -PassThru
  Start-Sleep -Seconds 8   # the NSIS uninstaller re-launches itself from %TEMP%
  $r.uninstallExit = $p.ExitCode
  $r.exeGone = -not (Test-Path $exe)
  $r.regionGone = -not (Get-Content $hosts -Raw).Contains("# >>> nullhost managed")
  $r.tasksAfterUninstall = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object TaskName -like "NullHost*" | ForEach-Object TaskName)
  $r.uninstallLog = Get-Content "$env:LOCALAPPDATA\NullHost\uninstall.log" -ErrorAction SilentlyContinue
  $r.snapshotsKept = (Get-ChildItem "$env:LOCALAPPDATA\NullHost\snapshots" -ErrorAction SilentlyContinue | Measure-Object).Count
  Log "uninstall exit $($r.uninstallExit); exe gone $($r.exeGone); region gone $($r.regionGone); tasks left: $($r.tasksAfterUninstall -join ', ')"
} catch {
  $r.error = $_.Exception.Message
  Log "ERROR $($_.Exception.Message)"
} finally {
  $r.finished = (Get-Date).ToString("o")
  $r | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $out "result.json") -Encoding utf8
  Log "done; closing the sandbox"
  shutdown /s /t 10
}

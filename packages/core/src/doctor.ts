import { lookup } from "node:dns/promises";
import { stat } from "node:fs/promises";
import type { Engine } from "./engine.ts";
import { RELOAD_TARGET_MS, RELOAD_WARN_MS, seconds, withTimeout, type ReloadCost } from "./reload.ts";
import { extractRegion, findRegions, regionHosts } from "./render.ts";

export type CheckLevel = "ok" | "info" | "warn" | "error";

export interface Check {
  id: string;
  level: CheckLevel;
  label: string;
  detail: string;
  /** what to do about it, when there is something to do */
  fix?: string;
}

export interface ScheduleStatus {
  installed: boolean;
  /** false when this build cannot install it (dev, not elevated) */
  available: boolean;
  at?: string;
  lastRun?: string;
  /** 0 = success */
  lastResult?: number;
  nextRun?: string;
}

const DAY = 24 * 3600_000;
const n = (x: number) => x.toLocaleString("en-US");

/** The measured DNS Client reload, from state.json (see reload.ts). */
export function reloadCheck(cost: ReloadCost | undefined, budget: number): Check | null {
  const label = "DNS Client reload after a write";
  if (!cost) return null;
  const { last } = cost;
  const took = last.timedOut ? `no answer from the new file within ${seconds(last.ms)}` : `${seconds(last.ms)}`;
  let detail = `last write: ${took} for ${n(last.hosts)} hosts`;
  if (cost.perHostMs !== undefined && cost.suggestedBudget !== undefined) {
    detail += `; about ${seconds(cost.perHostMs * 10_000)} per 10,000 hosts on this PC, so a budget of ${n(cost.suggestedBudget)} keeps a reload near ${seconds(RELOAD_TARGET_MS)}`;
  }
  const suggest = cost.suggestedBudget !== undefined && cost.suggestedBudget < budget ? cost.suggestedBudget : undefined;
  if (cost.slow) {
    return {
      id: "reload",
      level: "warn",
      label,
      detail,
      fix: `${suggest !== undefined ? `Lower the entry budget to ${n(suggest)} (Settings) and turn` : "Turn"} off a large source. Each write, and each reload at boot, stalls name resolution this long; over ${seconds(RELOAD_WARN_MS)} the boot-time reloads can hang the DNS Client.`,
    };
  }
  if (suggest !== undefined) {
    return { id: "reload", level: "info", label, detail, fix: `The budget of ${n(budget)} would let a reload take about ${seconds((cost.perHostMs ?? 0) * budget)} here; ${n(suggest)} keeps it near ${seconds(RELOAD_TARGET_MS)}.` };
  }
  return { id: "reload", level: "ok", label, detail };
}

/**
 * Read-only health checks for the Troubleshoot panel and `nullhost doctor`.
 * Nothing here writes, flushes or restarts anything.
 */
export async function doctor(
  engine: Engine,
  o: { schedule?: ScheduleStatus; now?: Date; /** the desktop app writes through its elevated helper */ writer?: { helper: true; running: boolean } } = {},
): Promise<Check[]> {
  const now = o.now ?? new Date();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const p = engine.platform;

  let text = "";
  try {
    text = await p.readHosts(engine.hostsFile);
    add({ id: "hosts-read", level: "ok", label: "Hosts file readable", detail: engine.hostsFile });
  } catch (err) {
    add({ id: "hosts-read", level: "error", label: "Hosts file readable", detail: (err as Error).message });
    return checks;
  }

  if (o.writer?.helper) {
    add({
      id: "elevated",
      level: "ok",
      label: "Administrator rights",
      detail: o.writer.running
        ? "the administrator helper is running for this session"
        : "asked for once, on the first change of a session (a small helper then writes the hosts file)",
    });
  } else if (engine.isSystemFile) {
    const elevated = await p.isElevated();
    add(elevated
      ? { id: "elevated", level: "ok", label: "Running as administrator", detail: "NullHost can change the hosts file" }
      : { id: "elevated", level: "warn", label: "Running as administrator", detail: "no: NullHost can read the hosts file but not change it", fix: "Start NullHost as administrator." });
  } else {
    add({ id: "elevated", level: "info", label: "Working on a copy", detail: "the system hosts file is not used; DNS is not flushed" });
  }

  try {
    const readOnly = ((await stat(engine.hostsFile)).mode & 0o200) === 0;
    if (readOnly) add({ id: "read-only", level: "error", label: "Hosts file attribute", detail: "read-only: nothing can write it", fix: "Clear the read-only attribute (another tool may have set it to protect the file)." });
  } catch {
    /* missing file is reported by the region check */
  }

  const st = await engine.status();
  const r = st.region;
  if (!r.present) {
    add(r.unterminated
      ? { id: "region", level: "error", label: "NullHost region", detail: "its start and end markers do not pair up; NullHost does not write the file until they do", fix: "Open the Editor and remove the broken marker lines (or restore a snapshot), then Apply." }
      : { id: "region", level: st.lastApply ? "warn" : "info", label: "NullHost region", detail: st.lastApply ? "missing: something removed it" : "not written yet", fix: "Apply or Update lists writes it." });
  } else if (r.modifiedExternally) {
    add({ id: "region", level: "warn", label: "NullHost region", detail: "changed by something else since NullHost wrote it", fix: "Apply rewrites it. If it keeps happening, another tool (HostsMan's updater, Defender) is rewriting the file." });
  } else if (r.count > 1) {
    add({ id: "region", level: "warn", label: "NullHost region", detail: `${r.count} regions found`, fix: "Apply merges them into one." });
  } else {
    add({ id: "region", level: "ok", label: "NullHost region", detail: `${r.hosts.toLocaleString("en-US")} hosts in ${r.lines.toLocaleString("en-US")} lines` });
  }

  if (st.leftovers.hosts) {
    add({ id: "leftovers", level: "warn", label: "Old block entries outside the region", detail: `${st.leftovers.hosts.toLocaleString("en-US")} already covered by NullHost (HostsMan leftovers?)`, fix: "Dashboard > Review clean-up, or: nullhost tidy" });
  }

  // Windows reads at most 9 names per line; more are silently ignored
  const outside = findRegions(text).reduceRight((t, s) => t.slice(0, s.start) + t.slice(s.end), text);
  let longLines = 0;
  for (const line of outside.split(/\r?\n/)) {
    const body = line.split("#")[0]!.trim();
    if (body && body.split(/\s+/).length - 1 > 9) longLines++;
  }
  if (longLines && p.name === "windows") {
    add({ id: "long-lines", level: "warn", label: "Lines with more than 9 host names", detail: `${longLines} outside the region; Windows ignores the names after the 9th`, fix: "Split them in the Editor, 9 names per line at most." });
  }

  const cfg = await engine.config();
  if (r.hosts > cfg.budget) {
    add({ id: "budget", level: "warn", label: "Entry budget", detail: `${r.hosts.toLocaleString("en-US")} hosts, budget ${cfg.budget.toLocaleString("en-US")}`, fix: "Turn off a large source; each update stalls DNS longer." });
  }

  const reload = reloadCheck(st.reload, cfg.budget);
  if (reload) add(reload);
  else if (engine.isSystemFile && p.resolve) {
    add({ id: "reload", level: "info", label: "DNS Client reload after a write", detail: "not measured yet: NullHost times it after its next write that changes the blocked names" });
  }

  const last = st.lastUpdate?.at;
  if (!last) add({ id: "updated", level: "info", label: "Last list update", detail: "never", fix: "Update lists downloads them." });
  else if (now.getTime() - new Date(last).getTime() > 3 * DAY) add({ id: "updated", level: "warn", label: "Last list update", detail: `${Math.floor((now.getTime() - new Date(last).getTime()) / DAY)} days ago`, fix: "Update lists, and turn on daily list updates." });
  else add({ id: "updated", level: "ok", label: "Last list update", detail: new Date(last).toLocaleString() });
  const failed = Object.entries(st.lastUpdate?.sources ?? {}).filter(([, run]) => run.from === "failed" || run.from === "cache-fallback");
  if (failed.length) {
    add({ id: "sources", level: "warn", label: "Sources that did not download", detail: failed.map(([id, run]) => `${id} (${run.error ?? run.from})`).join(", "), fix: "Usually temporary. If it persists, the list may have moved or been retired." });
  }

  if (o.schedule) {
    const s = o.schedule;
    if (!s.installed) add({ id: "schedule", level: "info", label: "Daily list updates", detail: s.available ? "off" : "off (switching it on needs NullHost running as administrator)" });
    else if (s.lastResult !== undefined && s.lastResult !== 0 && s.lastRun) add({ id: "schedule", level: "warn", label: "Daily list updates", detail: `last run ${s.lastRun} failed (result ${s.lastResult})`, fix: "Run Update lists to see the error." });
    else add({ id: "schedule", level: "ok", label: "Daily list updates", detail: `daily at ${s.at ?? "?"}${s.nextRun ? `, next ${s.nextRun}` : ""}` });
  }

  const diag = p.diagnostics;
  if (diag) {
    const tools = await diag.otherHostsTools();
    if (tools?.length) {
      add({ id: "other-tools", level: "warn", label: "Other hosts-file tools running", detail: tools.join(", "), fix: "Quit HostsMan and turn off its automatic updates: its updater rewrites the hosts file and removes NullHost's region. Uninstall it once NullHost runs well." });
    }
  }
  if (diag && engine.isSystemFile) {
    const dns = await diag.dnsClientRunning();
    if (dns === false) add({ id: "dnscache", level: "error", label: "DNS Client service", detail: "not running: on Windows 11 24H2 name resolution stops without it", fix: "Start the DNS Client service (or reboot). Do not disable it for hosts files." });
    else if (dns) add({ id: "dnscache", level: "ok", label: "DNS Client service", detail: "running" });

    const excluded = await diag.defenderExcludes(engine.hostsFile);
    if (excluded === true) add({ id: "defender", level: "ok", label: "Defender exclusion for the hosts file", detail: "set" });
    else if (excluded === false) add({ id: "defender", level: "warn", label: "Defender exclusion for the hosts file", detail: "not set: Defender may revert the file as SettingsModifier:Win32/HostsFileHijack", fix: `Windows Security > Virus & threat protection > Manage settings > Exclusions > Add: ${engine.hostsFile}` });
    else add({ id: "defender", level: "info", label: "Defender exclusion for the hosts file", detail: "could not check (needs administrator, or Defender is not the active antivirus)" });
  }

  // does the resolver answer from the file? (system file only, blocking on)
  const region = extractRegion(text);
  const probe = region ? regionHosts(region)[0] : undefined;
  if (engine.isSystemFile && probe && st.blocking.mode === "enabled") {
    try {
      const res = await withTimeout(lookup(probe, { family: 4 }), 5_000);
      if (res === "timeout") add({ id: "resolve", level: "warn", label: "Resolver uses the file", detail: `${probe}: no answer within 5 s (the DNS Client may still be reloading)` });
      else if (res.address === "0.0.0.0" || res.address === "127.0.0.1") add({ id: "resolve", level: "ok", label: "Resolver uses the file", detail: `${probe} -> ${res.address}` });
      else add({ id: "resolve", level: "warn", label: "Resolver uses the file", detail: `${probe} -> ${res.address}, expected ${cfg.ip}`, fix: "Wait a few seconds for the DNS Client to reload, then check again. A VPN or secure-DNS setting can bypass the hosts file." });
    } catch (err) {
      add({ id: "resolve", level: "info", label: "Resolver uses the file", detail: `${probe}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` });
    }
  }

  add({ id: "catalog", level: "info", label: "Catalog", detail: `version ${engine.catalog.version}, ${engine.catalog.sources.length} lists` });
  return checks;
}

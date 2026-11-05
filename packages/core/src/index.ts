export * from "./types.ts";
export * from "./errors.ts";
export { parse, parseHosts, parseDomains, parseAdblock, parseDnsmasq } from "./parse.ts";
export { normalizeHost, normalizeAll, parseAllowRule, compileAllowlist, allowedBy, BUILTIN_ALLOW } from "./normalize.ts";
export { parseAllowText, type AllowText } from "./allowtext.ts";
export { merge, sorted, type MergeResult } from "./merge.ts";
export {
  MARK_START,
  MARK_END,
  renderRegion,
  compose,
  removeRegion,
  findRegions,
  markersPaired,
  extractRegion,
  regionHosts,
  parseRegionHeader,
  type RenderOptions,
} from "./render.ts";
export { fetchSource, fetchErrorMessage, isRemote, type FetchOutcome, type FetchOptions } from "./fetch.ts";
export { BUILTIN_CATALOG, recommendedIds, validateCatalog, type Catalog } from "./catalog.ts";
export { doctor, type Check, type CheckLevel, type ScheduleStatus } from "./doctor.ts";
export { exportList, EXPORT_FORMATS, type ExportFormat } from "./export.ts";
export { withFileLock, BusyError, type LockOptions } from "./lock.ts";
export { configText, defaultConfig, loadConfig, parseConfig, saveConfig, userSourceId, DEFAULT_BUDGET } from "./config.ts";
export { defaultState, loadState, saveState } from "./state.ts";
export { Snapshots, type SnapshotInfo } from "./snapshots.ts";
export { planTidy, type TidyPlan } from "./tidy.ts";
export {
  DNS_LOG_CHANNEL,
  DNS_LOG_SIZE,
  classify,
  dnsStatusText,
  dnsTypeName,
  parseDnsEvents,
  parseLogState,
  parseQueryResults,
  type BlockIndex,
  type DnsEvent,
  type DnsLogEntry,
  type DnsLogState,
  type DnsVerdict,
} from "./dnslog.ts";
export { defaultPaths, pathsIn, type Paths } from "./paths.ts";
export * from "./platform/index.ts";
export {
  Engine,
  type EngineOptions,
  type BuildResult,
  type ApplyResult,
  type CheckResult,
  type Diff,
  type Status,
  type WriteOutcome,
} from "./engine.ts";

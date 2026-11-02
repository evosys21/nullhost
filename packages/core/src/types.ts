// Shared types for the NullHost core. Erasable TypeScript only (runs on Node's type stripping).

export type SourceFormat = "hosts" | "domains" | "adblock" | "dnsmasq";
export type Tier = "recommended" | "stricter" | "optional" | "user";

export interface Source {
  id: string;
  name: string;
  /** http(s) URL, file:// URL, or a local path */
  url: string;
  format: SourceFormat;
  licence: string;
  tier: Tier;
  category?: string;
  verified?: string;
  warning?: string;
}

/** What the user chose. Stored as config.toml. */
export interface Config {
  /** address blocked hosts resolve to */
  ip: string;
  /** warn when the merged selection has more hosts than this */
  budget: number;
  /** ids of enabled sources (catalog or user) */
  enabled: string[];
  /** sources the user added (URL or local file) */
  userSources: Source[];
  /** raw allowlist patterns: `host`, `*.suffix`, `/regex/` */
  allowlist: string[];
}

export type Blocking =
  | { mode: "enabled" }
  | { mode: "disabled" }
  | { mode: "paused"; until: string };

export interface SourceRun {
  from: FetchFrom | "failed";
  at: string;
  bytes: number;
  parsed: number;
  kept: number;
  /** hosts only this source contributes in the current selection */
  unique: number;
  /** change against the previously cached copy, when there was one */
  added?: number;
  removed?: number;
  error?: string;
}

/** Runtime state. Stored as state.json next to the cache. */
export interface State {
  version: 1;
  blocking: Blocking;
  lastUpdate?: { at: string; hosts: number; sources: Record<string, SourceRun> };
  lastApply?: { at: string; hosts: number; lines: number; mode: Blocking["mode"] };
  /** sha256 of the managed region we last wrote, to notice outside edits */
  regionHash?: string;
  /** the last rendered enabled region (cached in region.txt) */
  cachedRegion?: { builtAt: string; hosts: number; lines: number };
}

export interface ParseStats {
  lines: number;
  candidates: number;
  redirects: number;
  skipped: number;
}

export interface ParseResult {
  hosts: string[];
  stats: ParseStats;
}

export interface NormalizeStats {
  input: number;
  kept: number;
  invalid: number;
  ip: number;
  allowlisted: number;
}

export type AllowRule =
  | { kind: "exact"; host: string; pattern: string }
  | { kind: "suffix"; suffix: string; pattern: string }
  | { kind: "regex"; re: RegExp; pattern: string };

export type FetchFrom = "network" | "cache-304" | "cache" | "cache-fallback" | "local";

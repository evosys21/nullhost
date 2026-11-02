/** The hosts file stayed locked (Windows DNS Client parsing it) for the whole retry window. */
export class HostsBusyError extends Error {
  readonly waitedMs: number;
  constructor(path: string, waitedMs: number) {
    super(`hosts file is busy: ${path} stayed locked for ${Math.round(waitedMs / 1000)} s (the DNS Client may still be reading it). Try again in a moment.`);
    this.name = "HostsBusyError";
    this.waitedMs = waitedMs;
  }
}

/** Writing was refused: not elevated, or the file is marked read-only. */
export class HostsAccessError extends Error {
  readonly reason: "elevation" | "read-only";
  constructor(path: string, reason: "elevation" | "read-only") {
    super(
      reason === "read-only"
        ? `hosts file is read-only: ${path}. Clear the read-only attribute (another tool may have set it).`
        : `access denied writing ${path}. Run NullHost as administrator.`,
    );
    this.name = "HostsAccessError";
    this.reason = reason;
  }
}

const recoveryNote = (restored: boolean) =>
  restored
    ? " The previous content was put back."
    : " Putting the previous content back failed too: restore it with `nullhost restore previous` or from Settings.";

/** The file read back after writing is not what was written. `restored` says whether the previous bytes were put back. */
export class HostsVerifyError extends Error {
  readonly restored: boolean;
  constructor(path: string, restored = true) {
    super(`hosts file did not read back as written: ${path}. Something else is rewriting it (Defender, another tool).${recoveryNote(restored)}`);
    this.name = "HostsVerifyError";
    this.restored = restored;
  }
}

/** Writing failed part-way (disk full, I/O error). `restored` says whether the previous bytes were put back. */
export class HostsWriteError extends Error {
  readonly restored: boolean;
  constructor(path: string, cause: unknown, restored: boolean) {
    super(`writing ${path} failed: ${(cause as Error).message}.${recoveryNote(restored)}`, { cause });
    this.name = "HostsWriteError";
    this.restored = restored;
  }
}

/** The NullHost markers in the hosts file do not pair up; any write could swallow the user's own lines. */
export class RegionMarkersError extends Error {
  constructor(path: string) {
    super(`the NullHost markers in ${path} do not pair up (a start marker without its end marker, or the reverse). NullHost does not write the file until they are fixed in the Editor, or a snapshot is restored.`);
    this.name = "RegionMarkersError";
  }
}

/** Enabled sources could not be downloaded and have no cached copy; applying would silently drop their hosts. */
export class SourcesUnavailableError extends Error {
  readonly failed: string[];
  constructor(failed: string[]) {
    super(`not applied: ${failed.join(", ")} could not be downloaded and ${failed.length === 1 ? "has" : "have"} no cached copy, so the blocking already in place stays. Try again later, or turn ${failed.length === 1 ? "that source" : "those sources"} off.`);
    this.name = "SourcesUnavailableError";
    this.failed = failed;
  }
}

/** The selection has more hosts than the platform can load without stalling DNS. */
export class OverCeilingError extends Error {
  readonly hosts: number;
  readonly ceiling: number;
  constructor(hosts: number, ceiling: number) {
    super(`selection has ${hosts.toLocaleString("en-US")} hosts; the hard ceiling on this platform is ${ceiling.toLocaleString("en-US")}. Turn off a large source.`);
    this.name = "OverCeilingError";
    this.hosts = hosts;
    this.ceiling = ceiling;
  }
}

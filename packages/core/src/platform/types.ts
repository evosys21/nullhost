export interface WriteReport {
  /** write attempts, 1 when the file was not locked */
  attempts: number;
  /** time spent waiting for the lock to clear */
  waitedMs: number;
  bytes: number;
}

/** Everything OS-specific. The engine never touches the hosts file or the resolver directly. */
export interface Platform {
  readonly name: "windows" | "linux";
  readonly eol: "\r\n" | "\n";
  /** hosts per line in the managed region; Windows: 9 (measured in M0), Linux: 1 */
  readonly perLine: number;
  /** refuse selections larger than this (M0: 180k compressed reloads in ~8 s on Windows) */
  readonly hardCeiling: number;
  systemHostsPath(): string;
  isElevated(): Promise<boolean>;
  /** Read byte for byte (latin1). A missing file reads as "". */
  readHosts(path: string): Promise<string>;
  /** Write byte for byte, in place, retrying while locked, then verify by reading back. */
  writeHosts(path: string, content: string): Promise<WriteReport>;
  flushDns(): Promise<void>;
  /** read-only checks for the Troubleshoot panel; null = could not tell */
  diagnostics?: {
    dnsClientRunning(): Promise<boolean | null>;
    defenderExcludes(path: string): Promise<boolean | null>;
    /** other hosts-file tools running right now (e.g. HostsMan), by process name */
    otherHostsTools(): Promise<string[] | null>;
  };
}

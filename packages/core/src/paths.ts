import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  configFile: string;
  dataDir: string;
  cacheDir: string;
  snapshotDir: string;
  stateFile: string;
  regionFile: string;
}

/** Everything under one folder: portable mode and tests (`--data-dir`). */
export function pathsIn(dir: string): Paths {
  return {
    configFile: join(dir, "config.toml"),
    dataDir: dir,
    cacheDir: join(dir, "cache"),
    snapshotDir: join(dir, "snapshots"),
    stateFile: join(dir, "state.json"),
    regionFile: join(dir, "region.txt"),
  };
}

/**
 * Per-user default locations.
 * Windows: config in %APPDATA%\NullHost, data in %LOCALAPPDATA%\NullHost.
 * Linux:   ~/.config/nullhost and ~/.local/share/nullhost (later phase).
 */
export function defaultPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Paths {
  if (platform === "win32") {
    const roaming = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    const local = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const data = join(local, "NullHost");
    return { ...pathsIn(data), configFile: join(roaming, "NullHost", "config.toml") };
  }
  const config = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const share = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const data = join(share, "nullhost");
  return { ...pathsIn(data), configFile: join(config, "nullhost", "config.toml") };
}

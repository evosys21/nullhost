import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { BUILTIN_CATALOG, recommendedIds, type Catalog } from "./catalog.ts";
import type { Config, Source, SourceFormat } from "./types.ts";

export const DEFAULT_BUDGET = 150_000;
/** The only addresses a blocked host may point at. */
export const BLOCK_IPS = ["0.0.0.0", "127.0.0.1"];

export function defaultConfig(catalog: Catalog = BUILTIN_CATALOG): Config {
  return { ip: "0.0.0.0", budget: DEFAULT_BUDGET, enabled: recommendedIds(catalog), userSources: [], allowlist: [] };
}

const FORMATS: SourceFormat[] = ["hosts", "domains", "adblock", "dnsmasq"];

/** Drop the ids the catalog retired. Nothing takes their place: the catalog never enables a source by itself. */
function dropRetired(ids: string[], catalog: Catalog): string[] {
  const retired = catalog.retired ?? {};
  return ids.filter((id) => !Object.hasOwn(retired, id));
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new Error(`config: ${field} must be a string`);
  return v;
}

function strList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`config: ${field} must be a list of strings`);
  return v as string[];
}

/** Read config.toml; a missing file gives the defaults. Invalid content throws with the field name. */
export async function loadConfig(file: string, catalog: Catalog = BUILTIN_CATALOG): Promise<Config> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig(catalog);
    throw err;
  }
  return parseConfig(text, catalog);
}

/** config.toml content -> Config. Invalid content throws with the field name. */
export function parseConfig(text: string, catalog: Catalog = BUILTIN_CATALOG): Config {
  const raw = parse(text) as Record<string, unknown>;
  const d = defaultConfig(catalog);
  const userSources: Source[] = [];
  const list = raw.sources ?? [];
  if (!Array.isArray(list)) throw new Error("config: [[sources]] must be a table array");
  for (const [i, s] of (list as Array<Record<string, unknown>>).entries()) {
    const format = (s.format ?? "hosts") as SourceFormat;
    if (!FORMATS.includes(format)) throw new Error(`config: sources[${i}].format must be one of ${FORMATS.join(", ")}`);
    userSources.push({
      id: str(s.id, `sources[${i}].id`),
      name: str(s.name ?? s.id, `sources[${i}].name`),
      url: str(s.url, `sources[${i}].url`),
      format,
      licence: typeof s.licence === "string" ? s.licence : "",
      tier: "user",
    });
  }
  const budget = raw.budget ?? d.budget;
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0) throw new Error("config: budget must be a positive integer");
  // Checked here, not only where the app sets it: the file is the user's to edit, and
  // the elevated daily task writes this address in front of every blocked host.
  const ip = raw.ip === undefined ? d.ip : str(raw.ip, "ip");
  if (!BLOCK_IPS.includes(ip)) throw new Error(`config: ip, the block address, must be ${BLOCK_IPS.join(" or ")}`);
  return {
    ip,
    budget,
    enabled: raw.enabled === undefined ? d.enabled : dropRetired(strList(raw.enabled, "enabled"), catalog),
    userSources,
    allowlist: strList(raw.allowlist, "allowlist"),
  };
}

/** Config -> config.toml content. */
export function configText(c: Config): string {
  const doc: Record<string, unknown> = {
    ip: c.ip,
    budget: c.budget,
    enabled: c.enabled,
    allowlist: c.allowlist,
  };
  if (c.userSources.length) {
    doc.sources = c.userSources.map((s) => ({ id: s.id, name: s.name, url: s.url, format: s.format, licence: s.licence }));
  }
  return "# NullHost configuration. The app and the CLI both read and write this file.\n" + stringify(doc) + "\n";
}

export async function saveConfig(file: string, c: Config): Promise<void> {
  const body = configText(c);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, file);
}

/** A stable id for a user source from its name. */
export function userSourceId(name: string, taken: Iterable<string>): string {
  const base = "user-" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "source");
  const used = new Set(taken);
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}

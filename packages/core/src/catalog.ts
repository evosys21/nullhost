import catalogJson from "../../../catalog/sources.json" with { type: "json" };
import type { Source, SourceFormat, Tier } from "./types.ts";

export interface Catalog {
  version: string;
  sources: Source[];
  /** ids dropped from the catalog, with why: a saved config stops using them; nothing replaces them on its own */
  retired?: Record<string, string>;
  /**
   * The recommended sets earlier releases shipped. A saved `enabled` whose catalog ids are
   * exactly one of them was never chosen by the user, only saved along with another setting,
   * so it moves to today's recommended set (config.ts).
   *
   * This runs on every load, not once. A set is only safe here if nobody can pick it again on
   * purpose: the one listed includes `adaway`, which is retired and cannot be turned back on.
   * A former default made only of live sources would also catch a user who chose it, every time.
   */
  formerDefaults?: string[][];
}

const FORMATS: SourceFormat[] = ["hosts", "domains", "adblock", "dnsmasq"];
const TIERS: Tier[] = ["recommended", "stricter", "optional"];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/;

function str(v: unknown, what: string, max: number, required = true): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > max || /[\u0000-\u001f]/.test(v)) throw new Error(`catalog: ${what} must be a string of 1-${max} printable characters`);
  return v;
}

/**
 * Validate a catalog strictly: it decides which URLs NullHost downloads, so only
 * well-formed https sources with known formats and tiers are accepted, and
 * nothing in it can enable a source by itself. `formerDefaults` comes closest: it moves a
 * saved set that is exactly an old default to the current one, as if nothing had been saved.
 */
export function validateCatalog(raw: unknown): Catalog {
  if (!raw || typeof raw !== "object") throw new Error("catalog: not a JSON object");
  const o = raw as Record<string, unknown>;
  const version = str(o.version, "version", 20)!;
  if (!VERSION.test(version)) throw new Error("catalog: version must look like 2026-10-26");
  if (!Array.isArray(o.sources) || o.sources.length === 0 || o.sources.length > 500) throw new Error("catalog: sources must be a list of 1-500 entries");
  const seen = new Set<string>();
  const sources: Source[] = o.sources.map((s: unknown, i: number) => {
    if (!s || typeof s !== "object") throw new Error(`catalog: sources[${i}] is not an object`);
    const e = s as Record<string, unknown>;
    const id = str(e.id, `sources[${i}].id`, 40)!;
    if (!ID.test(id) || id.startsWith("user-")) throw new Error(`catalog: sources[${i}].id "${id}" is not a valid catalog id`);
    if (seen.has(id)) throw new Error(`catalog: duplicate id ${id}`);
    seen.add(id);
    const url = str(e.url, `sources[${i}].url`, 500)!;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`catalog: sources[${i}].url is not a URL`);
    }
    if (parsed.protocol !== "https:") throw new Error(`catalog: sources[${i}].url must be https`);
    const format = e.format as SourceFormat;
    if (!FORMATS.includes(format)) throw new Error(`catalog: sources[${i}].format must be one of ${FORMATS.join(", ")}`);
    const tier = e.tier as Tier;
    if (!TIERS.includes(tier)) throw new Error(`catalog: sources[${i}].tier must be one of ${TIERS.join(", ")}`);
    return {
      id,
      name: str(e.name, `sources[${i}].name`, 100)!,
      url,
      format,
      licence: str(e.licence, `sources[${i}].licence`, 60)!,
      tier,
      category: str(e.category, `sources[${i}].category`, 60, false),
      verified: str(e.verified, `sources[${i}].verified`, 20, false),
      warning: str(e.warning, `sources[${i}].warning`, 300, false),
    };
  });
  let retired: Record<string, string> | undefined;
  if (o.retired !== undefined) {
    if (!o.retired || typeof o.retired !== "object" || Array.isArray(o.retired)) throw new Error("catalog: retired must be an object of id: reason");
    const entries = Object.entries(o.retired as Record<string, unknown>);
    if (entries.length > 500) throw new Error("catalog: retired holds more than 500 ids");
    retired = {};
    for (const [id, why] of entries) {
      if (!ID.test(id) || id.startsWith("user-")) throw new Error(`catalog: retired id "${id}" is not a valid catalog id`);
      if (seen.has(id)) throw new Error(`catalog: ${id} is both a source and retired`);
      retired[id] = str(why, `retired.${id}`, 200)!;
    }
  }
  let formerDefaults: string[][] | undefined;
  if (o.formerDefaults !== undefined) {
    if (!Array.isArray(o.formerDefaults) || o.formerDefaults.length > 50) throw new Error("catalog: formerDefaults must be a list of at most 50 id lists");
    formerDefaults = o.formerDefaults.map((set: unknown, i: number) => {
      if (!Array.isArray(set) || set.length === 0 || set.length > 500) throw new Error(`catalog: formerDefaults[${i}] must be a list of 1-500 ids`);
      const ids = set.map((id: unknown) => str(id, `formerDefaults[${i}] id`, 40)!);
      for (const id of ids) {
        if (!seen.has(id) && !(retired && Object.hasOwn(retired, id))) throw new Error(`catalog: formerDefaults[${i}] names ${id}, which is neither a source nor retired`);
      }
      if (new Set(ids).size !== ids.length) throw new Error(`catalog: formerDefaults[${i}] repeats an id`);
      return ids;
    });
  }
  return { version, sources, ...(retired ? { retired } : {}), ...(formerDefaults ? { formerDefaults } : {}) };
}

/**
 * The catalog shipped with this build (`catalog/sources.json` at the repo root).
 * It is the only one: the lists on offer change with a release, never by download.
 */
export const BUILTIN_CATALOG: Catalog = validateCatalog(catalogJson);

export function recommendedIds(catalog: Catalog = BUILTIN_CATALOG): string[] {
  return catalog.sources.filter((s) => s.tier === "recommended").map((s) => s.id);
}

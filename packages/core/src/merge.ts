export interface MergeResult {
  /** host -> ids of the sources that list it, in source order */
  hosts: Map<string, string[]>;
  perSource: Record<string, { parsed: number; unique: number }>;
}

/**
 * Merge normalised host lists from several sources. Keeps, per host, the ids of
 * every source that lists it (for `check <host>` and "why is this blocked?").
 * `unique` counts hosts a source adds that no earlier source in the order had.
 */
export function merge(inputs: Array<{ id: string; hosts: string[] }>): MergeResult {
  const hosts = new Map<string, string[]>();
  const perSource: MergeResult["perSource"] = {};
  for (const { id, hosts: list } of inputs) {
    let unique = 0;
    for (const h of list) {
      const owners = hosts.get(h);
      if (owners) {
        if (owners[owners.length - 1] !== id) owners.push(id);
      } else {
        hosts.set(h, [id]);
        unique++;
      }
    }
    perSource[id] = { parsed: list.length, unique };
  }
  return { hosts, perSource };
}

/** Deterministic file order: by reversed labels, so a domain's hosts sit together. */
export function sorted(hosts: Iterable<string>): string[] {
  const keyed = Array.from(hosts, (h) => [h.split(".").reverse().join("."), h] as const);
  keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return keyed.map((k) => k[1]);
}

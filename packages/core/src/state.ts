import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { State } from "./types.ts";

export function defaultState(): State {
  return { version: 1, blocking: { mode: "enabled" } };
}

export async function loadState(file: string): Promise<State> {
  try {
    const s = JSON.parse(await readFile(file, "utf8")) as State;
    return { ...defaultState(), ...s };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw new Error(`state file ${file} is unreadable: ${(err as Error).message}`);
  }
}

export async function saveState(file: string, s: State): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

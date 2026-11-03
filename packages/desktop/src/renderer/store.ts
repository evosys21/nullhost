import { reactive } from "vue";
import type { AppInfo, AppUpdate, ApplySummary, DesktopSettings, NullhostApi, SourceView, Status } from "../shared/api";
import { createMockApi } from "./mock";

/** The real API from the preload, or an in-memory mock when the UI runs in a plain browser. */
export const api: NullhostApi = window.nullhost ?? createMockApi();
export const isMock = !window.nullhost;

export type Screen = "dashboard" | "sources" | "allowlist" | "editor" | "settings";

export const store = reactive({
  screen: "dashboard" as Screen,
  info: null as AppInfo | null,
  status: null as Status | null,
  sources: [] as SourceView[],
  allowlist: [] as string[],
  settings: null as DesktopSettings | null,
  /** a newer NullHost on GitHub, from the last check */
  appUpdate: null as AppUpdate | null,
  /** what is running right now, shown bottom right */
  busy: "",
  /** the step of `busy` running right now, from the main process ("Downloading AdAway (2 of 3)") */
  step: "",
  error: "",
  notice: "",
  lastResult: null as ApplySummary | null,
});

/** "Error invoking remote method 'nullhost:x': Error: message" -> "message" */
export function cleanError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export async function refresh(): Promise<void> {
  try {
    const [info, status, sources, allowlist, settings, appUpdate] = await Promise.all([
      api.info(),
      api.status(),
      api.sources(),
      api.allowlist(),
      api.settings(),
      api.appUpdate(),
    ]);
    Object.assign(store, { info, status, sources, allowlist, settings, appUpdate });
  } catch (err) {
    store.error = cleanError(err);
  }
}

/** Run an action with the busy indicator; errors land in store.error, success can set a notice. */
export async function act<T>(label: string, fn: () => Promise<T>, notice?: (r: T) => string): Promise<T | undefined> {
  store.busy = label;
  store.step = "";
  store.error = "";
  store.notice = "";
  try {
    const r = await fn();
    if (notice) store.notice = notice(r);
    await refresh();
    return r;
  } catch (err) {
    store.error = cleanError(err);
    return undefined;
  } finally {
    store.busy = "";
    store.step = "";
  }
}

api.onChanged(() => void refresh());
api.onProgress((step) => {
  if (store.busy) store.step = step;
});

export const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");

export function ago(iso: string | undefined): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

export function untilLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

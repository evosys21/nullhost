import { contextBridge, ipcRenderer } from "electron";
import { API_METHODS, CHANGED_EVENT, PROGRESS_EVENT, channel } from "../shared/api";

// Exposes exactly the methods in API_METHODS as window.nullhost; nothing else of
// Node or Electron reaches the page (contextIsolation + sandbox).
const api: Record<string, unknown> = {};
for (const m of API_METHODS) {
  api[m] = (...args: unknown[]) => ipcRenderer.invoke(channel(m), ...args);
}
api.onChanged = (cb: () => void) => {
  const listener = () => cb();
  ipcRenderer.on(CHANGED_EVENT, listener);
  return () => ipcRenderer.removeListener(CHANGED_EVENT, listener);
};

api.onProgress = (cb: (step: string) => void) => {
  const listener = (_e: unknown, step: unknown) => cb(String(step));
  ipcRenderer.on(PROGRESS_EVENT, listener);
  return () => ipcRenderer.removeListener(PROGRESS_EVENT, listener);
};

contextBridge.exposeInMainWorld("nullhost", api);

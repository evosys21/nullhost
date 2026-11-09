import { onBeforeUnmount, watch, type Ref } from "vue";

// Closing the window to the tray frees it, so unsaved edits would be lost with it.
// While any view holds some, the page refuses to unload; the main process then asks
// whether to discard them (webContents "will-prevent-unload").
const holders = new Set<string>();

window.addEventListener("beforeunload", (e) => {
  if (holders.size) e.preventDefault();
});

/** Hold the window open while `dirty` is true, until the calling component unmounts. */
export function holdWhileDirty(name: string, dirty: Ref<boolean>): void {
  watch(dirty, (d) => (d ? holders.add(name) : holders.delete(name)), { immediate: true });
  onBeforeUnmount(() => holders.delete(name));
}

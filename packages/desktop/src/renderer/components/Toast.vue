<script setup lang="ts">
import { onUnmounted, watch } from "vue";
import Icon from "./Icon.vue";
import { dismissToast, store } from "../store";

// store.toasts, stacked bottom right (newest at the bottom). Every toast stays the same time,
// so they go in the order they came. While the pointer or the keyboard focus is on the stack
// the clocks stop; letting go resumes each with the time it had left, so the order holds.
// Errors stay banners.
const SHOWN_MS = 2_000;

/** per toast: the time it has left, and its timer while running */
const clocks = new Map<number, { left: number; started: number; timer?: number }>();
let held = false;

function run(id: number) {
  const c = clocks.get(id);
  if (!c) return;
  c.started = performance.now();
  c.timer = window.setTimeout(() => close(id), c.left);
}
function pause(id: number) {
  const c = clocks.get(id);
  if (!c || c.timer === undefined) return;
  window.clearTimeout(c.timer);
  c.timer = undefined;
  c.left = Math.max(0, c.left - (performance.now() - c.started));
}
function close(id: number) {
  window.clearTimeout(clocks.get(id)?.timer);
  clocks.delete(id);
  dismissToast(id);
}
// a new toast gets its clock; one that went (replaced, pushed out, closed) drops it
watch(
  () => store.toasts.map((t) => t.id),
  (ids) => {
    for (const id of [...clocks.keys()]) if (!ids.includes(id)) close(id);
    for (const id of ids) {
      if (clocks.has(id)) continue;
      clocks.set(id, { left: SHOWN_MS, started: 0 });
      if (!held) run(id);
    }
  },
  { immediate: true },
);
function hold(on: boolean) {
  held = on;
  for (const id of clocks.keys()) on ? pause(id) : run(id);
}
onUnmounted(() => clocks.forEach((c) => window.clearTimeout(c.timer)));
</script>

<template>
  <TransitionGroup tag="div" name="toast" class="toast-stack" aria-live="polite" @mouseenter="hold(true)" @mouseleave="hold(false)" @focusin="hold(true)" @focusout="hold(false)">
    <div v-for="t in store.toasts" :key="t.id" class="toast" role="status">
      <Icon name="check" />
      <span class="toast-text">{{ t.text }}</span>
      <button type="button" class="toast-x" aria-label="Dismiss" @click="close(t.id)"><Icon name="x" /></button>
    </div>
  </TransitionGroup>
</template>

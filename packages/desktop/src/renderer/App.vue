<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "./components/Icon.vue";
import Logo from "./components/Logo.vue";
import Toast from "./components/Toast.vue";
import { isMock, store, untilLabel, type Screen } from "./store";
import Allowlist from "./views/Allowlist.vue";
import Dashboard from "./views/Dashboard.vue";
import DnsLog from "./views/DnsLog.vue";
import Editor from "./views/Editor.vue";
import Settings from "./views/Settings.vue";
import Sources from "./views/Sources.vue";

const NAV: Array<{ id: Screen; label: string; icon: "gauge" | "list" | "allow" | "edit" | "activity" | "sliders" }> = [
  { id: "dashboard", label: "Dashboard", icon: "gauge" },
  { id: "sources", label: "Sources", icon: "list" },
  { id: "allowlist", label: "Allowlist", icon: "allow" },
  { id: "editor", label: "Editor", icon: "edit" },
  { id: "dnslog", label: "DNS log", icon: "activity" },
  { id: "settings", label: "Settings", icon: "sliders" },
];
const VIEWS = { dashboard: Dashboard, sources: Sources, allowlist: Allowlist, editor: Editor, dnslog: DnsLog, settings: Settings };

// The busy indicator shows only for actions that take a while: a quick one would flash it up
// and replace it at once with its result toast. (store.busy itself, which disables buttons, is immediate.)
const BUSY_SHOW_AFTER_MS = 600;
const showBusy = ref(false);
let busyTimer: number | undefined;
watch(
  () => store.busy,
  (busy) => {
    window.clearTimeout(busyTimer);
    if (!busy) showBusy.value = false;
    else if (!showBusy.value) busyTimer = window.setTimeout(() => (showBusy.value = true), BUSY_SHOW_AFTER_MS);
  },
);

window.__nullhostNav = (s: string) => {
  if (s in VIEWS) store.screen = s as Screen;
};

const pill = computed(() => {
  const b = store.status?.blocking;
  if (!b) return { cls: "", text: "Loading…", style: {} };
  if (b.mode === "paused") return { text: `Paused until ${untilLabel(b.until)}`, style: { background: "var(--pause-soft)", color: "var(--pause)" } };
  if (b.mode === "disabled") return { text: "Blocking disabled", style: { background: "var(--warn-soft)", color: "var(--warn)" } };
  return { text: "Blocking enabled", style: { background: "var(--ok-soft)", color: "var(--ok)" } };
});

const modeLabel = computed(() => {
  const i = store.info;
  if (!i) return "";
  if (isMock) return "preview · mock data";
  if (!i.systemFile) return i.writer === "helper" ? "copy, via the helper" : "working on a copy";
  if (i.writer === "admin") return "running as admin";
  if (i.writer === "helper") return i.helperRunning ? "admin helper running" : "asks for admin on change";
  return "read-only";
});
</script>

<template>
  <div class="shell">
    <nav class="sidebar" aria-label="Main">
      <div class="brand">
        <Logo :mode="store.status?.blocking.mode" style="width: 28px; height: 28px; flex: 0 0 28px" />
        <div>
          <div class="brand-name">NullHost</div>
          <div class="brand-sub">v{{ store.info?.version ?? "" }}{{ store.info?.portable ? " portable" : "" }} · {{ modeLabel }}</div>
        </div>
      </div>
      <button
        v-for="n in NAV"
        :key="n.id"
        type="button"
        class="nav"
        :class="{ active: store.screen === n.id }"
        :aria-current="store.screen === n.id ? 'page' : undefined"
        @click="store.screen = n.id"
      >
        <Icon :name="n.icon" />{{ n.label }}
      </button>
      <div style="flex: 1"></div>
      <div class="pill" :style="pill.style"><span class="dot"></span>{{ pill.text }}</div>
    </nav>

    <main class="main">
      <component :is="VIEWS[store.screen]" />
    </main>

    <!-- bottom right, stacked: what is running now, and the last notice -->
    <div class="toasts">
      <Toast />
      <div v-if="store.busy && showBusy" class="busy" role="status" aria-live="polite">
        <span class="spinner"></span>
        <span class="busy-text"><span>{{ store.busy }}…</span><span v-if="store.step" class="busy-step">{{ store.step }}</span></span>
      </div>
    </div>
  </div>
</template>

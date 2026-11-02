<script setup lang="ts">
import { computed, ref } from "vue";
import type { SourceView } from "../../shared/api";
import Banners from "../components/Banners.vue";
import Icon from "../components/Icon.vue";
import Toggle from "../components/Toggle.vue";
import { act, ago, api, fmt, store } from "../store";

const TIERS: Array<{ tier: SourceView["tier"]; label: string }> = [
  { tier: "recommended", label: "Recommended · enabled by default" },
  { tier: "stricter", label: "Stricter · off by default, watch the budget" },
  { tier: "optional", label: "Optional categories" },
  { tier: "user", label: "My sources" },
];
const groups = computed(() => TIERS.map((t) => ({ ...t, items: store.sources.filter((s) => s.tier === t.tier) })).filter((g) => g.items.length));
const enabled = computed(() => store.sources.filter((s) => s.enabled).length);
const canWrite = computed(() => store.info?.canWrite ?? false);
const dirty = ref(false);

async function toggle(s: SourceView, on: boolean) {
  await act(on ? "Enabling source" : "Disabling source", () => api.setSource(s.id, on));
  dirty.value = true;
}
async function checkUpdates() {
  const r = await act("Checking for updates", () => api.update(true), (r) => `Checked: ${fmt(r.hosts)} hosts after merge, ${fmt(r.diff.added)} new and ${fmt(r.diff.removed)} gone since the hosts file was written. Nothing written yet.`);
  if (r) store.lastResult = r;
}
async function applyNow() {
  const r = await act("Applying", () => api.update(), (r) => (r.pending ? "Saved; blocking is off, so the hosts file was not changed." : r.written ? `Applied: ${fmt(r.hosts)} hosts.` : "The hosts file already matches."));
  if (r) { store.lastResult = r; dirty.value = false; }
}

const adding = ref(false);
const url = ref("");
const name = ref("");
const format = ref<"hosts" | "domains" | "adblock" | "dnsmasq">("hosts");
async function add() {
  if (!url.value.trim()) return;
  const r = await act("Adding source", () => api.addSource(url.value, name.value, format.value), (s) => `Added ${s.name}. Apply downloads it and writes the hosts file.`);
  if (r) { url.value = ""; name.value = ""; adding.value = false; dirty.value = true; }
}
async function remove(s: SourceView) {
  if (!confirm(`Remove ${s.name}?`)) return;
  await act("Removing source", () => api.removeSource(s.id));
  dirty.value = true;
}
function change(s: SourceView): string {
  const r = s.lastRun;
  if (!r) return "";
  if (r.added === undefined) return r.from === "network" || r.from === "local" ? "new" : "unchanged";
  return r.added + (r.removed ?? 0) ? `+${fmt(r.added)} −${fmt(r.removed)}` : "unchanged";
}
</script>

<template>
  <header class="header">
    <div class="title">
      <h1>Sources</h1>
      <div class="sub">{{ enabled }} of {{ store.sources.length }} enabled · {{ fmt(store.status?.lastUpdate?.hosts) }} unique hosts at the last update · budget {{ fmt(store.settings?.budget) }}</div>
    </div>
    <button class="btn" type="button" :disabled="!!store.busy" @click="checkUpdates"><Icon name="refresh" />Check for updates</button>
    <button class="btn" type="button" @click="adding = !adding"><Icon name="plus" />Add source</button>
    <button class="btn primary" type="button" :disabled="!canWrite || !!store.busy" @click="applyNow">Apply</button>
  </header>

  <div class="content">
    <Banners />
    <div v-if="dirty" class="banner info"><Icon name="info" /><span>Your changes are saved. Apply downloads any new list and writes the hosts file.</span></div>

    <form v-if="adding" class="card" style="display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end" @submit.prevent="add">
      <label style="flex: 3 1 360px"><div class="k" style="margin-bottom: 6px">URL or local file path</div>
        <input v-model="url" class="input mono" style="width: 100%" placeholder="https://… or D:\lists\my-list.txt" required spellcheck="false" /></label>
      <label style="flex: 1 1 180px"><div class="k" style="margin-bottom: 6px">Name</div>
        <input v-model="name" class="input" style="width: 100%" placeholder="My list" /></label>
      <label style="flex: 0 0 150px"><div class="k" style="margin-bottom: 6px">Format</div>
        <select v-model="format" class="input" style="width: 100%"><option value="hosts">hosts</option><option value="domains">domains</option><option value="adblock">adblock</option><option value="dnsmasq">dnsmasq</option></select></label>
      <button class="btn primary" type="submit">Add</button>
      <button class="btn" type="button" @click="adding = false">Cancel</button>
    </form>

    <div class="card flush scroll-x">
      <table>
        <thead><tr><th style="width: 64px">On</th><th>Source</th><th>Category</th><th class="num">Hosts</th><th>Fetched</th><th>Changed</th><th style="width: 44px"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          <template v-for="g in groups" :key="g.tier">
            <tr class="tier"><td colspan="7">{{ g.label }}</td></tr>
            <tr v-for="s in g.items" :key="s.id">
              <td><Toggle :model-value="s.enabled" :label="`${s.name}, ${s.enabled ? 'on' : 'off'}`" @update:model-value="(on: boolean) => toggle(s, on)" /></td>
              <td :title="`Licence: ${s.licence || 'unknown'}`">
                <div style="font-weight: 600">{{ s.name }}</div>
                <div class="mono muted" style="font-size: 12px; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="s.url">{{ s.url }}</div>
              </td>
              <td><span class="tag" :class="{ warn: s.warning }" :title="s.warning">{{ s.warning ? `${s.category ?? ""} · see note` : s.category ?? s.format }}</span></td>
              <td class="num">{{ s.lastRun && s.lastRun.from !== "failed" ? fmt(s.lastRun.kept) : "—" }}</td>
              <td style="white-space: nowrap">
                <span v-if="!s.lastRun" class="muted">not fetched</span>
                <span v-else-if="s.lastRun.from === 'failed'" class="warnc" :title="s.lastRun.error">failed</span>
                <span v-else :title="s.lastRun.error">{{ ago(s.lastRun.at) }}<span v-if="s.lastRun.from === 'cache-fallback'" class="warnc"> (cached)</span></span>
              </td>
              <td style="white-space: nowrap"><span v-if="change(s) === 'unchanged' || change(s) === 'new'" class="muted">{{ change(s) }}</span><span v-else class="chg">{{ change(s) }}</span></td>
              <td><button v-if="s.tier === 'user'" class="btn sm" type="button" :aria-label="`Remove ${s.name}`" @click="remove(s)"><Icon name="x" /></button></td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <div class="hint">Hover a source for its licence; every enabled list is credited in the hosts file header. A list over the Windows ceiling of {{ fmt(store.settings?.hardCeiling) }} hosts is refused when applying.</div>
  </div>
</template>

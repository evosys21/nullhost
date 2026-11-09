<script setup lang="ts">
import { parseAllowText } from "@nullhost/core/allowtext";
import { computed, ref, watch } from "vue";
import type { CheckResult } from "../../shared/api";
import Banners from "../components/Banners.vue";
import Icon from "../components/Icon.vue";
import { act, api, store } from "../store";
import { holdWhileDirty } from "../unsaved";

const canWrite = computed(() => store.info?.canWrite ?? false);
const dirty = ref(false);
const test = ref("");
const result = ref<CheckResult | null>(null);

// the editor: whatever is pasted is cleaned up to one pattern per line on save
const saved = computed(() => store.allowlist.join("\n"));
const text = ref(saved.value);
const edited = computed(() => text.value.trim() !== saved.value);
holdWhileDirty("allowlist", edited);
// follow changes made elsewhere (the Dashboard's "Allow this host") unless the user is editing
watch(saved, (now, before) => {
  if (text.value.trim() === before) text.value = now;
});
const parsed = computed(() => parseAllowText(text.value));
const counts = computed(() => {
  const p = parsed.value.patterns;
  const regex = p.filter((x) => x.startsWith("/")).length;
  const suffix = p.filter((x) => x.startsWith("*.")).length;
  return { total: p.length, exact: p.length - regex - suffix, suffix, regex };
});
/** skipped by the last save, shown until the next edit is saved */
const skipped = ref<string[]>([]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function save() {
  if (!edited.value) return;
  const r = await act("Saving", () => api.allowSave(text.value), (r) => `Saved ${plural(r.patterns.length, "pattern")}.`);
  if (!r) return;
  text.value = r.patterns.join("\n");
  skipped.value = r.skipped;
  dirty.value = true;
}
function revert() {
  text.value = saved.value;
  skipped.value = [];
}
async function allowHost(host: string) {
  text.value = `${text.value.trimEnd()}\n${host}`.trimStart();
  await save();
}
async function applyNow() {
  await act("Applying", () => api.apply(), (r) => (r.written ? "Allowlist applied to the hosts file." : "The hosts file already matches."));
  dirty.value = false;
  if (result.value) await runTest();
}
async function runTest() {
  if (!test.value.trim()) return;
  result.value = (await act("Checking", () => api.check(test.value))) ?? null;
}
</script>

<template>
  <header class="header">
    <div class="title">
      <h1>Allowlist</h1>
      <div class="sub">The allowlist wins over every blocklist. Your own entries outside NullHost's region are never touched; edit those in the Editor.</div>
    </div>
    <button class="btn primary" type="button" :disabled="!canWrite || !!store.busy || edited" @click="applyNow">Apply</button>
  </header>

  <div class="content">
    <Banners />
    <div v-if="dirty && !edited" class="banner info"><Icon name="info" /><span>The allowlist is saved. Apply writes it to the hosts file.</span></div>
    <div v-if="skipped.length" class="banner warn">
      <Icon name="info" />
      <span>Skipped {{ plural(skipped.length, "entry", "entries") }} that are not a host name, <span class="mono">*.domain</span> or <span class="mono">/regex/</span>:
        <span class="mono">{{ skipped.slice(0, 12).join(", ") }}</span><template v-if="skipped.length > 12"> and {{ skipped.length - 12 }} more</template>.</span>
    </div>

    <section class="card" style="display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end">
      <form style="flex: 1 1 380px; display: flex; gap: 10px; align-items: flex-end" @submit.prevent="runTest">
        <label style="flex: 1"><div class="k" style="margin-bottom: 6px">Test a host against the enabled sources</div>
          <input v-model="test" class="input mono" style="width: 100%" placeholder="cdn.segment.com" spellcheck="false" autocomplete="off" /></label>
        <button class="btn" type="submit">Test</button>
      </form>
      <div v-if="result" class="banner" :class="result.wouldBlock ? 'warn' : 'ok'" style="flex: 1 1 380px">
        <span>
          <strong>{{ result.wouldBlock ? "Blocked" : result.allowedBy ? "Allowed" : "Not blocked" }}.</strong>
          <template v-if="result.listedBy.length"> Listed by {{ result.listedBy.join(" and ") }}.</template>
          <template v-else> Not in any enabled source.</template>
          <template v-if="result.allowedBy"> Overridden by <span class="mono">{{ result.allowedBy }}</span>.</template>
        </span>
        <button v-if="result.wouldBlock" class="btn sm" type="button" @click="allowHost(result.host)">Allow it</button>
      </div>
    </section>

    <section class="card">
      <div style="margin-bottom: 12px">
        <h2>Allowlist</h2>
        <div class="hint">
          Paste anything: one per line, separated by commas or spaces, hosts-file lines, URLs or a HostsMan exclusion list. Saving cleans it up.
          Use an exact host, <span class="mono">*.domain</span> for a domain and all its subdomains, or <span class="mono">/regex/</span>.
        </div>
      </div>
      <label for="allow-text" class="sr-only">Allowlist patterns</label>
      <textarea
        id="allow-text"
        v-model="text"
        class="input mono"
        style="display: block; width: 100%; min-height: 260px; padding: 10px 12px; line-height: 1.55; resize: vertical"
        placeholder="*.example.com&#10;cdn.segment.com&#10;/^s3-.*\.amazonaws\.com$/"
        spellcheck="false"
        autocomplete="off"
        @keydown.ctrl.s.prevent="save"
      ></textarea>
      <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 12px">
        <div class="hint" style="flex: 1 1 320px; margin: 0">
          <template v-if="counts.total">
            {{ plural(counts.total, "pattern") }}:
            {{ [counts.exact && plural(counts.exact, "exact host"), counts.suffix && plural(counts.suffix, "domain"), counts.regex && plural(counts.regex, "regular expression")].filter(Boolean).join(", ") }}.
          </template>
          <template v-else>Nothing allowed yet.</template>
          <template v-if="parsed.skipped.length"> {{ plural(parsed.skipped.length, "entry", "entries") }} will be skipped.</template>
          Always allowed: <span class="mono">localhost, *.localhost, ip6-*, broadcasthost</span>.
        </div>
        <button v-if="edited" class="btn" type="button" :disabled="!!store.busy" @click="revert">Revert</button>
        <button class="btn primary" type="button" :disabled="!edited || !!store.busy" aria-keyshortcuts="Control+S" @click="save">Save</button>
      </div>
    </section>
  </div>
</template>

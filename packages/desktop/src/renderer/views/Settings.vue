<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { Check, ImportSummary, ScheduleStatus, Theme } from "../../shared/api";
import Banners from "../components/Banners.vue";
import Icon from "../components/Icon.vue";
import Toggle from "../components/Toggle.vue";
import { act, api, cleanError, fmt, store } from "../store";

const set = computed(() => store.settings);
const info = computed(() => store.info);
const st = computed(() => store.status);
const canWrite = computed(() => info.value?.canWrite ?? false);

const hotkey = ref("");
const budget = ref(0);
watch(set, (s) => { if (s) { hotkey.value = s.hotkey; budget.value = s.budget; } }, { immediate: true });

const saveSetting = (label: string, patch: Parameters<typeof api.setSettings>[0], notice: string) =>
  act(label, () => api.setSettings(patch), () => notice);

const schedule = ref<ScheduleStatus | null>(null);
const scheduleAt = ref("07:30");
const checks = ref<Check[] | null>(null);

async function loadSchedule() {
  try {
    schedule.value = await api.schedule();
    if (schedule.value.at) scheduleAt.value = schedule.value.at;
  } catch (err) {
    store.error = cleanError(err);
  }
}
async function setSchedule(on: boolean) {
  const r = await act(on ? "Switching on automatic updates" : "Switching off automatic updates", () => api.setSchedule(on ? scheduleAt.value : null),
    (s) => (s.installed ? `Automatic updates on: daily at ${s.at}.` : "Automatic updates are off."));
  if (r) schedule.value = r;
}
async function runChecks() {
  checks.value = (await act("Running checks", () => api.doctor())) ?? null;
}
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never");
const LEVEL = { ok: { cls: "okc", text: "OK" }, info: { cls: "muted", text: "info" }, warn: { cls: "warnc", text: "check" }, error: { cls: "warnc", text: "problem" } } as const;

onMounted(async () => {
  void loadSchedule();
});

async function copyReport() {
  const report = { info: info.value, status: st.value, settings: set.value, schedule: schedule.value, checks: checks.value };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  store.notice = "Report copied to the clipboard.";
}
async function restore(which: "previous" | "original") {
  const msg = which === "original"
    ? "Restore the hosts file as it was before NullHost first changed it? A snapshot of the current file is taken first."
    : "Restore the hosts file as it was before the last change? A snapshot of the current file is taken first.";
  if (!confirm(msg)) return;
  await act("Restoring", () => api.restore(which), () => `Restored the ${which} hosts file.`);
}
async function exportSettings() {
  await act("Exporting settings", () => api.exportSettings(), (file) => (file ? `Settings exported to ${file}. Import that file in NullHost on the other PC.` : ""));
}
async function importSettings() {
  const imported = (r: ImportSummary) =>
    `Imported ${r.file}: ${r.enabled} lists on, ${r.userSources} of your own, ${r.allowlist} allowlist patterns. The previous settings are kept as config.toml.before-import.`;
  const r = await act("Importing settings", () => api.importSettings(), (r) => (r ? imported(r) : ""));
  if (!r || !canWrite.value) return;
  if (!confirm("Settings imported. Download the lists and update the hosts file now?")) return;
  await act("Updating", () => api.update(), (u) =>
    `${imported(r)} ${u.written ? `The hosts file was updated: ${fmt(u.hosts)} hosts blocked.` : "The hosts file already matched."}`);
}
async function removeRegion() {
  if (!confirm("Remove NullHost's region from the hosts file? Everything else in the file stays.")) return;
  await act("Removing", () => api.removeRegion(), () => "NullHost's region was removed. Enable blocking to write it again.");
}
</script>

<template>
  <header class="header">
    <div class="title">
      <h1>Settings</h1>
    </div>
  </header>

  <div class="content">
    <Banners />
    <div class="grid2" v-if="set">
      <section class="card">
        <h2 style="margin-bottom: 8px">General</h2>
        <div class="f">
          <div>Appearance<div class="hint">System follows the Windows app mode</div></div>
          <select class="input sm" aria-label="Appearance" :value="set.theme" @change="saveSetting('Saving', { theme: ($event.target as HTMLSelectElement).value as Theme }, 'Appearance saved.')">
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </div>
        <div class="f">
          <div>Start at login<div class="hint">{{ set.startAtLoginAvailable ? "Starts in the tray at login, no prompt; it asks for administrator rights on its first change" : "Available in the installed app" }}</div></div>
          <Toggle :model-value="set.startAtLogin" label="Start at login" :disabled="!set.startAtLoginAvailable" @update:model-value="(on: boolean) => saveSetting('Saving', { startAtLogin: on }, on ? 'NullHost will start at login.' : 'NullHost will not start at login.')" />
        </div>
        <div class="f">
          <div>Closing the window<div class="hint">hides NullHost to the tray; Quit is in the tray menu</div></div>
          <span class="muted">always</span>
        </div>
        <form class="f" @submit.prevent="saveSetting('Saving', { hotkey }, `Hotkey set to ${hotkey}.`)">
          <div>Global hotkey: enable / disable blocking<div class="hint" :class="{ warnc: !set.hotkeyRegistered }">{{ set.hotkeyRegistered ? "registered" : "not registered (taken by another app?)" }}</div></div>
          <span style="display: flex; gap: 8px"><input v-model="hotkey" class="input sm mono" style="width: 170px" aria-label="Global hotkey" /><button class="btn sm" type="submit">Save</button></span>
        </form>
      </section>

      <section class="card">
        <h2 style="margin-bottom: 8px">Hosts output</h2>
        <div class="f">
          <div>Block address<div class="hint">0.0.0.0 is faster on Windows and never hits a local web server</div></div>
          <select class="input sm mono" aria-label="Block address" :value="set.ip" @change="saveSetting('Saving', { ip: ($event.target as HTMLSelectElement).value }, 'Saved. Apply to rewrite the hosts file.')">
            <option value="0.0.0.0">0.0.0.0</option><option value="127.0.0.1">127.0.0.1</option>
          </select>
        </div>
        <form class="f" @submit.prevent="saveSetting('Saving', { budget: Number(budget) }, 'Budget saved.')">
          <div>Entry budget<div class="hint">warn above this many hosts; refused above {{ fmt(set.hardCeiling) }}</div></div>
          <span style="display: flex; gap: 8px"><input v-model.number="budget" type="number" min="1000" :max="set.hardCeiling" step="1000" class="input sm mono" style="width: 120px" aria-label="Entry budget" /><button class="btn sm" type="submit">Save</button></span>
        </form>
        <div class="f"><div class="muted">Always on Windows: 9 hosts per line, CRLF, source attribution in the file header</div></div>
      </section>

      <section class="card">
        <h2 style="margin-bottom: 8px">Automatic updates</h2>
        <div class="f">
          <div>Daily update in the background<div class="hint">{{ schedule?.available ? "Task Scheduler, as you with administrator rights: runs while you are logged on, catches up after the PC was off. Switching it asks for administrator rights" : "Only in the installed NullHost app" }}</div></div>
          <Toggle :model-value="schedule?.installed ?? false" label="Daily automatic update" :disabled="!schedule?.available || !!store.busy" @update:model-value="setSchedule" />
        </div>
        <form class="f" @submit.prevent="setSchedule(true)">
          <div>Time<div class="hint">local time; up to 10 minutes later to spread load on the list servers</div></div>
          <span style="display: flex; gap: 8px"><input v-model="scheduleAt" type="time" class="input sm mono" aria-label="Update time" style="width: 120px" /><button class="btn sm" type="submit" :disabled="!schedule?.available">Save</button></span>
        </form>
        <div class="f"><div>Last run</div><span :class="schedule?.lastResult ? 'warnc' : 'muted'">{{ schedule?.installed ? `${when(schedule.lastRun)}${schedule.lastResult ? ` (failed, ${schedule.lastResult})` : schedule.lastRun ? ", OK" : ""}` : "—" }}</span></div>
        <div class="f"><div>Next run</div><span class="muted">{{ schedule?.installed ? when(schedule.nextRun) : "—" }}</span></div>
      </section>

      <section class="card">
        <h2 style="margin-bottom: 8px">Troubleshoot</h2>
        <div v-if="!checks" class="muted" style="padding: 6px 0">Read-only checks: the hosts file, NullHost's region, old leftovers, the DNS Client service, the Defender exclusion, automatic updates, and whether Windows answers from the file.</div>
        <div v-for="c in checks ?? []" :key="c.id" class="f" style="align-items: flex-start">
          <div>{{ c.label }}<div class="hint">{{ c.detail }}</div><div v-if="c.fix && c.level !== 'ok'" class="hint" style="color: var(--text-2)">{{ c.fix }}</div></div>
          <span :class="LEVEL[c.level].cls" style="white-space: nowrap">{{ LEVEL[c.level].text }}</span>
        </div>
        <div style="display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap">
          <button class="btn" type="button" :disabled="!!store.busy" @click="runChecks">{{ checks ? "Run again" : "Run checks" }}</button>
          <button class="btn" type="button" @click="copyReport">Copy report</button>
        </div>
      </section>

      <section class="card span2">
        <h2 style="margin-bottom: 8px">Move to another PC</h2>
        <div class="muted" style="margin-bottom: 12px">
          Export saves your lists, your own lists, the allowlist, the block address and the budget to one file. Import it on the other PC: it replaces that PC's settings,
          keeping the old ones as <span class="mono">config.toml.before-import</span>. Appearance, hotkey, start at login and automatic updates are set on each PC.
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 10px">
          <button class="btn" type="button" :disabled="!!store.busy" @click="exportSettings">Export settings…</button>
          <button class="btn" type="button" :disabled="!!store.busy" @click="importSettings">Import settings…</button>
        </div>
      </section>

      <section class="card span2">
        <h2 style="margin-bottom: 8px">Backups &amp; remove</h2>
        <div class="muted" style="margin-bottom: 12px">A snapshot is taken automatically before every write. The last 10 are kept, plus the original file from before NullHost. Restoring takes a snapshot first.</div>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center">
          <button class="btn" type="button" :disabled="!canWrite || !st?.snapshots" @click="restore('previous')">Restore previous</button>
          <button class="btn" type="button" :disabled="!canWrite || !st?.hasOriginal" @click="restore('original')">Restore original</button>
          <button class="btn" type="button" @click="api.openBackupFolder()">Open backup folder</button>
          <span style="flex: 1"></span>
          <button class="btn danger" type="button" :disabled="!canWrite" @click="removeRegion"><Icon name="x" />Remove NullHost from hosts file</button>
        </div>
      </section>
    </div>
  </div>
</template>

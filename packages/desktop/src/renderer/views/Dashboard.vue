<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { CheckResult, ScheduleStatus, TidyPreview } from "../../shared/api";
import Banners from "../components/Banners.vue";
import Icon from "../components/Icon.vue";
import Toggle from "../components/Toggle.vue";
import { act, ago, api, fmt, store, untilLabel } from "../store";

const s = computed(() => store.status);
const canWrite = computed(() => store.info?.canWrite ?? false);
const mode = computed(() => s.value?.blocking.mode ?? "enabled");

const head = computed(() => {
  const b = s.value?.blocking;
  if (!b) return { title: "Loading…", sub: "", color: "var(--muted)" };
  if (b.mode === "paused") return { title: "Hosts blocking is paused.", sub: `Resumes automatically at ${untilLabel(b.until)}. Your own entries and dev vhosts stay active.`, color: "var(--pause)" };
  if (b.mode === "disabled") return { title: "Hosts blocking is disabled.", sub: "Only your own entries and dev vhosts are in effect. Enable it again when you are done.", color: "var(--warn)" };
  return { title: "Hosts blocking is enabled.", sub: "Ads, trackers and malware hosts are blocked. Your own entries and dev vhosts are active.", color: "var(--ok)" };
});

const enabledCount = computed(() => store.sources.filter((x) => x.enabled).length);

const warnings = computed(() => {
  const w: string[] = [];
  const r = s.value?.region;
  if (r?.modifiedExternally) w.push("NullHost's region in the hosts file was changed by something else since it was written. Apply to rewrite it.");
  if (r && r.count > 1) w.push(`${r.count} NullHost regions found in the hosts file; the next write merges them.`);
  if (r?.unterminated) w.push("NullHost's start and end markers in the hosts file do not pair up, so NullHost does not write the file. Fix the marker lines in the Editor, or restore a snapshot in Settings.");
  if (s.value && !r?.present && mode.value === "enabled" && s.value.lastApply) w.push("NullHost's region is missing from the hosts file. Apply to write it again.");
  for (const x of store.lastResult?.warnings ?? []) w.push(x);
  return w;
});

const changes = computed(() => {
  const runs = s.value?.lastUpdate?.sources ?? {};
  return store.sources
    .filter((x) => x.enabled)
    .map((x) => ({ name: x.name, run: runs[x.id] }))
    .filter((x) => x.run);
});
const changedCount = computed(() => changes.value.filter((c) => (c.run?.added ?? 0) + (c.run?.removed ?? 0) > 0).length);

function setEnabled(on: boolean) {
  void act(on ? "Enabling" : "Disabling", () => (on ? api.enable() : api.disable()));
}
function pauseHour() {
  void act("Pausing", () => api.pause(new Date(Date.now() + 3600_000).toISOString()));
}
async function updateNow() {
  const r = await act("Updating", () => api.update(), (r) =>
    r.pending ? `Lists updated (${fmt(r.hosts)} hosts); blocking is ${r.mode}, so nothing was written.` :
    r.written ? `Updated: ${fmt(r.hosts)} hosts, +${fmt(r.diff.added)} / −${fmt(r.diff.removed)}.` :
    "Lists checked: nothing changed, the hosts file was not touched.");
  if (r) store.lastResult = r;
}
async function applyNow() {
  const r = await act("Applying", () => api.apply(), (r) => (r.written ? `Applied: ${fmt(r.hosts)} hosts.` : "Nothing to apply: the hosts file already matches."));
  if (r) store.lastResult = r;
}

const schedule = ref<ScheduleStatus | null>(null);
const conflicts = ref<string[]>([]);
onMounted(async () => {
  void api.conflicts().then((c) => (conflicts.value = c), () => undefined);
  schedule.value = await api.schedule().catch(() => null);
});

// "Finish setup": the installed app's first runs, until both are on or the card is dismissed
const SETUP_KEY = "nullhost.setupDismissed";
const setupDismissed = ref(false);
try { setupDismissed.value = localStorage.getItem(SETUP_KEY) === "1"; } catch { /* storage unavailable */ }
const showSetup = computed(() => {
  const i = store.info, set = store.settings, sch = schedule.value;
  if (!i || i.dev || !i.canWrite || !set || !sch || setupDismissed.value) return false;
  return !set.startAtLogin || !sch.installed;
});
function dismissSetup() {
  setupDismissed.value = true;
  try { localStorage.setItem(SETUP_KEY, "1"); } catch { /* storage unavailable */ }
}
async function setupLogin() {
  await act("Turning on start at login", () => api.setSettings({ startAtLogin: true }), () => "NullHost will start in the tray when you log in.");
}
async function setupDaily() {
  const r = await act("Turning on daily updates", () => api.setSchedule("07:30"), () => "Daily updates are on, at 07:30.");
  if (r) schedule.value = r;
}
function nextLabel(iso: string): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `next today ${t}`;
  if (d.toDateString() === tomorrow.toDateString()) return `next tomorrow ${t}`;
  return `next ${d.toLocaleDateString()} ${t}`;
}
const nextRun = computed(() => {
  const x = schedule.value;
  if (!x) return "";
  if (!x.installed) return "automatic updates off";
  return x.nextRun ? nextLabel(x.nextRun) : `daily at ${x.at}`;
});

const leftovers = computed(() => s.value?.leftovers.hosts ?? 0);
const tidyPlan = ref<TidyPreview | null>(null);
async function reviewTidy() {
  tidyPlan.value = (await act("Preparing clean-up", () => api.planTidy())) ?? null;
}
async function runTidy() {
  const r = await act("Cleaning up", () => api.tidy(), (p) => `Removed ${fmt(p.removeSink0 + p.removeLoopback)} old entries; the hosts file went from ${fmt(p.linesBefore)} to ${fmt(p.linesAfter)} lines. Settings > Restore previous undoes it.`);
  if (r) tidyPlan.value = null;
}

const host = ref("");
const checked = ref<CheckResult | null>(null);
async function check() {
  if (!host.value.trim()) return;
  checked.value = (await act("Checking", () => api.check(host.value))) ?? null;
}
async function allowIt() {
  const h = checked.value?.host;
  if (!h) return;
  await act("Allowing", async () => { await api.allowAdd(h); return api.apply(); }, () => `${h} is allowed and the hosts file was updated.`);
  checked.value = (await api.check(h)) ?? null;
}
</script>

<template>
  <header class="header">
    <h1 class="title">Dashboard</h1>
    <button v-if="mode === 'enabled'" class="btn" type="button" :disabled="!canWrite || !!store.busy" @click="pauseHour"><Icon name="pause" />Pause 1 h</button>
    <button v-else-if="mode === 'paused'" class="btn" type="button" :disabled="!canWrite || !!store.busy" @click="setEnabled(true)"><Icon name="play" />Resume now</button>
    <span class="btn" style="cursor: default">
      <Toggle :model-value="mode === 'enabled'" label="Hosts blocking" :disabled="!canWrite || !!store.busy" :show-text="mode === 'enabled' ? 'Enabled' : 'Disabled'" @update:model-value="setEnabled" />
    </span>
    <button class="btn" type="button" title="Write the current selection without downloading" :disabled="!canWrite || !!store.busy" @click="applyNow"><Icon name="check" />Apply</button>
    <button class="btn primary" type="button" title="Download changed lists and apply" :disabled="!canWrite || !!store.busy" @click="updateNow"><Icon name="refresh" />Update now</button>
  </header>

  <div class="content">
    <Banners />

    <section class="card" style="display: flex; flex-wrap: wrap; gap: 24px; align-items: center">
      <div style="flex: 1 1 320px">
        <div class="k">Status</div>
        <div style="font-size: 26px; font-weight: 700; margin-top: 6px" :style="{ color: head.color }">{{ head.title }}</div>
        <div class="muted" style="margin-top: 4px">{{ head.sub }}</div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; flex: 2 1 480px">
        <div><div class="k">Sources enabled</div><div style="font-size: 18px; font-weight: 600; margin-top: 4px">{{ enabledCount }} of {{ store.sources.length }}</div></div>
        <div><div class="k">Blocked hosts</div><div style="font-size: 18px; font-weight: 600; margin-top: 4px">{{ fmt(s?.region.hosts) }}</div><div class="hint" v-if="mode !== 'enabled' && s?.cachedRegion">{{ fmt(s.cachedRegion.hosts) }} when enabled</div></div>
        <div><div class="k">Lines written</div><div style="font-size: 18px; font-weight: 600; margin-top: 4px">{{ fmt(s?.region.lines) }}</div><div class="hint">9 hosts per line</div></div>
        <div><div class="k">Last update</div><div style="font-size: 18px; font-weight: 600; margin-top: 4px">{{ ago(s?.lastUpdate?.at) }}</div><div class="hint">{{ nextRun || `${s?.snapshots ?? 0} snapshots kept` }}</div></div>
      </div>
    </section>

    <div v-if="store.info?.pauseEnded" class="banner info" role="status">
      <Icon name="info" />
      <span style="flex: 1">The pause has ended, but blocking is still off. Enabling it asks for administrator rights once for this session.</span>
      <button class="btn sm primary" type="button" :disabled="!!store.busy" @click="setEnabled(true)">Enable blocking</button>
    </div>

    <div v-if="conflicts.length" class="banner warn" role="alert">
      <Icon name="warn" />
      <span style="flex: 1"><strong>{{ conflicts.join(", ") }} is running.</strong> Its updater rewrites the hosts file and removes NullHost's region. Quit it and turn off its automatic updates; uninstall it once NullHost runs well.</span>
    </div>

    <section v-if="showSetup" class="card" style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center">
      <div style="flex: 1 1 320px">
        <h2>Finish setting up</h2>
        <div class="muted" style="margin-top: 4px">Two switches make NullHost a full HostsMan replacement. Both are also in Settings.</div>
      </div>
      <button class="btn" type="button" :disabled="store.settings?.startAtLogin || !!store.busy" @click="setupLogin">
        <Icon name="check" />{{ store.settings?.startAtLogin ? "Starts at login" : "Start at login" }}
      </button>
      <button class="btn" type="button" :disabled="schedule?.installed || !!store.busy" @click="setupDaily">
        <Icon name="refresh" />{{ schedule?.installed ? `Daily at ${schedule.at}` : "Daily updates at 07:30" }}
      </button>
      <button class="btn sm" type="button" @click="dismissSetup">Not now</button>
    </section>

    <section v-if="leftovers" class="card" style="border-color: var(--warn-border); background: var(--warn-card)">
      <div style="display: flex; gap: 12px; align-items: flex-start">
        <Icon name="warn" style="width: 20px; height: 20px; color: var(--warn); flex: 0 0 20px; margin-top: 2px" />
        <div style="flex: 1">
          <div style="font-weight: 600; color: var(--warn-text)">{{ fmt(leftovers) }} old block entries outside NullHost's region</div>
          <div class="muted" style="margin-top: 4px">NullHost already blocks every one of them, compressed. Left one per line (probably by HostsMan), they double the file and make each DNS reload slower. The clean-up removes only those; your dev vhosts and own blocks stay.</div>
          <div v-if="tidyPlan" style="margin-top: 12px">
            <div class="row"><span>Remove at 0.0.0.0 / at 127.0.0.1</span><span class="mono">{{ fmt(tidyPlan.removeSink0) }} / {{ fmt(tidyPlan.removeLoopback) }}</span></div>
            <div class="row"><span>Hosts file lines</span><span class="mono">{{ fmt(tidyPlan.linesBefore) }} → {{ fmt(tidyPlan.linesAfter) }}</span></div>
            <div class="row"><span>Your own entries kept</span><span class="mono">{{ fmt(tidyPlan.keptOwnBlocks) }}</span></div>
            <div class="row"><span>Removed e.g.</span><span class="mono" style="text-align: right">{{ tidyPlan.sampleRemoved.slice(0, 4).join(", ") }}</span></div>
            <div class="row"><span>Kept e.g.</span><span class="mono" style="text-align: right">{{ tidyPlan.sampleKept.slice(0, 4).join(", ") }}</span></div>
            <div class="hint" style="margin-top: 6px">A snapshot is taken first; Settings › Restore previous undoes it. If you disable blocking later, these hosts are no longer blocked either.</div>
          </div>
          <div style="display: flex; gap: 10px; margin-top: 12px">
            <button v-if="!tidyPlan" class="btn sm" type="button" @click="reviewTidy">Review clean-up</button>
            <template v-else>
              <button class="btn sm primary" type="button" :disabled="!canWrite || !!store.busy" @click="runTidy">Clean up</button>
              <button class="btn sm" type="button" @click="tidyPlan = null">Cancel</button>
            </template>
          </div>
        </div>
      </div>
    </section>

    <div v-for="w in warnings" :key="w" class="banner warn">
      <Icon name="warn" /><span style="flex: 1">{{ w }}</span>
      <button v-if="w.includes('Apply')" class="btn sm" type="button" :disabled="!canWrite" @click="applyNow">Apply</button>
    </div>

    <div class="grid2">
      <section class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px">
          <h2>Last update</h2>
          <span v-if="changedCount" class="tag" style="background: var(--accent-soft); color: var(--accent-hover)">{{ changedCount }} source{{ changedCount === 1 ? "" : "s" }} changed</span>
        </div>
        <div v-if="!changes.length" class="muted" style="margin-top: 12px">Not checked yet. Update now downloads the enabled lists.</div>
        <div v-for="c in changes" :key="c.name" class="row" style="margin-top: 4px">
          <span>{{ c.name }}</span>
          <span v-if="c.run?.from === 'failed'" class="warnc" style="font-size: 13px">failed</span>
          <span v-else-if="c.run?.added === undefined" class="muted">{{ c.run?.from === "cache" || c.run?.from === "cache-304" ? "unchanged" : `downloaded, ${fmt(c.run?.kept)} hosts` }}</span>
          <span v-else-if="(c.run?.added ?? 0) + (c.run?.removed ?? 0)" class="mono"><span class="plus">+{{ fmt(c.run?.added) }}</span> <span class="minus">−{{ fmt(c.run?.removed) }}</span></span>
          <span v-else class="muted">unchanged</span>
        </div>
        <div v-if="store.lastResult" class="hint" style="margin-top: 10px">
          Last run: {{ fmt(store.lastResult.hosts) }} hosts, +{{ fmt(store.lastResult.diff.added) }} / −{{ fmt(store.lastResult.diff.removed) }}{{ store.lastResult.written ? ", written" : ", hosts file unchanged" }}.
        </div>
      </section>

      <section class="card">
        <h2>Is a host blocked?</h2>
        <form style="display: flex; gap: 10px; margin-top: 12px" @submit.prevent="check">
          <label for="dash-check" class="sr-only">Host name</label>
          <input id="dash-check" v-model="host" class="input mono" style="flex: 1" placeholder="ads.example.com" autocomplete="off" spellcheck="false" />
          <button class="btn" type="submit">Check</button>
        </form>
        <div v-if="checked" class="banner" :class="checked.blockedNow ? 'warn' : 'ok'" style="margin-top: 14px; display: block">
          <div>
            <strong>{{ checked.blockedNow ? "Blocked" : checked.allowedBy ? "Allowed" : "Not blocked" }}.</strong>
            <span v-if="checked.listedBy.length"> Listed by {{ checked.listedBy.join(" and ") }}.</span>
            <span v-else> Not in any enabled source.</span>
            <span v-if="checked.allowedBy"> Your allowlist entry <span class="mono">{{ checked.allowedBy }}</span> lets it through.</span>
            <span v-if="checked.ownEntry"> Your own entry outside NullHost's region also blocks it.</span>
          </div>
          <div v-if="checked.blockedNow && !checked.allowedBy" style="margin-top: 8px">
            <button class="btn sm" type="button" :disabled="!canWrite" @click="allowIt">Allow this host</button>
          </div>
        </div>
        <div class="hint" style="margin-top: 10px">Hosts entries are exact names: blocking <span class="mono">ad.example.com</span> does not block <span class="mono">ads.example.com</span>.</div>
      </section>
    </div>
  </div>
</template>

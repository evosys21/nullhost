<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { DNS_LOG_MINUTES, type DnsLogEntry, type DnsLogView, type DnsVerdict } from "../../shared/api";
import Banners from "../components/Banners.vue";
import Icon from "../components/Icon.vue";
import { act, api, cleanError, fmt, store } from "../store";

// Windows' DNS Client log, read every two seconds while this tab is open.
const POLL_MS = 2000;
const READ_TIMEOUT_MS = 20_000;
/** rows kept in the table; older ones drop off the bottom */
const KEEP = 3000;

const view = ref<DnsLogView | null>(null);
const rows = ref<DnsLogEntry[]>([]);
let after = 0;
let timer: number | undefined;
let reading = false;
const readError = ref("");
/** stop adding rows (the log keeps recording) */
const frozen = ref(false);
const filter = ref<"all" | "blocked" | "passed">("all");
const search = ref("");
/** how long Start logging runs */
const minutes = ref<number>(DNS_LOG_MINUTES[0]);
/** the clock for the countdown */
const now = ref(Date.now());
let clock: number | undefined;

const LABELS: Record<DnsVerdict, string> = {
  blocked: "Blocked",
  own: "Own entry",
  elsewhere: "Blocked elsewhere",
  allowed: "Allowed",
  resolved: "Resolved",
  failed: "Failed",
};
const STYLES: Record<DnsVerdict, Record<string, string>> = {
  blocked: { background: "var(--danger-soft)", color: "var(--danger)" },
  own: { background: "var(--warn-soft)", color: "var(--warn-text)" },
  elsewhere: { background: "var(--warn-soft)", color: "var(--warn-text)" },
  allowed: { background: "var(--accent-soft)", color: "var(--accent-hover)" },
  resolved: { background: "var(--ok-soft)", color: "var(--ok-text)" },
  failed: {},
};
const isBlocked = (v: DnsVerdict) => v === "blocked" || v === "own" || v === "elsewhere";

async function poll() {
  if (reading) return;
  reading = true;
  try {
    // a read that never answers would freeze the tab: give up after READ_TIMEOUT_MS and try again on the next poll
    const v = await Promise.race([
      api.dnsLog(after),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${READ_TIMEOUT_MS / 1000} s`)), READ_TIMEOUT_MS)),
    ]);
    view.value = v;
    readError.value = v.error ?? "";
    if (v.entries.length && !frozen.value) {
      after = v.last;
      // newest first in the table
      rows.value = [...v.entries.slice().reverse(), ...rows.value].slice(0, KEEP);
    } else if (!frozen.value) after = v.last;
  } catch (err) {
    readError.value = cleanError(err);
  } finally {
    reading = false;
  }
}

onMounted(() => {
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
  clock = window.setInterval(() => (now.value = Date.now()), 1000);
  document.addEventListener("mousedown", closeMenu);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", hideMenu);
});
onUnmounted(() => {
  window.clearInterval(timer);
  window.clearInterval(clock);
  document.removeEventListener("mousedown", closeMenu);
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", hideMenu);
});

/** "4 min" / "35 s" until NullHost switches its log off */
const left = computed(() => {
  const until = view.value?.until;
  if (!until) return "";
  const s = Math.max(0, Math.round((Date.parse(until) - now.value) / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`;
});
const untilTime = computed(() => (view.value?.until ? new Date(view.value.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""));
const minutesLabel = (m: number) => (m < 60 ? `${m} minutes` : `${m / 60} hour`);
const shortLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

// the split button's menu: placed against the window (the header clips what overflows it)
const caret = ref<HTMLButtonElement | null>(null);
const menuOpen = ref(false);
const menuPos = ref<Record<string, string>>({});
function toggleMenu() {
  if (menuOpen.value) return void (menuOpen.value = false);
  const r = caret.value?.getBoundingClientRect();
  if (r) menuPos.value = { top: `${r.bottom + 6}px`, right: `${window.innerWidth - r.right}px` };
  menuOpen.value = true;
}
function closeMenu(e: Event) {
  if (!menuOpen.value) return;
  const t = e.target as Node | null;
  if (t && (caret.value?.contains(t) || (t as Element).closest?.(".menu"))) return;
  menuOpen.value = false;
}
const onKey = (e: KeyboardEvent) => e.key === "Escape" && (menuOpen.value = false);
const hideMenu = () => (menuOpen.value = false);
async function startFor(m: number) {
  menuOpen.value = false;
  minutes.value = m;
  await setLog("enable");
}

async function setLog(action: "enable" | "disable" | "clear") {
  const label = action === "enable" ? "Starting the DNS log" : action === "disable" ? "Stopping the DNS log" : "Clearing the DNS log";
  const notice = action === "enable" ? `Logging lookups for ${minutesLabel(minutes.value)}. New ones appear below as they happen.` : action === "disable" ? "Stopped logging. What was logged stays until you clear it." : "The DNS log is empty.";
  const v = await act(label, () => api.setDnsLog(action, minutes.value), () => notice);
  if (!v) return;
  view.value = { ...v, entries: [] };
  if (action === "clear") {
    rows.value = [];
    after = 0;
  }
  await poll();
}

async function elevate() {
  await act("Asking for administrator rights", () => api.elevate(), () => "NullHost has administrator rights until you quit it.");
  await poll();
}

function unfreeze() {
  frozen.value = false;
  void poll();
}

async function allow(host: string) {
  await act("Allowing", async () => { await api.allowAdd(host); return api.apply(); }, () => `${host} is allowed and the hosts file was updated.`);
}

const shown = computed(() => {
  const q = search.value.trim().toLowerCase();
  return rows.value.filter((r) => {
    if (filter.value === "blocked" && !isBlocked(r.verdict)) return false;
    if (filter.value === "passed" && isBlocked(r.verdict)) return false;
    return !q || r.name.includes(q) || (r.process ?? "").toLowerCase().includes(q);
  });
});
const counts = computed(() => {
  const blocked = rows.value.filter((r) => isBlocked(r.verdict)).length;
  return { all: rows.value.length, blocked, passed: rows.value.length - blocked };
});
const pct = computed(() => (counts.value.all ? Math.round((counts.value.blocked / counts.value.all) * 100) : 0));

const time = (iso: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
function detail(r: DnsLogEntry): string {
  if (r.verdict === "blocked") return r.listedBy?.length ? r.listedBy.join(", ") : "NullHost";
  if (r.verdict === "own") return "your entry in the hosts file";
  if (r.verdict === "elsewhere") return "answered 0.0.0.0 by your DNS server or another tool";
  if (r.verdict === "allowed") return `${r.allowedBy ?? "allowlist"} (listed by ${r.listedBy?.join(", ") ?? "a list"})`;
  if (r.statusText) return r.statusText;
  return r.results.slice(0, 3).join(", ") + (r.results.length > 3 ? ` +${r.results.length - 3}` : "");
}
</script>

<template>
  <header class="header">
    <div class="title">
      <h1>DNS log</h1>
      <div class="sub">Every name this PC looks up, from Windows' DNS Client log, and whether NullHost blocked it.</div>
    </div>
    <template v-if="view?.available">
      <button v-if="view.enabled" class="btn" type="button" :disabled="!view.canSwitch || !!store.busy" @click="setLog('disable')"><Icon name="pause" />Stop logging</button>
      <div v-else-if="!view.enabled" class="split">
        <button class="btn primary" type="button" :disabled="!view.canSwitch || !!store.busy" :title="view.admin ? `Logs for ${minutesLabel(minutes)}, then switches the log off` : 'Asks for administrator rights'" @click="setLog('enable')">
          <Icon :name="view.admin ? 'play' : 'shield'" />Start logging<span class="split-note">{{ shortLabel(minutes) }}</span>
        </button>
        <button ref="caret" class="btn primary" type="button" aria-haspopup="menu" :aria-expanded="menuOpen" aria-label="Choose how long to log" :disabled="!view.canSwitch || !!store.busy" @click="toggleMenu"><Icon name="chevron" /></button>
      </div>
      <div v-if="menuOpen" class="menu" role="menu" aria-label="Log for" :style="menuPos" @keydown.esc="menuOpen = false">
        <div class="menu-head">Log for</div>
        <button v-for="m in DNS_LOG_MINUTES" :key="m" type="button" role="menuitemradio" :aria-checked="m === minutes" @click="startFor(m)">
          <span style="flex: 1">{{ minutesLabel(m) }}</span><Icon v-if="m === minutes" name="check" />
        </button>
        <div class="menu-foot">Then NullHost switches the log off again.</div>
      </div>
    </template>
  </header>

  <div class="content">
    <Banners />
    <!-- shown whatever state the tab is in, so a failing read is never a blank page -->
    <div v-if="readError" class="banner error" role="alert"><Icon name="warn" /><span style="flex: 1">Couldn't read the DNS log: {{ readError }}</span><button class="btn sm" type="button" @click="poll">Try again</button></div>
    <div v-if="!view && !readError" class="banner info" role="status"><span class="spinner"></span><span>Reading the DNS log…</span></div>
    <div v-if="view && !view.available" class="banner warn"><Icon name="info" /><span>The DNS Client log can't be read here. It is a Windows feature.</span></div>
    <template v-else-if="view">
      <div v-if="!view.enabled" class="banner info">
        <Icon name="info" />
        <span style="flex: 1">
          Windows doesn't log lookups by default. <strong>Start logging</strong> switches the log on for the time you pick; NullHost switches it off again then, or when you quit it.
          While it's on, the names this PC looks up are recorded in the Windows event log, where other administrators and signed-in users of this PC can read them.
        </span>
      </div>
      <div v-else-if="view.overdue" class="banner warn" role="status">
        <Icon name="warn" />
        <span style="flex: 1">The logging time ended at {{ untilTime }}, but the log is still on: switching it off needs administrator rights, which NullHost doesn't have right now.</span>
        <button class="btn sm" type="button" :disabled="!!store.busy" @click="setLog('disable')"><Icon name="shield" />Switch it off</button>
      </div>
      <div v-else-if="view.ours" class="banner ok" role="status"><span class="dot"></span><span style="flex: 1">Logging until {{ untilTime }} ({{ left }} left). NullHost switches it off then, or when you quit it. Clear removes what was recorded.</span></div>
      <div v-else class="banner warn" role="status">
        <Icon name="info" />
        <span style="flex: 1">Logging is on, with no time limit: NullHost has no record of switching it on (another program did, or a NullHost that quit without switching it off). NullHost won't switch it off by itself; <strong>Stop logging</strong> does it now.</span>
      </div>
      <div v-if="!view.canSwitch" class="banner warn"><Icon name="info" /><span>Switching the log needs administrator rights, which NullHost can't ask for here. Start it as administrator.</span></div>
      <div v-else-if="!view.admin" class="banner warn">
        <Icon name="shield" />
        <span style="flex: 1">Switching or clearing the log needs administrator rights. Windows asks once, then NullHost keeps them until you quit it.</span>
        <button class="btn sm" type="button" :disabled="!!store.busy" @click="elevate"><Icon name="shield" />Run as administrator</button>
      </div>

      <section class="card" style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center">
        <div role="group" aria-label="Show" style="display: flex; gap: 6px">
          <button v-for="f in (['all', 'blocked', 'passed'] as const)" :key="f" type="button" class="btn sm" :class="{ primary: filter === f }" :aria-pressed="filter === f" @click="filter = f">
            {{ f === "all" ? "All" : f === "blocked" ? "Blocked" : "Not blocked" }} <span class="mono" style="opacity: 0.8">{{ fmt(counts[f]) }}</span>
          </button>
        </div>
        <label style="flex: 1 1 220px"><span class="sr-only">Search names and programs</span>
          <input v-model="search" class="input sm mono" style="width: 100%" placeholder="Search names or programs" spellcheck="false" autocomplete="off" /></label>
        <span v-if="counts.all" class="hint" style="margin: 0">{{ pct }}% blocked</span>
        <button v-if="frozen" class="btn sm" type="button" @click="unfreeze"><Icon name="play" />Resume</button>
        <button v-else class="btn sm" type="button" :disabled="!view.enabled" @click="frozen = true"><Icon name="pause" />Pause</button>
        <button class="btn sm danger" type="button" :disabled="!view.canSwitch || !!store.busy" @click="setLog('clear')"><Icon name="x" />Clear</button>
      </section>

      <div class="card flush scroll-x">
        <table>
          <thead><tr><th style="width: 90px">Time</th><th>Name</th><th style="width: 60px">Type</th><th style="width: 140px">Result</th><th>Details</th><th>Program</th><th style="width: 90px"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            <tr v-for="r in shown" :key="r.record">
              <td class="mono muted" style="white-space: nowrap">{{ time(r.time) }}</td>
              <td class="mono" style="min-width: 240px; overflow-wrap: anywhere">{{ r.name }}</td>
              <td class="mono muted">{{ r.typeName }}</td>
              <td><span class="tag" :style="STYLES[r.verdict]">{{ LABELS[r.verdict] }}</span></td>
              <td class="muted" style="font-size: 13px; word-break: break-word">{{ detail(r) }}</td>
              <td class="mono muted" style="white-space: nowrap" :title="r.pid ? `process ${r.pid}` : undefined">{{ r.process ?? (r.pid ? `pid ${r.pid}` : "") }}</td>
              <td><button v-if="r.verdict === 'blocked'" class="btn sm" type="button" :disabled="!store.info?.canWrite || !!store.busy" @click="allow(r.name)">Allow</button></td>
            </tr>
            <tr v-if="!shown.length">
              <td colspan="7" class="muted" style="text-align: center; padding: 28px 12px">
                {{ rows.length ? "No lookups match." : view.enabled ? "Waiting for lookups…" : "Nothing logged yet." }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="hint">
        Shows the newest {{ fmt(KEEP) }} lookups. Repeat lookups answered from the DNS cache may not appear each time.
        Browsers with their own secure DNS (Chrome's "Use secure DNS", Firefox's DNS over HTTPS) skip the DNS Client, so their lookups are missing here and they may also bypass the hosts file.
      </div>
    </template>
  </div>
</template>

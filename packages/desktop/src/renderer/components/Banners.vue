<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { act, api, installAppUpdate, store } from "../store";

// Shared top-of-content banners: a new NullHost version, read-only mode, working on a copy, last error, last notice.
const copy = computed(() => store.info && !store.info.systemFile);
const update = computed(() => (store.appUpdate?.available ? store.appUpdate : null));
function skip(version: string) {
  void act("Skipping", () => api.skipAppUpdate(version), () => `NullHost ${version} skipped. You'll be told about the next version.`);
}
</script>

<template>
  <div v-if="update" class="banner info" role="status">
    <Icon name="info" />
    <span v-if="update.canInstall" style="flex: 1"><strong>NullHost {{ update.latest }} is available.</strong> You have {{ update.current }}. Update downloads it, checks its signature and installs it; your settings stay.</span>
    <span v-else style="flex: 1"><strong>NullHost {{ update.latest }} is available.</strong> You have {{ update.current }}. Download the installer and run it: it upgrades in place and keeps your settings.</span>
    <button v-if="update.canInstall" type="button" class="btn sm primary" :disabled="!!store.busy" @click="installAppUpdate(update.latest!)">Update</button>
    <a v-else class="btn sm primary" :href="update.url" target="_blank" rel="noopener">Download</a>
    <button type="button" class="btn sm" @click="skip(update.latest!)">Skip this version</button>
  </div>
  <div v-if="store.info && !store.info.canWrite" class="banner warn">
    <Icon name="warn" /><span>{{ store.info.readOnlyReason }}</span>
  </div>
  <div v-if="copy" class="banner info">
    <Icon name="info" /><span>Working on a copy: <span class="mono">{{ store.info?.hostsFile }}</span>. The system hosts file is not touched and DNS is not flushed.</span>
  </div>
  <div v-if="store.error" class="banner error" role="alert">
    <Icon name="warn" /><span style="flex: 1">{{ store.error }}</span>
    <button type="button" class="btn sm" @click="store.error = ''">Dismiss</button>
  </div>
  <div v-if="store.notice" class="banner ok" role="status">
    <Icon name="check" /><span style="flex: 1">{{ store.notice }}</span>
    <button type="button" class="btn sm" @click="store.notice = ''">Dismiss</button>
  </div>
</template>

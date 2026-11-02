<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { store } from "../store";

// Shared top-of-content banners: read-only mode, working on a copy, last error, last notice.
const copy = computed(() => store.info && !store.info.systemFile);
</script>

<template>
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

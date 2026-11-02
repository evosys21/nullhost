<script setup lang="ts">
// The same shield as the window, tray and exe icon (src/main/icons.ts): same outline,
// same state colours and marks, in a 100-unit box so the numbers match its unit coordinates.
import { computed } from "vue";

const props = defineProps<{ mode?: "enabled" | "disabled" | "paused" }>();

const COLORS = { enabled: "#15803d", paused: "#1d4ed8", disabled: "#b45309" } as const;
const fill = computed(() => COLORS[props.mode ?? "enabled"]);
</script>

<template>
  <svg aria-hidden="true" viewBox="0 0 100 100">
    <path d="M50 5L88 15V45C88 69 71 85 50 95C29 85 12 69 12 45V15Z" :fill="fill" />
    <g fill="#fff">
      <template v-if="mode === 'paused'">
        <rect x="32.5" y="30" width="15" height="34" />
        <rect x="52.5" y="30" width="15" height="34" />
      </template>
      <rect v-else-if="mode === 'disabled'" x="30" y="41" width="40" height="12" />
      <path v-else d="M31 47L45 61L69 34" fill="none" stroke="#fff" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" />
    </g>
  </svg>
</template>

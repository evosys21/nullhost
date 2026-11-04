<script setup lang="ts">
// Inline stroke icons (no icon font, no remote assets).
defineProps<{ name: keyof typeof PATHS }>();
</script>

<script lang="ts">
export const PATHS = {
  shield: ["M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3z", "M9 12l2 2 4-4"],
  gauge: ["M4 14a8 8 0 1 1 16 0", "M12 14l4-4"],
  list: ["M4 6h16M4 12h16M4 18h10"],
  allow: ["M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3z", "M9 12l2 2 4-4"],
  edit: ["M4 20h4l10-10-4-4L4 16v4z", "M12 8l4 4"],
  sliders: ["M4 7h10M18 7h2M4 17h2M10 17h10", "M16 5v4M8 15v4"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  chevron: ["M6 9l6 6 6-6"],
  stop: ["M7 7h10v10H7z"],
  refresh: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"],
  check: ["M5 12l5 5L20 7"],
  pause: ["M8 5v14M16 5v14"],
  plus: ["M12 5v14M5 12h14"],
  warn: ["M12 3l10 18H2L12 3z", "M12 10v4M12 17h.01"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 8v5M12 16h.01"],
  x: ["M6 6l12 12M18 6L6 18"],
  play: ["M7 5l12 7-12 7V5z"],
} as const;
</script>

<template>
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path v-for="d in PATHS[name]" :key="d" :d="d" />
  </svg>
</template>

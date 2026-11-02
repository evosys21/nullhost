<script setup lang="ts">
defineProps<{ modelValue: boolean; label: string; disabled?: boolean; showText?: string }>();
defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <button
    type="button"
    role="switch"
    class="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span class="track"></span>
    <span v-if="showText">{{ showText }}</span>
  </button>
</template>

<template>
  <n-input-group>
    <n-select
      v-model:value="scheme"
      :options="schemeOptions"
      class="scheme-select"
      @update:value="emitValue"
    />
    <n-input :value="host" :placeholder="placeholder" @update:value="onInput" />
  </n-input-group>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { NInputGroup, NInput, NSelect } from 'naive-ui'

/**
 * Cloud base URL input with a scheme selector. Pasting a full URL
 * ("https://cloud.example.com/") auto-splits: the scheme populates the
 * selector, the bare host(+path) stays in the field. A value typed without a
 * scheme is stored under the currently selected scheme (default https://),
 * so bare-host input no longer produces a relative URL that CloudClient's
 * fetch cannot resolve.
 */
const props = defineProps<{ value: string; placeholder?: string }>()
const emit = defineEmits<{ (e: 'update:value', v: string): void }>()

const schemeOptions = [
  { label: 'https://', value: 'https://' },
  { label: 'http://', value: 'http://' },
]

const scheme = ref('https://')
const host = ref('')
let syncing = false

/** Strip scheme (selecting it) and trailing slashes from raw input. */
function split(raw: string): string {
  const m = raw.match(/^(https?):\/\//i)
  if (m) {
    scheme.value = m[1].toLowerCase() + '://'
    return raw.slice(m[0].length).replace(/\/+$/, '')
  }
  return raw.replace(/\/+$/, '')
}

// External value changes (store load, form reset) re-sync the parts.
watch(
  () => props.value,
  (v) => {
    syncing = true
    scheme.value = 'https://'
    host.value = v ? split(v) : ''
    syncing = false
  },
  { immediate: true },
)

function onInput(raw: string) {
  host.value = split(raw)
  emitValue()
}

function emitValue() {
  if (syncing) return
  emit('update:value', host.value ? scheme.value + host.value : '')
}
</script>

<style scoped>
.scheme-select {
  width: 118px;
  flex: 0 0 118px;
}
</style>

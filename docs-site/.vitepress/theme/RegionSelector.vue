<script setup lang="ts">
import { ref, computed } from 'vue'

// DocuShark Cloud relay pods are regional; clients connect by region hostname.
// Toronto is live today; the rest light up on request.
const regions = [
  { id: 'yyz', city: 'Toronto', available: true },
  { id: 'ord', city: 'Chicago', available: false },
  { id: 'nrt', city: 'Tokyo', available: false },
  { id: 'fra', city: 'Frankfurt', available: false },
]

const selected = ref('yyz')
const region = computed(() => regions.find((r) => r.id === selected.value)!)
const url = computed(() => `https://${selected.value}.relay.docushark.app/mcp`)
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(url.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    // Clipboard blocked (e.g. non-secure context) — the field is selectable instead.
  }
}
</script>

<template>
  <div class="region-selector">
    <label class="rs-label" for="rs-region">Your workspace location</label>
    <div class="rs-row">
      <select id="rs-region" v-model="selected" class="rs-select">
        <option v-for="r in regions" :key="r.id" :value="r.id">
          {{ r.city }} ({{ r.id }}){{ r.available ? '' : ' — on request' }}
        </option>
      </select>
    </div>

    <label class="rs-label" for="rs-url">Your MCP endpoint</label>
    <div class="rs-row">
      <input
        id="rs-url"
        class="rs-url"
        :value="url"
        readonly
        @focus="($event.target as HTMLInputElement).select()"
      />
      <button class="rs-copy" type="button" @click="copy">{{ copied ? 'Copied ✓' : 'Copy' }}</button>
    </div>

    <p v-if="!region.available" class="rs-note">
      The <strong>{{ region.city }}</strong> region isn’t live yet — it lights up on request.
      <a href="https://app.docushark.app" target="_blank" rel="noreferrer">Get in touch</a> to enable
      it for your workspace. <strong>Toronto (yyz)</strong> is available today.
    </p>
  </div>
</template>

<style scoped>
.region-selector {
  margin: 1.25rem 0;
  padding: 1.1rem 1.2rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.rs-label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  margin: 0.2rem 0 0.35rem;
}
.rs-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.75rem;
}
.rs-row:last-of-type {
  margin-bottom: 0;
}
.rs-select,
.rs-url {
  flex: 1 1 auto;
  min-width: 0;
  height: 38px;
  padding: 0 0.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.95rem;
}
.rs-url {
  font-family: var(--vp-font-family-mono);
  font-size: 0.88rem;
}
.rs-copy {
  flex: 0 0 auto;
  height: 38px;
  padding: 0 1rem;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 8px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-bg);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.rs-copy:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
}
.rs-note {
  margin: 0.4rem 0 0;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}
</style>

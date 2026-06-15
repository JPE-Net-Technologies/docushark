<script setup lang="ts">
import { computed } from 'vue'
import DefaultTheme from 'vitepress/theme'
import { useData } from 'vitepress'
import Breadcrumb from './Breadcrumb.vue'

const { Layout } = DefaultTheme
const { page } = useData()

// Current docs area, derived from the route. Drives the contextual brand pill
// and an `ds-area-*` hook on the layout root that CSS uses to scope chrome
// (e.g. GitHub shows only in the developer area). Computed from useData() so it
// is correct during SSR — no client-side flash.
const area = computed(() => {
  const p = '/' + page.value.relativePath
  if (p.startsWith('/developer/')) return 'developer'
  if (p.startsWith('/guide/') || p.startsWith('/getting-started/')) return 'guide'
  return 'home'
})
const pill = computed(() =>
  ({ developer: 'DEV', guide: 'GUIDES', home: 'DOCS' })[area.value],
)
</script>

<template>
  <!-- display:contents → pure class hook, zero layout impact -->
  <div :class="`ds-area-${area}`" style="display: contents">
    <Layout>
      <template #nav-bar-title-after>
        <span class="ds-pill">{{ pill }}</span>
      </template>
      <template #doc-before>
        <Breadcrumb />
      </template>
    </Layout>
  </div>
</template>

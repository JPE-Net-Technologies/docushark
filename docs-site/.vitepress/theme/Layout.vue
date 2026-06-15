<script setup lang="ts">
import { computed } from 'vue'
import DefaultTheme from 'vitepress/theme'
import { useData } from 'vitepress'
import Breadcrumb from './Breadcrumb.vue'

const { Layout } = DefaultTheme
const { page } = useData()

// Contextual brand pill next to the logo: DOCS on home, GUIDES in the guide
// area, DEV in the developer area.
const pill = computed(() => {
  const p = '/' + page.value.relativePath
  if (p.startsWith('/developer/')) return 'DEV'
  if (p.startsWith('/guide/') || p.startsWith('/getting-started/')) return 'GUIDES'
  return 'DOCS'
})
</script>

<template>
  <Layout>
    <template #nav-bar-title-after>
      <span class="ds-pill">{{ pill }}</span>
    </template>
    <template #doc-before>
      <Breadcrumb />
    </template>
  </Layout>
</template>

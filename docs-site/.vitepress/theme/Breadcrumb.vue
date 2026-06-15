<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import { useSidebar } from 'vitepress/theme'

const { page, theme } = useData()
const { sidebarGroups } = useSidebar()

// "Docs / <Area> / <Group> / <Here>" — derived from the resolved sidebar so it
// stays in sync with config.mts without a parallel IA table.
const area = computed(() => {
  const p = '/' + page.value.relativePath
  if (p.startsWith('/developer/')) return { label: 'Developer', link: '/developer/architecture' }
  if (p.startsWith('/guide/') || p.startsWith('/getting-started/'))
    return { label: 'Guides', link: '/getting-started/introduction' }
  return null
})

// Walk the resolved sidebar groups to find the group whose item matches the
// current page, plus that item's title.
const trail = computed(() => {
  const rel = page.value.relativePath.replace(/(index)?\.md$/, '')
  for (const group of sidebarGroups.value) {
    for (const item of group.items ?? []) {
      const link = (item.link ?? '').replace(/^\//, '').replace(/(index)?$/, '')
      if (link && rel.startsWith(link)) {
        return { group: group.text ?? '', title: item.text ?? page.value.title }
      }
    }
  }
  return { group: '', title: page.value.title }
})
</script>

<template>
  <nav v-if="area" class="ds-breadcrumb" aria-label="Breadcrumb">
    <a href="/">Docs</a>
    <span class="sep">/</span>
    <a :href="area.link">{{ area.label }}</a>
    <template v-if="trail.group">
      <span class="sep">/</span>
      <span>{{ trail.group }}</span>
    </template>
    <span class="sep">/</span>
    <span class="here">{{ trail.title }}</span>
  </nav>
</template>

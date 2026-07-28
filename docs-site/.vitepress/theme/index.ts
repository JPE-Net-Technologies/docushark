import type { Theme } from 'vitepress'
import { useRoute } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { theme as openapiTheme, useOpenapi } from 'vitepress-openapi/client'
import { nextTick, onMounted, watch } from 'vue'
import mediumZoom from 'medium-zoom'
import Layout from './Layout.vue'
import Home from './Home.vue'
import RegionSelector from './RegionSelector.vue'

// Self-hosted JetBrains Mono (offline-safe — bundled by Vite, no network at
// runtime). Inter is already shipped by VitePress's default theme.
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'

import './theme.css'
import 'vitepress-openapi/dist/style.css'

// public/openapi.yaml is a copy of relay/docs/api/openapi.yaml (the source of
// truth) — a drift-guard test keeps them in sync. Loaded as a raw string
// since vitepress-openapi's `spec` accepts YAML text directly, no JSON
// conversion needed.
import openapiSpec from '../../public/openapi.yaml?raw'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('Home', Home)
    app.component('RegionSelector', RegionSelector)
    useOpenapi({ spec: openapiSpec })
    openapiTheme.enhanceApp({ app })
  },
  // Click-to-zoom on content images/screenshots (medium-zoom). VitePress is an
  // SPA, so re-apply after each client-side route change once the DOM settles.
  // The overlay background follows the active theme via the VitePress token.
  setup() {
    const route = useRoute()
    const applyZoom = () =>
      mediumZoom('.vp-doc img', { background: 'var(--vp-c-bg)', margin: 24 })
    onMounted(applyZoom)
    watch(
      () => route.path,
      () => nextTick(applyZoom),
    )
  },
} satisfies Theme

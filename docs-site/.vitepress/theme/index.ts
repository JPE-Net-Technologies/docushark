import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { theme as openapiTheme, useOpenapi } from 'vitepress-openapi/client'
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
} satisfies Theme

/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import pkg from './package.json';

// Tauri sets TAURI_ENV_PLATFORM (and the older TAURI_PLATFORM) when it invokes
// the renderer build via its beforeBuildCommand. Desktop uses the Tauri updater,
// not a service worker, so the PWA plugin is disabled for those builds.
const isTauriBuild =
  process.env.TAURI_ENV_PLATFORM != null || process.env.TAURI_PLATFORM != null;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Web-only: no SW in the Tauri renderer. When disabled the plugin still
      // exports a no-op `virtual:pwa-register`, so registerPwa() is safe to call
      // unconditionally from main.tsx.
      disable: isTauriBuild,
      // Soft update: surface a "new version — Reload" prompt rather than
      // skipWaiting, so a live collab session is never yanked mid-edit.
      registerType: 'prompt',
      // Never run the SW in `bun run dev`.
      devOptions: { enabled: false },
      includeAssets: ['favicon-32x32.png', 'favicon-16x16.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'DocuShark',
        short_name: 'DocuShark',
        description: 'High-performance diagramming and whiteboard editor.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#2196f3',
        icons: [
          { src: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the executable app shell + fonts only. The main chunk is
        // ~2 MB pre code-splitting (JP-99); raise the cap so the shell
        // precaches now. The icon-library SVG/PNG sets and nspell dictionaries
        // are on-demand features (loaded on first use), not shell — excluding
        // them keeps the install slim; they're fetched from network when used.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,woff,woff2}'],
        globIgnores: ['**/dictionaries/**', '**/icons/**'],
        // SPA fallback, but never serve relay/control-plane routes from cache.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/oembed/, /^\/\.well-known/],
        // Doc data syncs over WebSocket (which SWs can't intercept) and REST to
        // the relay; we deliberately add no runtime caching for those.
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Build-time platform flag for tree-shaking Tauri impls out of PWA
    // bundles. Tauri sets TAURI_ENV_PLATFORM (and the older TAURI_PLATFORM)
    // when invoking the renderer build; treat either as desktop.
    __IS_TAURI__: JSON.stringify(isTauriBuild),
  },
  server: {
    watch: {
      ignored: ['**/src-tauri/target/**', '**/docs-site/**', '**/NEW-ICONS/**', '**/dist/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Main chunk is ~950 KB after JP-99 code-splitting (down from ~2.1 MB);
    // the heavy features (tiptap editor, PDF export/jspdf, katex, nspell) now
    // load on demand. Budget at 1 MB so a regression that pulls a big dep back
    // into the entry graph re-triggers the warning. (Font data chunks ~550 KB
    // sit comfortably under this.)
    chunkSizeWarningLimit: 1000,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});

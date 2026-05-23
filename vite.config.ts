/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import pkg from './package.json';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Build-time platform flag for tree-shaking Tauri impls out of PWA
    // bundles. Tauri sets TAURI_ENV_PLATFORM (and the older TAURI_PLATFORM)
    // when invoking the renderer build; treat either as desktop.
    __IS_TAURI__: JSON.stringify(
      process.env.TAURI_ENV_PLATFORM != null || process.env.TAURI_PLATFORM != null,
    ),
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
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [],
  },
});

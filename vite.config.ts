import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['node-pty'],
            },
          },
        },
      },
      {
        entry: 'electron/agent-worker.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['node-pty'],
              // The worker entry is asarUnpack'd (worker_threads use a vanilla Node module
              // loader). Inline every dynamic import into this single file so the unpacked
              // agent-worker.js is self-contained: otherwise Rollup emits sibling chunks
              // (e.g. the unpdf lazy chunk) that stay inside app.asar and the unpacked worker's
              // relative require("./index-*.js") cannot resolve them in packaged builds.
              output: { format: 'cjs', inlineDynamicImports: true },
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart({ reload }) {
          reload()
        },
      },
    ]),
    renderer(),
  ],
  build: {
    outDir: 'dist',
  },
})

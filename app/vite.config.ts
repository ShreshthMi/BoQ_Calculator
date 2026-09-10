import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The pipeline lives outside this folder and is shared with the CLI, so the dev
// server needs read access to the workspace root. Nothing here is node-specific:
// demo/src/node-io.ts is the only module that touches the filesystem and the app
// never imports it.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
})

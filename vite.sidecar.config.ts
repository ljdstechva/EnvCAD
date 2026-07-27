import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'desktop/sidecarWorker.ts',
      formats: ['cjs'],
      fileName: () => 'sidecarWorker.cjs'
    },
    sourcemap: false
  }
})

import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'desktop/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.cjs'
    },
    sourcemap: false
  }
})

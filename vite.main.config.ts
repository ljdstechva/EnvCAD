import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'desktop/main.ts',
      formats: ['cjs'],
      fileName: () => 'main.cjs'
    },
    sourcemap: false
  }
})

/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('three')) return 'vendor-three'
          if (id.includes('@mlightcad') || id.includes('@mlightcad/data-model')) return 'vendor-mlightcad'
          if (id.includes('jspdf') || id.includes('svg2pdf') || id.includes('html2canvas')) return 'vendor-pdf'
          return 'vendor'
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    include: [
      'test/**/*.test.ts',
      'sidecar/src/**/*.test.ts',
      'src/agent/**/*.test.ts',
      'src/geo/**/*.test.ts',
      'src/symbols/**/*.test.ts',
      'src/sheet/__tests__/**/*.test.ts',
      'src/sheet/**/__tests__/**/*.test.ts'
    ],
    server: {
      deps: {
        inline: [/@mlightcad/]
      }
    }
  }
})

/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
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

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('three')) return 'vendor-three'
          if (id.includes('@mlightcad')) return 'vendor-mlightcad'
          if (id.includes('jspdf') || id.includes('svg2pdf') || id.includes('html2canvas')) {
            return 'vendor-pdf'
          }
          return 'vendor'
        }
      }
    }
  }
})

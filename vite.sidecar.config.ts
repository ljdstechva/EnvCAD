import { defineConfig } from 'vite'

export default defineConfig({
  // `ws` probes for optional native acceleration packages at module load.
  // They are intentionally not installed, but Rollup turns those guarded
  // requires into empty module stubs instead of throwing MODULE_NOT_FOUND.
  // Force the documented JavaScript fallbacks so the first masked renderer
  // frame cannot call a missing `bufferutil.unmask` export.
  define: {
    'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
    'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1')
  },
  build: {
    lib: {
      entry: 'desktop/sidecarWorker.ts',
      formats: ['cjs'],
      fileName: () => 'sidecarWorker.cjs'
    },
    sourcemap: false
  }
})

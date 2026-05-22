import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Heavy dependencies are split into separate chunks so the main entry
// chunk stays small. The browser parallelizes downloads + caches each
// chunk independently across releases (changing one chart doesn't
// invalidate the recharts bundle). Numbers as of v0.3:
//   recharts ~5 MB raw → ~100 KB gzipped, lazy-able across views
//   jszip ~600 KB raw → only loaded on Download → ZIP
//   html-to-image ~400 KB raw → only loaded on Download → PNG
//   react-markdown + remark-gfm ~600 KB raw → only loaded on AI Analysis
// transformers.js (Whisper) is already a separate ~900 KB chunk
// because it's dynamic-imported from the few callsites that use it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'recharts': ['recharts'],
          'icons': ['lucide-react'],
          'markdown': ['react-markdown', 'remark-gfm'],
          'export-tools': ['jszip', 'html-to-image'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8765',
    },
  },
})

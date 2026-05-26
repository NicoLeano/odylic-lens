// Vitest config — separate from vite.config.ts so the production build
// (`tsc -b && vite build`) never sees the `test` block. Mirrors the vite
// config's react + tailwind plugins for parity in test rendering.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // The live demo (`npm run build:demo`, mode "demo") is a static site that may be served from any folder, such as
  // https://<user>.github.io/<repo>/, so its files are found relative to the page instead of from the site's root.
  // The switch that turns the demo on is set here, not in an ".env.demo" file: such files are usually git-ignored, and a
  // demo built without its switch would quietly be the ordinary app.
  ...(mode === 'demo' ? { base: './', build: { outDir: 'dist-demo' }, define: { 'import.meta.env.VITE_DEMO': JSON.stringify('true') } } : {}),
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
}))

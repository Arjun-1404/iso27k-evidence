import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// What a link to the live demo looks like when it is pasted into LinkedIn, Slack or a message: a picture and a line of text.
// Those sites need the picture's full web address, so the demo's own address is given here (a fork changes it with
// VITE_DEMO_SITE_URL). Only the demo build gets this; the real app is not a public page and has no use for it.
const DEMO_SITE_URL = (process.env.VITE_DEMO_SITE_URL || 'https://arjun-1404.github.io/iso27k-evidence/').replace(/\/*$/, '/')
const SHARE_CARD = 'share-card.png'

function demoShareCard(): Plugin {
  return {
    name: 'demo-share-card',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { property: 'og:url', content: DEMO_SITE_URL }, injectTo: 'head' },
      { tag: 'meta', attrs: { property: 'og:image', content: DEMO_SITE_URL + SHARE_CARD }, injectTo: 'head' },
      { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' }, injectTo: 'head' },
      { tag: 'meta', attrs: { property: 'og:image:height', content: '630' }, injectTo: 'head' },
      { tag: 'meta', attrs: { property: 'og:image:alt', content: 'The ISO 27001 evidence portal dashboard: a readiness ring, what needs attention, and a tile for every control.' }, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' }, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'twitter:image', content: DEMO_SITE_URL + SHARE_CARD }, injectTo: 'head' },
    ],
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: SHARE_CARD, source: readFileSync(fileURLToPath(new URL('./demo-assets/' + SHARE_CARD, import.meta.url))) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'demo' ? [demoShareCard()] : [])],
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

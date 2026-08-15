import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png'],
      workbox: {
        // The wasm decoder must be precached: without it, offline receiving
        // fails outright on every browser that lacks BarcodeDetector (iOS Safari
        // included), which is the majority of receivers.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2}'],
        // The PDF renderer is 2.5MB and only matters when a PDF actually
        // arrives, so it is fetched on demand and cached from then on rather
        // than tripling what every user downloads up front. Receiving, decoding
        // and downloading all work offline regardless; only the first PDF
        // *preview* needs a network.
        // The iOS launch images are ~940KB across 42 files that only Safari ever
        // requests, once, at add-to-home-screen time — and iOS holds its own copy
        // from then on. Precaching them would put that on every user, Android
        // included, for no offline benefit.
        // og.png is fetched by link-preview crawlers and never by the app, so
        // precaching it would put 40KB on every user for nothing.
        globIgnores: ['**/pdf*.{js,mjs}', 'splash/**', 'og.png'],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/pdf.*\.(?:js|mjs)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdf-renderer',
              expiration: { maxEntries: 4 },
            },
          },
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'QR Sender',
        short_name: 'QR Sender',
        description: 'Air-gapped file transfer over a screen-to-camera optical channel.',
        theme_color: '#0e0e11',
        background_color: '#0e0e11',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Separate art, not the same file twice: a maskable icon can be cropped
          // to a circle of 80% diameter, which clips the corner finder patterns
          // off the `any` variant. See scripts/make-icons.mjs.
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // The decode pool declares `type: 'module'` workers, so the worker output
  // format has to match rather than defaulting to IIFE.
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        // `fidelity` is the on-device decoder check (SP-A). It ships with the
        // app so it can be opened on a borrowed phone or a remote device lab
        // from the same URL, with no separate deploy.
        main: 'index.html',
        fidelity: 'fidelity.html',
      },
    },
  },
});

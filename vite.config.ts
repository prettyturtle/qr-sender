import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      workbox: {
        // The wasm decoder must be precached: without it, offline receiving
        // fails outright on every browser that lacks BarcodeDetector (iOS Safari
        // included), which is the majority of receivers.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2}'],
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
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
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

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Installable web app: "Install UpNotice" from the browser on phone/PC, works offline for reading.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'UpNotice',
        short_name: 'UpNotice',
        description: 'Company announcements and meetings, by Upright Solutions',
        theme_color: '#4f46e5',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell is precached. Only the everyday reading endpoints are kept as an offline fallback (for one day);
        // people lists, reports, the activity log, files and anything under /api/auth are never cached, and the
        // app clears this cache at sign-out.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) =>
              request.method === 'GET' && /^\/api\/(announcements(\/\d+|\/categories)?|meetings(\/\d+)?|notifications|dashboard|companies|departments)$/.test(url.pathname),
            handler: 'NetworkFirst',
            options: { cacheName: 'upnotice-api', networkTimeoutSeconds: 8, expiration: { maxEntries: 100, maxAgeSeconds: 24 * 3600 } },
          },
        ],
      },
      // Electron (file://) and Capacitor register nothing; only real http(s) pages get the service worker.
      devOptions: { enabled: false },
    }),
  ],
  // Relative asset paths so the same build works in the browser, inside Electron (file://) and Capacitor.
  base: './',
  // Dev mode uses the SAME address as Docker/production: http://localhost:4000.
  // Vite serves the UI on 4000 and forwards /api to the dev API server on 4001.
  server: {
    port: 4000,
    strictPort: true,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:4001', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  // Pre-bundle these up front so the dev server never serves a stale dependency cache
  // (which shows up as a blank page after new packages are installed).
  optimizeDeps: {
    include: ['@capacitor/core', '@capacitor/local-notifications', '@capacitor/push-notifications', 'react', 'react-dom'],
  },
});

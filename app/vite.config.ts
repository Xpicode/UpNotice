import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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

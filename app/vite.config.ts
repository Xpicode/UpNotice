import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the same build works in the browser, inside Electron (file://) and Capacitor.
  base: './',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  // Pre-bundle these up front so the dev server never serves a stale dependency cache
  // (which shows up as a blank page after new packages are installed).
  optimizeDeps: {
    include: ['@capacitor/core', '@capacitor/local-notifications', '@capacitor/push-notifications', 'react', 'react-dom'],
  },
});

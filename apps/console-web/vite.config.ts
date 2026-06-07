import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Served by the Clementine daemon at /console — see
// src/dashboard/console-spa.ts. Base path is kept as /console/ so the
// Electron window URL, /console/icon.png, and /console/vendor/* all
// keep resolving exactly as the legacy console did.
export default defineConfig({
  base: '/console/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Never inline assets as data: URIs — the daemon CSP only allows
    // fonts/scripts from 'self', so an inlined data: font is blocked.
    // Keeping every font/asset as a real file under /console/assets/
    // keeps everything CSP-clean.
    assetsInlineLimit: 0,
  },
  // Dev: `npm run dev` serves at http://127.0.0.1:5174/console/ and
  // proxies API + shared asset paths straight to the local daemon so the
  // SPA talks to the real backend. Auth in dev uses VITE_CLEM_TOKEN
  // (appended as ?token= by lib/api.ts); in the packaged app the session
  // cookie handles auth same-origin.
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8420',
      '/dashboard': 'http://127.0.0.1:8420',
      '/console/vendor': 'http://127.0.0.1:8420',
      '/console/icon.png': 'http://127.0.0.1:8420',
    },
  },
});

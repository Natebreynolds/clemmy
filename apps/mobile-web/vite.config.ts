import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const here = path.dirname(fileURLToPath(import.meta.url));

// Served by the Clementine daemon at /m/ — see src/channels/mobile-routes.ts.
// All assets resolve relative to that mount.
// Dev proxy target: the daemon's port (CLEM_DEV_DAEMON_PORT, same knob as console-web).
const devDaemon = `http://127.0.0.1:${process.env.CLEM_DEV_DAEMON_PORT ?? '8420'}`;

export default defineConfig({
  base: '/m/',
  plugins: [preact()],
  resolve: {
    alias: {
      // Source-consumed shared package (no publish step): the chat transport +
      // presentation engine shared with the desktop console.
      '@clem/chat-engine': path.resolve(here, '../../packages/chat-engine/src/index.ts'),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Disable the random hash suffix on the service worker so the
    // daemon can serve it at a stable path. Other assets keep hashes
    // for cache busting.
    rollupOptions: {
      input: {
        main: 'index.html',
        sw: 'src/sw.ts',
      },
      output: {
        entryFileNames: (chunk) => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // The dev server proxies /m/auth and /m/api straight to the local
  // daemon so an `npm run dev` against http://localhost:5173 still
  // talks to the real backend.
  server: {
    port: 5173,
    proxy: {
      '/m/auth': devDaemon,
      '/m/api': devDaemon,
      '/api/console': devDaemon,
    },
  },
});

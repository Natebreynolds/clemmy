import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Served by the Clementine daemon at /m/ — see src/channels/mobile-routes.ts.
// All assets resolve relative to that mount.
export default defineConfig({
  base: '/m/',
  plugins: [preact()],
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
      '/m/auth': 'http://127.0.0.1:8420',
      '/m/api': 'http://127.0.0.1:8420',
      '/api/console': 'http://127.0.0.1:8420',
    },
  },
});

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import { execSync } from 'node:child_process'

/**
 * Kurzer Commit-Hash, damit ein Build eindeutig zuordenbar ist.
 * `OMEGA_COMMIT` hat Vorrang, damit auch ein Build außerhalb des Repos
 * (oder in einer CI ohne Git-Historie) einen sinnvollen Stempel bekommt.
 */
function gitCommit(): string {
  if (process.env.OMEGA_COMMIT) return process.env.OMEGA_COMMIT
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
    __BUILD_COMMIT__: JSON.stringify(gitCommit()),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'OMEGA Atelier 2.0',
        short_name: 'OMEGA',
        start_url: '/',
        display: 'standalone',
        background_color: '#070810',
        lang: 'de',
        scope: '/',
        description:
          'Smart-Home Atelier — interaktive Grundriss- und 3D-Planung mit 30+ Ökosystemen',
        theme_color: '#070810',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        categories: ['productivity', 'lifestyle', 'utilities'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Ship-shape precache: code + shell + icons only. The heavy media
        // (GLB models, PBR textures, promo video) stays out of the precache and
        // is served with long-lived HTTP caching by vercel.json instead.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          router: ['react-router-dom'],
          three: ['three'],
          state: ['zustand'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
})

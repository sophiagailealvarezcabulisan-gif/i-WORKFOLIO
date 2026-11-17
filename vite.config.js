
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),

    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',

      manifest: {
        name: 'i-WORKFOLIO',
        short_name: 'i-WORKFOLIO',
        description: 'Digital E-Portfolio Application for Grade 12 Work Immersion',
        theme_color: '#000000',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        orientation: 'any',

        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },

    workbox: {
  maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,

  globPatterns: [
    '**/*.{js,css,html,ico,png,jpg,jpeg,webp,svg,woff2,json,pdf,docx}'
  ],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/(rest|auth|storage|functions)\/v1(?:\/|$)/],
        cleanupOutdatedCaches: true,

        runtimeCaching: [
          {
            // Portfolio photos and avatars, so they still appear offline.
            urlPattern: /\/storage\/v1\/object\/(?:public|sign)\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'portfolio-images',
              matchOptions: { ignoreSearch: true },
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 60 * 60 * 24 * 30
              },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ]
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = Number(process.env.CALIBER_API_PORT ?? 8787)
const target = `http://127.0.0.1:${API_PORT}`

// The browser only ever talks to Vite's origin; /api and /assets are proxied
// to the local server so .spz/.glb/.mp3/.mp4 load same-origin (no CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target },
      '/assets': { target },
      '/exports': { target },
    },
  },
})

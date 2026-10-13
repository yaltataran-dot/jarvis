import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // IPv4 loopback, stated. Left to resolve "localhost", Node binds ::1 only,
    // and VPN clients with IPv6 leak protection block ::1 along with the rest
    // of IPv6 — the page then refuses to open while the VPN is on. Browsers
    // still reach this through http://localhost by falling back to 127.0.0.1,
    // and it stays loopback-only, never the LAN.
    host: '127.0.0.1',
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})

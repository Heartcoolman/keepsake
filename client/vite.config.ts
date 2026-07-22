import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The strict CSP shipped in index.html would break Vite's dev-only React Fast Refresh
 * preamble (an inline <script>) and HMR websockets. Strip the meta only while serving in
 * dev; the production build keeps it intact.
 */
function stripCspInDev(): Plugin {
  return {
    name: 'nianxiang:strip-csp-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), stripCspInDev()],
  esbuild: {
    // Strip noisy diagnostic logging from production bundles while keeping console.error.
    pure: ['console.debug', 'console.info', 'console.log', 'console.warn'],
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});

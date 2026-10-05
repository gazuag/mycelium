import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildSecurityHeaders } from './scripts/security-headers';

function cloudflareSecurityHeaders(): Plugin {
  let headers: string;

  return {
    name: 'cloudflare-security-headers',
    apply: 'build',
    configResolved(config) {
      const env = { ...loadEnv(config.mode, config.envDir, ''), ...process.env };
      const meteredDomain = env.VITE_METERED_APP_DOMAIN;
      if (!meteredDomain?.trim()) {
        throw new Error('Cloudflare security headers: VITE_METERED_APP_DOMAIN is required.');
      }

      const signalOrigins = ['wss://discover.unfilter.ing:8443'];
      const extraSignalOrigin = env.VITE_EXTRA_SIGNAL_ORIGIN?.trim();
      if (extraSignalOrigin) signalOrigins.push(extraSignalOrigin);

      headers = buildSecurityHeaders({
        signalOrigins,
        meteredDomain,
        enforce: env.VITE_CSP_ENFORCE === 'true'
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: headers });
    }
  };
}

export default defineConfig({
  plugins: [react(), cloudflareSecurityHeaders()],
  server: {
    host: 'localhost',
    port: 8080
  }
});

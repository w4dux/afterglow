import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Strict CSP for the packaged app (file://). Dev server needs inline/eval for HMR.
function csp(): Plugin {
  return {
    name: 'afterglow-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob: afterglow-media:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; ');
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), csp()],
  build: { outDir: 'dist/renderer', emptyOutDir: true, target: 'chrome130', assetsInlineLimit: 0 },
  server: { port: 5199, strictPort: true },
});

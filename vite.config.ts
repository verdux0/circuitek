import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run build`        -> dist/ (static folder, serve it locally or from any sub-path: base is relative)
// `npm run build:single` -> dist-single/index.html (one self-contained file)
// `npm run dev:phone`    -> dev server on the local network over HTTPS (self-signed certificate),
//                           so secure-context APIs work when opened from a phone by IP.
export default defineConfig(({ mode }) => ({
  base: './',
  // The font library (public/fonts, ~28 MB) is served next to dist/; the single-file build keeps
  // only the 7 base fonts bundled in fonts.ts, so it does not copy public/ at all.
  publicDir: mode === 'single' ? false : 'public',
  plugins: [
    ...(mode === 'single' ? [viteSingleFile()] : []),
    ...(mode === 'phone' ? [basicSsl({ name: 'circuitek-dev' })] : []),
  ],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
  },
  worker: { format: 'iife' },
  test: { environment: 'node', include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'] },
}));

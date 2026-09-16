import { defineConfig } from 'vite';

export default defineConfig({
  // maplibre-gl v6 ships ESM-only (no UMD/CommonJS entry), which bundlers pick up
  // automatically. This app has no SSR, so the `ssr.noExternal: ['maplibre-gl']`
  // workaround from the MapLibre docs is not needed here.
  build: {
    // WebGL2 is required by maplibre-gl v6, so targeting a modern baseline is safe.
    target: 'es2023',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * Dev harness only. Renders the popup and options UI in a normal browser tab
 * against fixture data, so the UI can be built and tested without reloading an
 * unpacked extension. This config never produces the shipped extension -
 * see scripts/build.mjs for that.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/ui/harness'),
  plugins: [svelte({ configFile: resolve(import.meta.dirname, 'svelte.config.js') })],
  server: { host: '127.0.0.1', port: 5177, strictPort: true },
  preview: { host: '127.0.0.1', port: 5177, strictPort: true },
  build: {
    outDir: resolve(import.meta.dirname, 'dist-harness'),
    emptyOutDir: true,
    target: 'es2022',
  },
});

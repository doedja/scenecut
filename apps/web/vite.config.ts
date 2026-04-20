import { defineConfig } from 'vite';

// Cloudflare Pages serves at the site root, so '/' is the correct base.
// Override with VITE_BASE_PATH=/scenecut/ if you ever move to GitHub Pages on a subpath.
const base = process.env.VITE_BASE_PATH || '/';

export default defineConfig({
  base,
  server: {
    port: 5173,
    fs: {
      // Allow Vite to serve files from outside apps/web (for workspace packages).
      allow: ['../..']
    }
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0
  },
  optimizeDeps: {
    // These packages are under workspace; let Vite serve them on-the-fly from source.
    exclude: ['@doedja/scenecut-core', '@doedja/scenecut-web']
  }
});

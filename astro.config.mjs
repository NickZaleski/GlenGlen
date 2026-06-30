import { defineConfig } from 'astro/config';

export default defineConfig({
  // Production URL — used for canonical links, social tags, and sitemaps.
  site: 'https://glen-glen.vercel.app',
  // Static site output. Build artifacts go to ./dist
  output: 'static',
});

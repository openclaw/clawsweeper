import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'auto' },
  vite: { plugins: [tailwindcss()] },
  server: { host: '127.0.0.1' },
});

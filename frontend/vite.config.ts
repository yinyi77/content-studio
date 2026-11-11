import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { viteTailwindReferencePlugin } from './scripts/tailwind-reference.ts';

export default defineConfig({
  base: '/admin/',
  plugins: [vue(), viteTailwindReferencePlugin(), tailwindcss()],
  resolve: { conditions: ['production', 'browser', 'module'] },
  define: { __VUE_I18N_FULL_INSTALL__: true, __VUE_I18N_LEGACY_API__: false, __INTLIFY_PROD_DEVTOOLS__: false },
  server: {
    proxy: Object.fromEntries(
      ['/legacy', '/api', '/app.js', '/style-catalog.js', '/styles.css', '/professional.css']
        .map(route => [route, { target: process.env.VBEN_BACKEND_URL || 'http://127.0.0.1:4318' }]),
    ),
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1600 },
});

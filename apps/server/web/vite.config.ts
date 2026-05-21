import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../../package.json';

export default defineConfig({
  server: {
    port: 3000,
    host: '127.0.0.1',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@task-view/shared': path.resolve(__dirname, '../../../packages/shared'),
      '@task-view/ui': path.resolve(__dirname, '../../../packages/ui'),
      '@task-view/schemas': path.resolve(__dirname, '../../../packages/schemas'),
    }
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

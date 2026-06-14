import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const desktopSidecarPort = process.env.TAGMA_DESKTOP_SIDECAR_PORT ?? '3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, 'src') + '/',
    },
  },
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${desktopSidecarPort}`,
    },
  },
});

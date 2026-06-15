import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function positivePortFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const desktopRendererPort = positivePortFromEnv('TAGMA_DESKTOP_RENDERER_PORT', 5173);
const desktopSidecarPort = process.env.TAGMA_DESKTOP_SIDECAR_PORT ?? '3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, 'src') + '/',
    },
  },
  server: {
    port: desktopRendererPort,
    proxy: {
      '/api': `http://127.0.0.1:${desktopSidecarPort}`,
    },
  },
});

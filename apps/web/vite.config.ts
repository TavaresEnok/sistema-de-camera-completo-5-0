import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { sourceCreditPlugin, creditedAssetFileNames } from './build/source-credit.mjs';

export default defineConfig(async () => {
  const { default: tailwindcss } = await import('@tailwindcss/vite');
  // Identifica exatamente os arquivos gerados neste build. Abas que ficaram
  // abertas durante um deploy usam este valor para perceber que o servidor já
  // publicou outra interface e recarregar antes de misturar chunks antigos e
  // novos (por exemplo, o player antigo pedindo o perfil reduzido no mapa).
  const frontendBuildId = process.env.VITE_FRONTEND_BUILD_ID?.trim()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    plugins: [
      react(),
      tailwindcss(),
      sourceCreditPlugin(),
      {
        name: 's2cam-frontend-version',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'frontend-version.json',
            source: `${JSON.stringify({ buildId: frontendBuildId })}\n`,
          });
        },
      },
    ],
    define: {
      __S2CAM_FRONTEND_BUILD_ID__: JSON.stringify(frontendBuildId),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
    },
    build: {
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          assetFileNames: creditedAssetFileNames,
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@radix-ui') || id.includes('cmdk') || id.includes('vaul')) {
              return 'vendor-ui';
            }
            if (id.includes('recharts') || id.includes('d3-')) {
              return 'vendor-charts';
            }
            if (id.includes('hls.js')) {
              return 'vendor-hls';
            }
            if (id.includes('mpegts.js')) {
              return 'vendor-mpegts';
            }
            // Renderização vetorial do mapa: é carregada só ao abrir /map.
            // Sem este chunk isolado, MapLibre (~800 KB) cairia no vendor-core
            // e pesaria o login, Ao Vivo e todas as telas que não usam mapa.
            if (id.includes('maplibre-gl') || id.includes('maplibre-gl-leaflet')) {
              return 'vendor-maplibre';
            }
            if (id.includes('lucide-react') || id.includes('react-icons')) {
              return 'vendor-icons';
            }
            if (id.includes('@tanstack/react-query') || id.includes('wouter') || id.includes('zustand')) {
              return 'vendor-state-router';
            }
            if (id.includes('axios') || id.includes('date-fns') || id.includes('framer-motion')) {
              return 'vendor-utils-motion';
            }
            return 'vendor-core';
          },
        },
      },
    },
  };
});

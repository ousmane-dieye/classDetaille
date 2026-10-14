import swc from 'unplugin-swc';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// La condition « source » fait lire le TypeScript de packages/shared directement (voir son package.json).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: { environment: 'node' },
});

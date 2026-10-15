import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { devServerOptions } from './scripts/dev-server';

// Cookies `__Host-` (`Secure`) : développement en HTTPS, `/api` proxyfié vers l'API (§ 3.1, § 3.4).
export default (async () =>
  defineConfig({
    plugins: [react()],
    server: await devServerOptions(),
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['src/**/*.spec.{ts,tsx}', 'scripts/**/*.spec.ts'],
    },
  }))();

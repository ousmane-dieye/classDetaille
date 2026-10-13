import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { extends: 'apps/api/vitest.config.ts', test: { name: 'unit', include: ['apps/api/src/**/*.spec.ts', 'apps/api/test/architecture/**/*.spec.ts', 'packages/**/src/**/*.spec.ts'] } },
      { extends: 'apps/api/vitest.config.ts', test: { name: 'integration', include: ['apps/api/test/integration/**/*.int.spec.ts'], globalSetup: ['apps/api/test/support/global-setup.ts'], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false } },
    ],
  },
});

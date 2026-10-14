import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/shared/src/**/*.ts', 'apps/api/src/modules/authz/**/*.ts'],
      exclude: ['**/*.spec.ts'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
    projects: [
      { extends: 'apps/api/vitest.config.ts', test: { name: 'unit', include: ['apps/api/src/**/*.spec.ts', 'apps/api/test/architecture/**/*.spec.ts', 'packages/**/src/**/*.spec.ts'] } },
      { extends: 'apps/api/vitest.config.ts', test: { name: 'integration', include: ['apps/api/test/integration/**/*.int.spec.ts'], globalSetup: ['apps/api/test/support/global-setup.ts'], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false } },
      'apps/web',
    ],
  },
});

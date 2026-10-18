import { defineConfig } from 'vitest/config';

const special = ['**/*.int.test.ts', '**/*.isolation.test.ts', '**/*.residency.test.ts', '**/*.contract.test.ts'];
const ignore = ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/cdk.out/**', 'apps/web/e2e/**'];

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['**/*.test.ts'], exclude: [...ignore, ...special], environment: 'node' } },
      {
        test: {
          name: 'integration',
          include: ['**/*.int.test.ts'],
          exclude: ignore,
          globalSetup: ['./tools/test/global-db-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'isolation',
          include: ['**/*.isolation.test.ts'],
          exclude: ignore,
          globalSetup: ['./tools/test/global-db-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'residency',
          include: ['**/*.residency.test.ts'],
          exclude: ignore,
          globalSetup: ['./tools/test/global-db-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'contract',
          include: ['**/*.contract.test.ts'],
          exclude: ignore,
          globalSetup: ['./tools/test/global-db-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});

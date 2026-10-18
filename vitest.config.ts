import { defineConfig } from 'vitest/config';

const special = ['**/*.int.test.ts', '**/*.isolation.test.ts', '**/*.residency.test.ts', '**/*.contract.test.ts'];
const roots = (suffix: string) => ['{apps,packages}/*/{src,test}/**/*' + suffix, 'infra/test/**/*' + suffix, 'scripts/test/**/*' + suffix, 'tools/*/test/**/*' + suffix];
const ignore = ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/cdk.out/**', 'apps/web/e2e/**'];

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: roots('.test.ts'), exclude: [...ignore, ...special], environment: 'node' } },
      {
        test: {
          name: 'integration',
          include: roots('.int.test.ts'),
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
          include: roots('.isolation.test.ts'),
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
          include: roots('.residency.test.ts'),
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
          include: roots('.contract.test.ts'),
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

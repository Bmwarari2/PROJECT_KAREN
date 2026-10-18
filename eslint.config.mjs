import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import noHardcodedUiStrings from './tools/eslint/no-hardcoded-ui-strings.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/cdk.out/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/web/next-env.d.ts',
      'apps/web/public/sw.js',
      'packages/sdk/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['apps/web/**/*.tsx', 'packages/ui/**/*.tsx'],
    ignores: ['**/*.test.tsx', 'apps/web/e2e/**'],
    plugins: { thapsus: { rules: { 'no-hardcoded-ui-strings': noHardcodedUiStrings } } },
    rules: { 'thapsus/no-hardcoded-ui-strings': 'error' },
  },
  {
    files: ['**/test/**', '**/*.test.ts', 'apps/web/e2e/**', 'scripts/**', 'tools/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);

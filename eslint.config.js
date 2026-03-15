import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'apps/dashboard/public/**',
      'apps/dashboard/next-env.d.ts',
      'infra/**',
    ],
  },
  {
    rules: {
      // Allow unused vars prefixed with _ (common pattern for intentionally unused params)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Allow explicit any in justified cases (Bedrock stream events, etc.) — warn, not error
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow empty catch blocks (common in optional/fallback patterns)
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Allow require() in .cjs files and dynamic imports
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // Dashboard uses React — relax some rules for JSX
  {
    files: ['apps/dashboard/**/*.tsx'],
    rules: {
      // img elements without alt are fine in a dashboard
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Seed/utility scripts — Node globals are fine
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' },
    },
  },
  // Test files can use any patterns they need
  {
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

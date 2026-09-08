// ESLint (flat config) for the whole repo: plain JS in server/ and scripts/, TypeScript + React in app/.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/release/**', 'app/android/**', 'app/ios/**', 'app/dev-dist/**', 'test-data/**', 'Claude outputs/**'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', 'server/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^(req|res|next)$', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['app/electron/**/*.cjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['app/src/**/*.{ts,tsx}', 'app/vite.config.ts', 'app/capacitor.config.ts'],
    extends: [...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  }
);

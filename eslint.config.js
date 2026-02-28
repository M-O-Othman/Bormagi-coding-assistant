// @ts-check
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      'out-test/**',
      'src/__mocks__/**',
      'src/workflow/tests/**',
      '*.config.js',
      '*.config.mjs',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Warn on unused vars but allow underscore-prefixed params
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // Allow explicit any — the codebase uses it in some places
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow require() in test helpers and config files
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];

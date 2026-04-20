import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
    ],
  },
  // TypeScript source files — base rules
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // React editor source — add react-hooks plugin (rules-of-hooks + exhaustive-deps only)
  {
    files: ['apps/editor/src/**/*.tsx', 'apps/editor/src/**/*.ts'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Node.js scripts and server files — add node globals, allow console
  {
    files: [
      'packages/*/scripts/**/*.ts',
      'packages/*/scripts/**/*.js',
      'packages/*/scripts/**/*.mjs',
      'apps/*/scripts/**/*.ts',
      'apps/*/scripts/**/*.js',
      'apps/*/scripts/**/*.mjs',
      'apps/editor/server/**/*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
);

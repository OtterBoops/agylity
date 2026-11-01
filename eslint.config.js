import tsParser from '@typescript-eslint/parser';
import betterTailwindcss from 'eslint-plugin-better-tailwindcss';

export default [
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'better-tailwindcss': betterTailwindcss,
    },
    settings: {
      'better-tailwindcss': {
        entryPoint: 'frontend/src/index.css',
        variables: ['.*Class.*', '.*Classes.*', '.*Color.*', 'LEVEL_STYLE'],
      },
    },
    rules: {
      'better-tailwindcss/enforce-canonical-classes': 'error',
      'better-tailwindcss/enforce-shorthand-classes': 'error',
      'better-tailwindcss/no-deprecated-classes': 'error',
      'better-tailwindcss/no-duplicate-classes': 'error',
      'better-tailwindcss/no-conflicting-classes': 'error',
      'better-tailwindcss/no-unnecessary-whitespace': 'error',
    },
  },
];

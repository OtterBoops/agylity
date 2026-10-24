/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'es5',
  printWidth: 100,
  tabWidth: 2,
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindStylesheet: './frontend/src/index.css',
  tailwindFunctions: ['clsx', 'cn'],
};

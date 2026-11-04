// Kodo patikra (npm run lint): neapibrėžti ir nenaudojami kintamieji, klaidos, kurios pasimatytų tik veikiant programai
import js from '@eslint/js';
import globals from 'globals';

// Naršyklės globalūs vardai, kurie sutampa su programos kintamaisiais (window.viewport, window.toolbar) – kitaip
// pamiršus importą ESLint klaidos neparodytų
const browser = { ...globals.browser };
for (const n of ['viewport', 'toolbar', 'name', 'status', 'event', 'top', 'parent', 'length', 'origin', 'screen']) delete browser[n];

export default [
  { ignores: ['dist/', 'dist-single/', 'release/', 'node_modules/', 'deploy/', 'public/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.mjs', '*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...browser, ...globals.node, __APP_VERSION__: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-cond-assign': ['error', 'except-parens'],
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-misleading-character-class': 'off',
      // BOM / nepertraukiami tarpai CSV ir tekstuose – tyčia
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true }],
    },
  },
];

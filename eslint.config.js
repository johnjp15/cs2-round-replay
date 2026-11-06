// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';

/** Folder boundaries: each zone lists what it must NOT import from. */
const boundaryZones = [
  // src/contracts imports nothing else from src/.
  { target: './src/contracts', from: './src', except: ['./contracts'], message: 'src/contracts may not import from other src/ folders.' },
  // src/core may import only src/contracts.
  { target: './src/core', from: './src', except: ['./core', './contracts'], message: 'src/core may import only src/contracts.' },
  // src/sim2d may import only src/contracts.
  { target: './src/sim2d', from: './src', except: ['./sim2d', './contracts'], message: 'src/sim2d may import only src/contracts.' },
  // src/app may import anything.
];

const nondeterminism = 'Non-deterministic: use the seeded PRNG in src/contracts/rng.ts and integer ticks.';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'logs/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver': { node: { extensions: ['.ts', '.js', '.json'] } },
    },
    rules: {
      'import-x/no-restricted-paths': ['error', { zones: boundaryZones }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/contracts/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: nondeterminism },
        { object: 'Date', property: 'now', message: nondeterminism },
        { object: 'performance', property: 'now', message: nondeterminism },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: nondeterminism },
        { name: 'performance', message: nondeterminism },
      ],
    },
  },
);

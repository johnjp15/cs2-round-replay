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
  // H1/H2: src/engine (pure CS2 mechanics shared by hosts) may import only src/contracts.
  { target: './src/engine', from: './src', except: ['./engine', './contracts'], message: 'src/engine may import only src/contracts.' },
  // H1: src/sim3d (the 3D host) may import src/contracts, src/engine and src/sim2d.
  { target: './src/sim3d', from: './src', except: ['./sim3d', './engine', './sim2d', './contracts'], message: 'src/sim3d may import only src/contracts, src/engine and src/sim2d.' },
  // src/app and src/app3d may import anything.
];

const nondeterminism = 'Non-deterministic: use the seeded PRNG in src/contracts/rng.ts and integer ticks.';

export default tseslint.config(
  // tools/pages/encrypt.cjs is a byte-for-byte copy of web-apps' cs2/tools/encrypt.cjs (docs/deploy.md): not ours to restyle.
  { ignores: ['dist/', 'dist-single/', 'dist-3d/', 'dist-single-3d/', 'node_modules/', 'logs/', 'coverage/', 'tools/pages/encrypt.cjs'] },
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
    files: ['src/core/**/*.ts', 'src/contracts/**/*.ts', 'src/engine/**/*.ts', 'src/sim3d/**/*.ts'],
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

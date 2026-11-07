import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the static build works from any sub-path (e.g. GitHub Pages).
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Many tests run whole rounds (1.6–3 s each in Node); on a loaded 2-vCPU runner the 5 s default was too tight.
    testTimeout: 30_000,
  },
});

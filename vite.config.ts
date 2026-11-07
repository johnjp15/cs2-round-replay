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
    // G3: a whole scenario round in 3D (hull traces every tick) takes 5–10 s on a CI runner, more than vitest's 5 s.
    testTimeout: 60_000,
  },
});

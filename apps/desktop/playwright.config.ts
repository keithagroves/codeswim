import { defineConfig } from '@playwright/test'

// Electron E2E tests spawn the built app (out/main/index.js) per test via
// e2e/fixtures.ts, so `npm run build` must have run first. Not part of the
// vitest unit-test gate — run explicitly with `npm run test:e2e`.
//
// In sandboxed shells (see CLAUDE.md) ELECTRON_RUN_AS_NODE=1 is often set,
// which makes every launch fail with "Process failed to launch!" — unset it
// before running: `env -u ELECTRON_RUN_AS_NODE npm run test:e2e`.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list'
})

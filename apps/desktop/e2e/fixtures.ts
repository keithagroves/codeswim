// Shared Electron launch fixture for the e2e suite. Mirrors the launch shape
// already proven out in scripts/smoke-electron.mjs and scripts/capture-demo.mjs
// (app.getAppPath()-relative launch, production env, throwaway userData dir
// so recents/demo-workspace state never leaks between tests).
import { test as base, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const appDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appDir, '..', '..')

export const sampleWorkspace = path.join(repoRoot, 'examples', 'sample-architecture')

type Fixtures = {
  electronApp: ElectronApplication
  window: Page
}

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'codeswim-e2e-'))
    const app = await electron.launch({
      args: [appDir, `--user-data-dir=${userDataDir}`],
      cwd: appDir,
      env: { ...process.env, NODE_ENV: 'production' }
    })
    await use(app)
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  },

  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow({ timeout: 20_000 })
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  }
})

export { expect }

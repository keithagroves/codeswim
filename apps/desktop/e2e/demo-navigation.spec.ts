import { test, expect } from './fixtures'

// "Or try the demo project" copies examples/sample-architecture into a fresh
// userData/demo-workspace dir (see main/demo.ts) and opens it directly — no
// native dialog involved, so this is the cheapest path to a loaded workspace.
async function openDemo(window: import('playwright-core').Page): Promise<void> {
  await window.waitForSelector('.start-screen', { timeout: 10_000 })
  await window.click('.start-screen-demo')
  await window.waitForSelector('g.node:has-text("API Gateway")', { timeout: 15_000 })
}

test('opens the demo project into the overview diagram', async ({ window }) => {
  await openDemo(window)
  await expect(window.locator('g.node:has-text("API Gateway")')).toBeVisible()
  await expect(window.locator('g.node:has-text("Billing Service")')).toBeVisible()
})

test('drills from overview -> subsystem -> flow -> source leaf, then back home', async ({
  window
}) => {
  await openDemo(window)

  await window.click('g.node:has-text("Billing Service")')
  await window.waitForSelector('g.node:has-text("Refund Service")', { timeout: 10_000 })

  await window.click('g.node:has-text("Charge Service")')
  await window.waitForSelector('g.node:has-text("Payment Provider")', { timeout: 10_000 })

  await window.click('g.node:has-text("Persist Charge")')
  await window.waitForSelector('.read-view, .code-view', { timeout: 10_000 })

  await window.click('button[title="Overview"]')
  await window.waitForSelector('g.node:has-text("Billing Service")', { timeout: 10_000 })
  await expect(window.locator('button[title="Overview"]')).toBeDisabled()
})

test('Back button returns to the previous diagram after drilling in', async ({ window }) => {
  await openDemo(window)

  await window.click('g.node:has-text("Billing Service")')
  await window.waitForSelector('g.node:has-text("Refund Service")', { timeout: 10_000 })

  await window.click('button[title="Back"]')
  await window.waitForSelector('g.node:has-text("Billing Service")', { timeout: 10_000 })
})

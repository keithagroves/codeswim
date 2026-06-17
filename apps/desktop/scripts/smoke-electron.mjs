// Boot the built Electron app under Playwright and assert it actually renders.
// Validates that the bundled workspace packages (contract/domain-*/harness)
// load at runtime — the thing the typecheck/test gate can't prove.
//
// Run from apps/desktop:  node scripts/smoke-electron.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '..') // apps/desktop

const consoleErrors = []
const mainStderr = []
let exitCode = 0

// Launch the app *directory* (Electron reads package.json "main"), not the
// script path — this mirrors a real/packaged launch so app.getAppPath()
// resolves to apps/desktop (the builtin-skills path depends on it).
const app = await electron.launch({
  args: [appDir],
  cwd: appDir,
  env: { ...process.env, NODE_ENV: 'production' }
})

// Main-process stderr (native module load failures, uncaught errors) show here.
app.process().stderr?.on('data', (d) => mainStderr.push(d.toString()))

try {
  const window = await app.firstWindow({ timeout: 20000 })
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

  await window.waitForLoadState('domcontentloaded')
  // Give the React tree a beat to mount and any startup IPC to settle.
  await window.waitForTimeout(2500)

  const title = await window.title()
  const rootHtmlLen = await window.evaluate(
    () => document.getElementById('root')?.innerHTML.length ?? 0
  )
  const hasApiBridge = await window.evaluate(() => typeof window.api === 'object')
  const bodyText = (await window.evaluate(() => document.body.innerText)).slice(0, 200)

  await window.screenshot({ path: path.join(appDir, 'out', 'smoke.png') })

  // Exercise the extracted domains over IPC against the repo root (a git +
  // GitHub repo with markdown). Proves the runtime seams resolve:
  //   listTree/listMarkdown -> main fs walk
  //   gitStatus             -> @codeswim/domain-git
  //   roomIdentity          -> @codeswim/domain-github (room + domain-git)
  //   listSkills(null)      -> @codeswim/domain-skills (configureBuiltinSkillsDir)
  //   githubStatus          -> @codeswim/domain-github (host auth wiring)
  const repoRoot = path.resolve(appDir, '..', '..')
  const domain = await window.evaluate(async (root) => {
    const safe = async (label, p) => {
      try {
        return [label, 'ok', await p]
      } catch (e) {
        return [label, 'THREW', e instanceof Error ? e.message : String(e)]
      }
    }
    const a = window.api
    return Promise.all([
      safe('listMarkdown', a.listMarkdown(root).then((x) => `${x.length} files`)),
      safe('listTree', a.listTree(root).then((x) => `${x.length} top entries`)),
      safe('gitStatus', a.gitStatus(root).then((s) => `repo=${s.isRepo} branch=${s.branch}`)),
      safe('roomIdentity', a.roomIdentity(root).then((r) => (r ? `${r.provider}:${r.slug}` : 'null'))),
      safe('listSkills', a.listSkills(null).then((s) => `builtin=${s.builtin.length} global=${s.global.length}`)),
      safe('githubStatus', a.githubStatus().then((s) => `configured=${s.configured} user=${s.user?.login ?? null}`))
    ])
  }, repoRoot)

  console.log('--- domain IPC probes (extracted packages at runtime) ---')
  for (const [label, status, val] of domain) {
    console.log(`   ${status === 'ok' ? '✓' : '✗'} ${label}: ${val}`)
    if (status === 'THREW') { consoleErrors.push(`${label} threw: ${val}`); }
  }

  // Start the opencode sidecar (spawns the platform binary) then stop it. This
  // exercises sidecar.ts's binary resolution under npm-workspace hoisting.
  const harness = await window.evaluate(async (root) => {
    try {
      const conn = await window.api.startHarness(root)
      await window.api.stopHarness()
      return ['ok', conn?.url ?? 'no-url']
    } catch (e) {
      return ['THREW', e instanceof Error ? e.message : String(e)]
    }
  }, repoRoot)
  console.log('--- harness sidecar probe ---')
  console.log(`   ${harness[0] === 'ok' ? '✓' : '✗'} startHarness: ${harness[1]}`)
  if (harness[0] === 'THREW') consoleErrors.push(`startHarness threw: ${harness[1]}`)

  console.log('--- smoke results ---')
  console.log('title:           ', JSON.stringify(title))
  console.log('#root html chars:', rootHtmlLen)
  console.log('window.api bridge:', hasApiBridge)
  console.log('body text (head):', JSON.stringify(bodyText))
  console.log('console errors:  ', consoleErrors.length)
  consoleErrors.forEach((e) => console.log('   ✗', e))
  console.log('main stderr lines:', mainStderr.length)
  mainStderr.slice(0, 20).forEach((e) => console.log('   |', e.trimEnd()))

  // Pass criteria: the renderer mounted real content and the preload bridge is
  // present. (Electron emits benign GPU/sandbox warnings to stderr, so we don't
  // fail on stderr volume — only on render failure or page errors.)
  if (rootHtmlLen < 50) {
    console.error('\nFAIL: #root did not render meaningful content')
    exitCode = 1
  } else if (!hasApiBridge) {
    console.error('\nFAIL: window.api preload bridge missing')
    exitCode = 1
  } else if (consoleErrors.length > 0) {
    console.error('\nFAIL: renderer reported console/page errors')
    exitCode = 1
  } else {
    console.log('\nPASS: app booted and rendered')
  }
} catch (err) {
  console.error('FAIL: launch/inspection threw:', err)
  console.error('main stderr:\n' + mainStderr.join(''))
  exitCode = 1
} finally {
  await app.close()
}

process.exit(exitCode)

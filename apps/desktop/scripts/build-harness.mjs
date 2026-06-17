import { build, context } from 'esbuild'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

const watch = process.argv.includes('--watch')
const minify = !watch

// The harness source lives in the @codeswim/harness package; esbuild bundles
// it (resolving @codeswim/contract + js-yaml from source) into the desktop
// app's out/harness so sidecar.ts and the electron-builder globs are unchanged.
const harnessSrc = '../../packages/harness/src'

const config = {
  entryPoints: [`${harnessSrc}/plugin.ts`],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: 'out/harness/plugin.mjs',
  external: ['@opencode-ai/plugin', '@opencode-ai/sdk'],
  sourcemap: true,
  logLevel: 'info',
  minify
}

await mkdir('out/harness/prompt', { recursive: true })
const promptSrc = `${harnessSrc}/prompt`
for (const file of await readdir(promptSrc)) {
  if (!/\.(txt|md)$/i.test(file)) continue
  await copyFile(path.join(promptSrc, file), path.join('out/harness/prompt', file))
}

if (watch) {
  const ctx = await context(config)
  await ctx.watch()
  console.log('watching harness…')
} else {
  await build(config)
}

import { build, context } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'

const watch = process.argv.includes('--watch')
const minify = !watch

const config = {
  entryPoints: ['src/harness/plugin.ts'],
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
await copyFile('src/harness/prompt/system.txt', 'out/harness/prompt/system.txt')

if (watch) {
  const ctx = await context(config)
  await ctx.watch()
  console.log('watching harness…')
} else {
  await build(config)
}

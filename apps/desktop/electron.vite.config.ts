import { resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VOICE_IDS } from './src/main/voice-protocol'

// Workspace packages are consumed as TS source, so they must be bundled rather
// than externalized — otherwise main/preload would try to require a package
// that ships no built JS. Add new @codeswim/* packages here as they appear.
const bundledWorkspaceDeps = [
  '@codeswim/contract',
  '@codeswim/domain-git',
  '@codeswim/domain-github',
  '@codeswim/domain-kanban',
  '@codeswim/domain-unbiased',
  '@codeswim/domain-skills',
  '@codeswim/whiteboard'
]

// .env lives at the monorepo root, but electron-vite defaults envDir to this
// app's directory. Point every process at the root so MAIN_VITE_* (GitHub
// client id) and VITE_* (party host) load in dev and build alike — otherwise
// GitHub reads as "not configured" and the party host falls back to localhost.
const envDir = resolve('../..')

// kokoro-js reads its voice style files from `<its dir>/../voices`. It's
// bundled into out/main/voice-worker.js, so copy just the voices the
// whiteboard offers to out/voices (~0.5 MB each; the package has 54).
function copyKokoroVoices(): Plugin {
  return {
    name: 'copy-kokoro-voices',
    writeBundle(options) {
      const pkg = ['node_modules/kokoro-js', '../../node_modules/kokoro-js']
        .map((p) => resolve(p))
        .find((p) => existsSync(p))
      if (!pkg || !options.dir) throw new Error('kokoro-js not found; run npm install')
      const dest = resolve(options.dir, '..', 'voices')
      mkdirSync(dest, { recursive: true })
      for (const id of VOICE_IDS)
        copyFileSync(resolve(pkg, 'voices', `${id}.bin`), resolve(dest, `${id}.bin`))
    }
  }
}

export default defineConfig({
  main: {
    envDir,
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps }), copyKokoroVoices()],
    resolve: {
      // The voice worker bundles transformers.js, which imports sharp for
      // images it never sees here; see src/main/stubs/sharp.ts.
      alias: { sharp: resolve('src/main/stubs/sharp.ts') }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The natural voice, forked as a utility process (src/main/voice.ts).
          'voice-worker': resolve('src/main/voice-worker.ts'),
          // Speech mode's speech recognition (src/main/listen.ts).
          'listen-worker': resolve('src/main/listen-worker.ts')
        }
      }
    }
  },
  preload: {
    envDir,
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps })]
  },
  renderer: {
    envDir,
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    optimizeDeps: {
      // @tldraw/assets imports its fonts/icons with `?url`; pre-bundling
      // drops those imports and getAssetUrlsByImport crashes in dev.
      exclude: ['ghostty-web', '@tldraw/assets']
    }
  }
})

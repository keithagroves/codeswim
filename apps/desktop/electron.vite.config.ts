import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Workspace packages are consumed as TS source, so they must be bundled rather
// than externalized — otherwise main/preload would try to require a package
// that ships no built JS. Add new @codeswim/* packages here as they appear.
const bundledWorkspaceDeps = [
  '@codeswim/contract',
  '@codeswim/domain-git',
  '@codeswim/domain-github',
  '@codeswim/domain-kanban',
  '@codeswim/domain-skills'
]

// .env lives at the monorepo root, but electron-vite defaults envDir to this
// app's directory. Point every process at the root so MAIN_VITE_* (GitHub
// client id) and VITE_* (party host) load in dev and build alike — otherwise
// GitHub reads as "not configured" and the party host falls back to localhost.
const envDir = resolve('../..')

export default defineConfig({
  main: {
    envDir,
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps })]
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
      exclude: ['ghostty-web']
    }
  }
})

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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps })]
  },
  renderer: {
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

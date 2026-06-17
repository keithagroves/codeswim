import type { ElectronAPI } from '@electron-toolkit/preload'
import type { DiagramNavApi } from '@codeswim/contract'

// The IPC contract types now live in @codeswim/contract. This file only carries
// the renderer-side `window.api` global augmentation, which is an Electron
// concern specific to this app (tsconfig.web.json includes preload/*.d.ts).
declare global {
  interface Window {
    electron: ElectronAPI
    api: DiagramNavApi
  }
}

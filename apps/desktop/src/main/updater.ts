// Background auto-update via electron-updater, fed by the GitHub releases
// that electron-builder publishes (latest*.yml + blockmaps). Main checks and
// downloads silently; the renderer just gets status events and shows a
// "restart to update" button once an update is ready — VS Code style. The
// actual install happens on quitAndInstall from the update:install IPC.

import { app, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatusPayload } from '@codeswim/contract'

const { autoUpdater } = electronUpdater

// Re-check cadence while the app stays open (VS Code uses a similar period).
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export function initUpdater(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('update:install', () => {
    // Not guarded by state: quitAndInstall is a no-op unless an update was
    // downloaded, and the renderer only shows the button on 'ready'.
    autoUpdater.quitAndInstall()
  })

  // Dev builds have no update feed (and dev-app-update.yml is excluded from
  // packaging); register the IPC handler above so the renderer surface is
  // uniform, but never poll.
  if (!app.isPackaged) return

  const send = (payload: UpdateStatusPayload): void => {
    getWindow()?.webContents.send('update:status', payload)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => send({ state: 'none' }))
  autoUpdater.on('download-progress', (progress) =>
    send({ state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => send({ state: 'error', message: err.message }))

  const check = (): void => {
    // Swallow rejections (offline, rate limit) — the 'error' event above
    // already reported them to the renderer; next interval retries.
    void autoUpdater.checkForUpdates().catch(() => {})
  }

  check()
  const timer = setInterval(check, CHECK_INTERVAL_MS)
  timer.unref?.()
}

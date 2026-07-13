import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { UpdateStatusPayload } from '@codeswim/contract'

// Shared mutable mocks, hoisted so the vi.mock factories below can reach them.
const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    listeners,
    ipcHandlers,
    isPackaged: { value: true },
    autoUpdater: {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners.set(event, cb)
      }),
      checkForUpdates: vi.fn(() => Promise.resolve()),
      quitAndInstall: vi.fn()
    }
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged.value
    }
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.ipcHandlers.set(channel, handler)
    })
  }
}))

vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks.autoUpdater } }))

import { initUpdater } from './updater'

function windowSpy(): { window: BrowserWindow; sent: [string, UpdateStatusPayload][] } {
  const sent: [string, UpdateStatusPayload][] = []
  const window = {
    webContents: {
      send: (channel: string, payload: UpdateStatusPayload) => sent.push([channel, payload])
    }
  } as unknown as BrowserWindow
  return { window, sent }
}

// Emit an autoUpdater event as electron-updater would.
function emit(event: string, arg?: unknown): void {
  mocks.listeners.get(event)?.(arg)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.ipcHandlers.clear()
  mocks.isPackaged.value = true
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('initUpdater', () => {
  it('registers update:install and routes it to quitAndInstall', () => {
    initUpdater(() => null)
    const handler = mocks.ipcHandlers.get('update:install')
    expect(handler).toBeDefined()
    handler!()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('checks immediately and downloads automatically when packaged', () => {
    initUpdater(() => null)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.autoDownload).toBe(true)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('re-checks on the interval', () => {
    initUpdater(() => null)
    vi.advanceTimersByTime(4 * 60 * 60 * 1000)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('never polls in dev builds but still registers the install handler', () => {
    mocks.isPackaged.value = false
    initUpdater(() => null)
    expect(mocks.ipcHandlers.has('update:install')).toBe(true)
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('maps updater events to update:status payloads', () => {
    const { window, sent } = windowSpy()
    initUpdater(() => window)

    emit('checking-for-update')
    emit('update-available', { version: '0.2.0' })
    emit('download-progress', { percent: 41.7 })
    emit('update-downloaded', { version: '0.2.0' })
    emit('update-not-available')
    emit('error', new Error('feed unreachable'))

    expect(sent.map(([channel]) => channel)).toEqual(Array(6).fill('update:status'))
    expect(sent.map(([, payload]) => payload)).toEqual([
      { state: 'checking' },
      { state: 'available', version: '0.2.0' },
      { state: 'downloading', percent: 42 },
      { state: 'ready', version: '0.2.0' },
      { state: 'none' },
      { state: 'error', message: 'feed unreachable' }
    ])
  })

  it('drops events silently when no window exists', () => {
    initUpdater(() => null)
    expect(() => emit('update-downloaded', { version: '0.2.0' })).not.toThrow()
  })
})

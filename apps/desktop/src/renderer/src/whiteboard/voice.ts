// The whiteboard's voice choice and the natural voice's install status, as an
// external store (useSyncExternalStore) the view and the speaker share.
//
// The preference is a per-viewer convenience, kept in localStorage; the
// status comes from main (voice.ts) over IPC. "natural" is the default, but
// the system voice speaks until the natural one is installed and loaded —
// the download (~163 MB) only ever starts from an explicit click.

import type { DiagramNavApi, VoiceStatus } from '@codeswim/contract'

export const NATURAL_VOICES = [
  { id: 'af_heart', label: 'Heart', accent: 'US' },
  { id: 'af_bella', label: 'Bella', accent: 'US' },
  { id: 'am_michael', label: 'Michael', accent: 'US' },
  { id: 'bf_emma', label: 'Emma', accent: 'UK' },
  { id: 'bm_george', label: 'George', accent: 'UK' }
] as const

export type NaturalVoiceId = (typeof NATURAL_VOICES)[number]['id']
export type VoicePreference = { kind: 'natural'; voice: NaturalVoiceId } | { kind: 'system' }

export interface VoiceSnapshot {
  preference: VoicePreference
  status: VoiceStatus
}

const STORAGE_KEY = 'codeswim:whiteboard:voice'

const UNAVAILABLE: VoiceStatus = {
  available: false,
  installed: false,
  state: 'idle',
  progress: null,
  error: null,
  downloadMb: 163
}

type VoiceApi = Pick<DiagramNavApi, 'voiceStatus' | 'voiceInstall' | 'onVoiceStatus'>

function readPreference(): VoicePreference {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as VoicePreference | null
    if (raw?.kind === 'system') return raw
    if (raw?.kind === 'natural' && NATURAL_VOICES.some((v) => v.id === raw.voice)) return raw
  } catch {
    // Blocked or unreadable storage: fall through to the default.
  }
  return { kind: 'natural', voice: 'af_heart' }
}

function writePreference(p: VoicePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Not remembered next time; fine.
  }
}

export class VoiceSettings {
  private snapshot: VoiceSnapshot
  private listeners = new Set<() => void>()
  private started = false

  constructor(private readonly api: VoiceApi) {
    this.snapshot = { preference: readPreference(), status: UNAVAILABLE }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): VoiceSnapshot => this.snapshot

  private set(next: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const l of this.listeners) l()
  }

  /**
   * Start tracking the voice's status. If the natural voice is preferred and
   * already downloaded, load it now so the first sentence doesn't wait.
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.api.onVoiceStatus((status) => this.set({ status }))
    void this.api
      .voiceStatus()
      .then((status) => {
        this.set({ status })
        if (
          this.snapshot.preference.kind === 'natural' &&
          status.installed &&
          status.state === 'idle'
        ) {
          void this.install()
        }
      })
      .catch(() => {})
  }

  /** Download (first time) and load the natural voice. */
  async install(): Promise<void> {
    try {
      this.set({ status: await this.api.voiceInstall() })
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(e)
      this.set({ status: { ...this.snapshot.status, state: 'error', error: message } })
    }
  }

  setPreference(preference: VoicePreference): void {
    writePreference(preference)
    this.set({ preference })
    const { status } = this.snapshot
    if (preference.kind === 'natural' && status.installed && status.state === 'idle')
      void this.install()
  }

  /** The natural voice to speak with right now, or null for the system voice. */
  get naturalVoice(): NaturalVoiceId | null {
    const { preference, status } = this.snapshot
    return preference.kind === 'natural' && status.state === 'ready' ? preference.voice : null
  }
}

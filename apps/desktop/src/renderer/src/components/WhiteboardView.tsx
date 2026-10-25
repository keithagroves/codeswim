// The Whiteboard workspace view (plans/talking-whiteboard.md): talk through
// what to build, and the narrator answers out loud while sketching it on a
// read-only tldraw canvas. You talk to it in the Agent panel's chat, or out
// loud in speech mode (the sound-wave button); the narrator does all the drawing, and its replies land
// in the same thread as the agent's. Agreeing to a design hands it to the
// agent, which builds it diagram-first, and the narrator comes back with a
// walkthrough on a new page.
//
// The conversation itself lives in WhiteboardController (outlives this
// component); this view shows the board, captions and voice controls, and
// attaches the canvas while mounted.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Tldraw, type Editor, type TLEventInfo } from 'tldraw'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import 'tldraw/tldraw.css'
import { useStore } from '../store'
import { useSurfaceContext } from '../context/useSurfaceContext'
import { TldrawCanvas, type Insets } from '../whiteboard/tldraw-canvas'
import { NATURAL_VOICES, type VoicePreference } from '../whiteboard/voice'
import { speechLabel } from '../whiteboard/speech-mode'
import { SpeechModeButton } from './SpeechMode'

// Fonts, icons and translations are bundled by Vite and served from the app
// itself, not tldraw's CDN, so the CSP stays as it is. The URLs pass through
// unchanged: tldraw's default formatter only knows http(s) and data URLs, and
// turned the packaged build's file:// URLs into file:///file:///… .
const assetUrls = getAssetUrlsByImport((url) => url)
const licenseKey = (import.meta.env as Record<string, string | undefined>).VITE_TLDRAW_LICENSE_KEY

// What the overlays cover: page tabs on top, captions and the control strip
// at the bottom. The canvas keeps the drawing clear of them.
const INSETS: Insets = { left: 24, top: 64, right: 24, bottom: 150 }

const fmt = (ms: number | undefined): string =>
  ms === undefined ? '–' : `${(ms / 1000).toFixed(1)}s`

export function WhiteboardView(): React.JSX.Element {
  const { whiteboard, voice, speech, setActiveSection } = useStore()
  const snap = useSyncExternalStore(whiteboard.subscribe, whiteboard.getSnapshot)
  const voiceSnap = useSyncExternalStore(voice.subscribe, voice.getSnapshot)
  const speechSnap = useSyncExternalStore(speech.subscribe, speech.getSnapshot)
  const [licenseBlocked, setLicenseBlocked] = useState(false)
  const canvasRef = useRef<TldrawCanvas | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)

  const currentPage = snap.pages.find((p) => p.id === snap.currentPageId) ?? null
  const showTabs = !snap.blank && (snap.pages.length > 1 || !!snap.pages[0]?.name)

  useSurfaceContext(
    'whiteboard',
    useMemo(
      () => ({
        pages: snap.pages.map((p) => p.name).filter(Boolean),
        currentPage: currentPage?.name || null,
        mode: snap.talking ? 'talking' : snap.building ? 'building' : 'idle'
      }),
      [snap.pages, currentPage, snap.talking, snap.building]
    )
  )

  // The view is on screen: start the narrator's server early, and play a
  // walkthrough that finished while it was hidden.
  useEffect(() => {
    whiteboard.warm()
    voice.start()
    whiteboard.visible()
  }, [whiteboard, voice])

  // The conversation happens in the Agent panel's chat, so open it beside the board.
  useEffect(() => {
    setActiveSection('agent')
  }, [setActiveSection])

  // Speech mode is a conversation with the board; leaving the board ends it.
  useEffect(() => () => speech.stop(), [speech])

  // Esc stops the narrator mid-sentence (a running build carries on).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && whiteboard.getSnapshot().talking) {
        e.preventDefault()
        whiteboard.interrupt()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [whiteboard])

  // tldraw hides the editor in packaged builds without a license key (after
  // ~5 s). Say so instead of showing an empty board.
  useEffect(() => {
    const t = setTimeout(() => {
      if (hostRef.current?.querySelector('[data-testid="tl-license-expired"]'))
        setLicenseBlocked(true)
    }, 6000)
    return () => clearTimeout(t)
  }, [])

  const onMount = useCallback(
    (editor: Editor) => {
      editor.user.updateUserPreferences({ colorScheme: 'dark' })
      editor.updateInstanceState({ isReadonly: true })
      const canvas = new TldrawCanvas(editor, () => INSETS)
      canvasRef.current = canvas
      whiteboard.attach(canvas)

      // Clicking a linked box opens that diagram or file. A drag (pan) isn't a click.
      let down: { x: number; y: number } | null = null
      const onEvent = (info: TLEventInfo): void => {
        if (info.type !== 'pointer') return
        if (info.name === 'pointer_down') down = { x: info.point.x, y: info.point.y }
        if (info.name !== 'pointer_up' || !down) return
        const moved = Math.hypot(info.point.x - down.x, info.point.y - down.y)
        down = null
        if (moved > 5) return
        const shape = editor.getShapeAtPoint(editor.inputs.currentPagePoint, { hitInside: true })
        const link = (shape?.meta as { link?: unknown } | undefined)?.link
        if (typeof link === 'string') void whiteboard.openLink(link)
      }
      editor.on('event', onEvent)
      return () => {
        editor.off('event', onEvent)
        whiteboard.detach(canvas)
        canvas.dispose()
        canvasRef.current = null
      }
    },
    [whiteboard]
  )

  const lastBuild = snap.lastBuild

  return (
    <div className="whiteboard" ref={hostRef}>
      <div className="whiteboard-canvas">
        <Tldraw hideUi onMount={onMount} assetUrls={assetUrls} licenseKey={licenseKey} />
      </div>

      <div className="whiteboard-top">
        {showTabs ? (
          <div className="whiteboard-pages" role="tablist" aria-label="Whiteboard pages">
            {snap.pages.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={p.id === snap.currentPageId}
                className={p.id === snap.currentPageId ? 'is-active' : ''}
                onClick={() => whiteboard.showPage(p.id)}
              >
                {p.name || 'Untitled'}
              </button>
            ))}
          </div>
        ) : null}
        {snap.researching ? (
          <div className="whiteboard-banner is-building" title={snap.researching}>
            <span className="status-dot running" /> The agent is looking into it
            <button className="link-btn" onClick={() => whiteboard.cancelResearch()}>
              Stop
            </button>
          </div>
        ) : null}
        {snap.building ? (
          <div className="whiteboard-banner is-building" title={snap.building}>
            <span className="status-dot running" /> Building: diagrams first, then code
          </div>
        ) : snap.walkthroughReady ? (
          <div className="whiteboard-banner">
            The build finished.
            <button className="link-btn" onClick={() => void whiteboard.playWalkthrough()}>
              Walk me through it
            </button>
          </div>
        ) : null}
        <VoiceBanner />
      </div>

      {/* Only before the first question, and never under the license notice:
          a conversation about the page beside the board can leave it blank. */}
      {snap.blank && !snap.talking && snap.entries.length === 0 && !licenseBlocked ? (
        <div className="whiteboard-empty">
          <h2>Talk through what to build</h2>
          <p>
            Ask about a feature or a change. The narrator answers out loud and sketches it, lays out
            real choices for you to make, and builds it once you say yes: diagram first, then code.
          </p>
          <p className="whiteboard-hint">
            Type in the Agent chat, or press the sound-wave button to talk to it out loud.
          </p>
        </div>
      ) : null}

      {licenseBlocked ? (
        <div className="whiteboard-empty">
          <h2>The canvas needs a tldraw license</h2>
          <p>
            tldraw hides its editor in packaged builds without a license key. Set
            VITE_TLDRAW_LICENSE_KEY when building. Captions and the conversation still work.
          </p>
        </div>
      ) : null}

      <div className="whiteboard-bottom">
        {snap.caption ? <div className="whiteboard-caption">{snap.caption}</div> : null}

        {lastBuild && !snap.building && !snap.walkthroughReady ? (
          <div className="whiteboard-actions">
            {lastBuild.diagrams.slice(0, 3).map((d) => (
              <button
                key={d}
                className="secondary"
                onClick={() => void whiteboard.openLink(d)}
                title={d}
              >
                Open the diagram{lastBuild.diagrams.length > 1 ? `: ${d.split('/').at(-1)}` : ''}
              </button>
            ))}
            {lastBuild.diff ? (
              <button className="secondary" onClick={() => whiteboard.showLastDiff()}>
                Open the diff
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="whiteboard-strip">
          <SpeechModeButton />
          {snap.talking ? (
            <button
              type="button"
              className="secondary"
              onClick={() => whiteboard.interrupt()}
              title="Stop talking (Esc)"
            >
              Stop
            </button>
          ) : speechSnap.state !== 'off' &&
            speechSnap.state !== 'offer' &&
            speechSnap.state !== 'error' ? (
            // The offer and errors have buttons, so they show in the chat's bar.
            <span className="whiteboard-strip-hint">{speechLabel(speechSnap)}</span>
          ) : snap.connecting ? (
            <span className="whiteboard-strip-hint">Starting the narrator…</span>
          ) : null}
          <select
            className="whiteboard-voice"
            aria-label="Voice"
            title="Voice"
            value={voiceSnap.preference.kind === 'system' ? 'system' : voiceSnap.preference.voice}
            onChange={(e) => {
              const v = e.target.value
              const next: VoicePreference =
                v === 'system'
                  ? { kind: 'system' }
                  : { kind: 'natural', voice: v as (typeof NATURAL_VOICES)[number]['id'] }
              voice.setPreference(next)
            }}
          >
            {voiceSnap.status.available
              ? NATURAL_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} ({v.accent})
                  </option>
                ))
              : null}
            <option value="system">System voice</option>
          </select>
          <button
            type="button"
            className={`icon-btn ${snap.muted ? 'is-muted' : ''}`}
            onClick={() => whiteboard.setMuted(!snap.muted)}
            title={snap.muted ? 'Unmute: speak the answers' : 'Mute: captions only'}
            aria-pressed={snap.muted}
          >
            {snap.muted ? '🔇' : '🔊'}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              if (
                window.confirm(
                  'Start a new whiteboard? The current pages and conversation are cleared.'
                )
              ) {
                whiteboard.newBoard()
              }
            }}
            disabled={snap.blank && snap.entries.length === 0}
            title="New whiteboard"
          >
            ＋
          </button>
        </div>
        {snap.timing ? (
          <div
            className="whiteboard-timing"
            title="Last turn: first spoken word, first drawing, longest pause"
          >
            speaking {fmt(snap.timing.firstSpoken)} · drawing {fmt(snap.timing.firstDrawing)} ·
            longest pause {fmt(snap.timing.maxGap)}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// The natural voice's state, while it matters: an explicit offer to download
// it (never automatic), then progress, then any error with a retry. Picking
// "System voice" hides it.
function VoiceBanner(): React.JSX.Element | null {
  const { voice } = useStore()
  const { preference, status } = useSyncExternalStore(voice.subscribe, voice.getSnapshot)
  if (preference.kind !== 'natural' || !status.available) return null
  if (status.state === 'downloading') {
    const pct = status.progress === null ? '' : ` ${Math.round(status.progress * 100)}%`
    return (
      <div className="whiteboard-banner">
        <span className="status-dot running" /> Downloading the natural voice…{pct}
      </div>
    )
  }
  if (status.state === 'loading') {
    return (
      <div className="whiteboard-banner">
        <span className="status-dot running" /> Loading the natural voice…
      </div>
    )
  }
  if (status.state === 'error') {
    return (
      <div className="whiteboard-banner" title={status.error ?? undefined}>
        The natural voice didn&apos;t load{status.error ? `: ${status.error}` : ''}.
        <button className="link-btn" onClick={() => void voice.install()}>
          Retry
        </button>
      </div>
    )
  }
  if (!status.installed) {
    return (
      <div className="whiteboard-banner">
        A natural voice is available: a one-time {status.downloadMb} MB download, then it runs
        offline.
        <button className="link-btn" onClick={() => void voice.install()}>
          Download
        </button>
      </div>
    )
  }
  return null
}

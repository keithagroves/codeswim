// Speech mode's controls (whiteboard/speech-mode.ts): the sound-wave button
// that turns it on, and the bar that stands in for the chat box while it's
// on — a live level meter, what it's doing, and End.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useStore } from '../store'
import { speechLabel } from '../whiteboard/speech-mode'

export function SoundWaveIcon({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 10v4M8 6.5v11M12 3.5v17M16 7.5v9M20 10v4" />
    </svg>
  )
}

/**
 * The sound-wave button. It opens the whiteboard (the narrator is the one
 * that talks back) and the chat, where the listening bar shows.
 */
export function SpeechModeButton({ className = '' }: { className?: string }): React.JSX.Element {
  const { speech, state, commands, setActiveSection } = useStore()
  const snap = useSyncExternalStore(speech.subscribe, speech.getSnapshot)
  const on = snap.state !== 'off'
  return (
    <button
      type="button"
      className={`icon-btn speech-mode-btn ${on ? 'is-active' : ''} ${className}`}
      onClick={() => {
        if (on) {
          speech.stop()
          return
        }
        if (state.workspaceView !== 'whiteboard')
          void commands.run('nav.setWorkspaceView', { view: 'whiteboard' }, { kind: 'human' })
        if (state.activeSection !== 'agent') setActiveSection('agent')
        void speech.start()
      }}
      disabled={!state.rootPath}
      title={on ? 'End speech mode' : 'Speech mode: talk to the whiteboard out loud'}
      aria-label={on ? 'End speech mode' : 'Start speech mode'}
      aria-pressed={on}
    >
      <SoundWaveIcon />
    </button>
  )
}

const BAR_WEIGHTS = [0.45, 0.8, 1, 0.7, 0.4]

/** The chat box's stand-in while speech mode is on. */
export function SpeechBar(): React.JSX.Element {
  const { speech, whiteboard } = useStore()
  const snap = useSyncExternalStore(speech.subscribe, speech.getSnapshot)
  const barsRef = useRef<HTMLDivElement | null>(null)

  // The level changes every frame, so it goes straight to the bars' style
  // instead of through React.
  useEffect(() => {
    let level = 0
    let raf = 0
    const draw = (): void => {
      raf = 0
      const bars = barsRef.current?.children
      if (!bars) return
      for (let i = 0; i < bars.length; i++) {
        const h = 0.18 + 0.82 * Math.min(1, level * BAR_WEIGHTS[i] * 1.6)
        ;(bars[i] as HTMLElement).style.transform = `scaleY(${h.toFixed(3)})`
      }
    }
    const off = speech.onLevel((l) => {
      // Rise fast, fall slowly, so the bars read as a voice rather than flicker.
      level = l > level ? l : level * 0.8 + l * 0.2
      if (!raf) raf = requestAnimationFrame(draw)
    })
    return () => {
      off()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [speech])

  const label = speechLabel(snap)
  const replying = snap.state === 'replying'
  return (
    <div className={`speech-bar is-${snap.state}`} role="status" aria-live="polite">
      <div className="speech-bar-meter" ref={barsRef} aria-hidden="true">
        {BAR_WEIGHTS.map((_, i) => (
          <span key={i} />
        ))}
      </div>
      {replying ? (
        <button
          type="button"
          className="speech-bar-label is-button"
          onClick={() => whiteboard.interrupt()}
        >
          {label}
        </button>
      ) : (
        <span className="speech-bar-label" title={label}>
          {label}
        </span>
      )}
      {snap.state === 'offer' ? (
        <button type="button" className="primary" onClick={() => void speech.accept()}>
          Download
        </button>
      ) : null}
      {snap.state === 'error' ? (
        <button type="button" className="secondary" onClick={() => void speech.start()}>
          Retry
        </button>
      ) : null}
      <button type="button" className="secondary" onClick={() => speech.stop()}>
        {snap.state === 'offer' ? 'Cancel' : 'End'}
      </button>
    </div>
  )
}

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { parseMarkdown } from '../parse'
import { useStore } from '../store'
import { MarkdownProse } from './MarkdownProse'

let mermaidInitialized = false
function ensureMermaidInitialized(): void {
  if (mermaidInitialized) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'default',
    fontFamily: 'inherit'
  })
  mermaidInitialized = true
}

export function ReadView({ source }: { source: string }): React.JSX.Element {
  const { state, navigateRelative } = useStore()
  const parsed = useMemo(() => parseMarkdown(source), [source])
  const canvasRef = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const renderId = `mermaid-read-${reactId}`
  const [renderError, setRenderError] = useState<{ source: string; message: string } | null>(null)
  const currentSource = parsed.mermaidBlocks[0] ?? ''
  const errorMessage =
    renderError && renderError.source === currentSource ? renderError.message : null

  // Mermaid's `click NodeId call navigate(...)` invokes a global `navigate`.
  // Both ReadView and DiagramView re-bind this on mount; only one is in the
  // DOM at a time so the latest one wins, which is correct.
  useEffect(() => {
    window.navigate = (target: string): void => {
      void navigateRelative(target)
    }
  }, [navigateRelative])

  useEffect(() => {
    if (!currentSource) return
    ensureMermaidInitialized()
    const container = canvasRef.current
    if (!container) return
    let cancelled = false
    container.innerHTML = ''

    mermaid
      .render(renderId, currentSource)
      .then(({ svg, bindFunctions }) => {
        if (cancelled || !canvasRef.current) return
        canvasRef.current.innerHTML = svg
        if (bindFunctions) bindFunctions(canvasRef.current)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setRenderError({ source: currentSource, message: msg })
      })

    return () => {
      cancelled = true
      const stray = document.getElementById(renderId)
      stray?.remove()
    }
  }, [currentSource, renderId])

  const fm = parsed.frontmatter
  const fileLabel = state.currentFile ?? ''
  const tags = Array.isArray(fm.tags) ? fm.tags : []

  return (
    <div className="read-view">
      <div className="read-text-col">
        <header className="read-header">
          {state.currentFile ? <div className="read-path">{state.currentFile}</div> : null}
          <h1 className="read-title">{fm.name ?? fileLabel}</h1>
          {fm.description ? <p className="read-lead">{fm.description}</p> : null}
          {tags.length > 0 ? (
            <div className="read-tags">
              {tags.map((t) => (
                <span key={t} className="read-tag">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </header>
      </div>

      {currentSource ? (
        errorMessage ? (
          <div className="read-text-col">
            <div className="banner error">Mermaid render error: {errorMessage}</div>
          </div>
        ) : (
          <figure className="read-diagram">
            <div ref={canvasRef} />
          </figure>
        )
      ) : null}

      {parsed.prose ? (
        <div className="read-text-col">
          <div className="read-prose">
            <MarkdownProse
              source={parsed.prose}
              onNavigate={(target) => void navigateRelative(target)}
              headingOffset={0}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

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

interface NavigateFn {
  (target: string): void
}

function extractNavigationTargets(source: string): Map<string, string> {
  const targets = new Map<string, string>()
  const clickRe = /^\s*click\s+([A-Za-z0-9_-]+)\s+call\s+navigate\(\s*["']([^"']+)["']\s*\)/gm
  let match: RegExpExecArray | null

  while ((match = clickRe.exec(source)) !== null) {
    targets.set(match[1], match[2])
  }

  return targets
}

function nodeMatchesId(node: Element, nodeId: string): boolean {
  const id = node.id
  return (
    id === nodeId ||
    id.endsWith(`-${nodeId}`) ||
    id.includes(`-${nodeId}-`) ||
    node.getAttribute('data-id') === nodeId
  )
}

function addNodeTooltip(node: Element, target: string): void {
  node.classList.add('has-navigation-target')
  node.setAttribute('aria-label', `Navigate to ${target}`)

  const existing = Array.from(node.children).find(
    (child) => child.tagName.toLowerCase() === 'title'
  )
  existing?.remove()

  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
  title.textContent = `Navigate to ${target}`
  node.prepend(title)
}

function decorateNavigationTargets(container: HTMLElement, targets: Map<string, string>): void {
  if (targets.size === 0) return

  const nodes = Array.from(container.querySelectorAll<SVGGElement>('.node'))
  for (const [nodeId, target] of targets) {
    const node = nodes.find((candidate) => nodeMatchesId(candidate, nodeId))
    if (node) addNodeTooltip(node, target)
  }
}

declare global {
  interface Window {
    navigate?: NavigateFn
  }
}

export function DiagramView({ source }: { source: string }): React.JSX.Element {
  const { state, navigateRelative } = useStore()
  const parsed = useMemo(() => parseMarkdown(source), [source])
  const canvasRef = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const renderId = `mermaid-${reactId}`
  // Track errors keyed by the source they apply to, so stale errors auto-clear
  // when the source changes — no setState-in-effect needed.
  const [renderError, setRenderError] = useState<{ source: string; message: string } | null>(null)
  const currentSource = parsed.mermaidBlocks[0] ?? ''
  const navigationTargets = useMemo(() => extractNavigationTargets(currentSource), [currentSource])
  const errorMessage =
    renderError && renderError.source === currentSource ? renderError.message : null

  // Expose the navigate hook for mermaid's `click ... call navigate(...)` syntax.
  // Re-bind on every render so the closure captures the current navigateRelative.
  useEffect(() => {
    window.navigate = (target: string): void => {
      void navigateRelative(target)
    }
    return () => {
      if (window.navigate === undefined) return
      // leave it bound — another DiagramView mount will replace it.
    }
  }, [navigateRelative])

  useEffect(() => {
    ensureMermaidInitialized()
    const container = canvasRef.current
    if (!container) return
    if (!currentSource) {
      container.innerHTML = ''
      return
    }
    let cancelled = false
    container.innerHTML = ''

    mermaid
      .render(renderId, currentSource)
      .then(({ svg, bindFunctions }) => {
        if (cancelled || !canvasRef.current) return
        canvasRef.current.innerHTML = svg
        if (bindFunctions) bindFunctions(canvasRef.current)
        decorateNavigationTargets(canvasRef.current, navigationTargets)
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
  }, [currentSource, navigationTargets, renderId])

  const fm = parsed.frontmatter
  const fileLabel = state.currentFile ?? ''

  return (
    <div className="diagram-view">
      <div className="diagram-meta">
        <h2 className="diagram-name">{fm.name ?? fileLabel}</h2>
        {fm.description ? <p className="diagram-description">{fm.description}</p> : null}
        {Array.isArray(fm.tags) && fm.tags.length > 0 ? (
          <div className="diagram-tags">
            {fm.tags.map((t) => (
              <span key={t} className="diagram-tag">
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {parsed.mermaidBlocks.length === 0 ? (
        <div className="banner warning">This file has no mermaid code block.</div>
      ) : parsed.mermaidBlocks.length > 1 ? (
        <div className="banner warning">
          This file has {parsed.mermaidBlocks.length} mermaid blocks; rendering only the first.
        </div>
      ) : null}

      {errorMessage ? (
        <>
          <div className="banner error">Mermaid render error: {errorMessage}</div>
          <pre className="code-block">{currentSource}</pre>
        </>
      ) : (
        <div className="diagram-canvas" ref={canvasRef} />
      )}

      {parsed.prose ? (
        <MarkdownProse
          source={parsed.prose}
          onNavigate={(target) => void navigateRelative(target)}
        />
      ) : null}
    </div>
  )
}

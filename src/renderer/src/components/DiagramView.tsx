import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { parseMarkdown } from '../parse'
import { useStore } from '../store'
import { MarkdownProse } from './MarkdownProse'
import { MermaidErrorBanner } from './MermaidErrorBanner'

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

const MIN_ZOOM = 0.1
const MAX_ZOOM = 10

interface ViewTransform {
  scale: number
  tx: number
  ty: number
}

export function DiagramView({ source }: { source: string }): React.JSX.Element {
  const { state, navigateRelative } = useStore()
  const parsed = useMemo(() => parseMarkdown(source), [source])
  // The mermaid SVG is rendered into canvasRef; viewportRef is the
  // overflow-hidden window we transform within; contentRef is the
  // wrapper that carries the translate/scale transform.
  const canvasRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const renderId = `mermaid-${reactId}`
  // Track errors keyed by the source they apply to, so stale errors auto-clear
  // when the source changes — no setState-in-effect needed.
  const [renderError, setRenderError] = useState<{ source: string; message: string } | null>(null)
  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 })
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  const currentSource = parsed.mermaidBlocks[0] ?? ''
  const navigationTargets = useMemo(() => extractNavigationTargets(currentSource), [currentSource])
  const errorMessage =
    renderError && renderError.source === currentSource ? renderError.message : null

  // Compute fit-to-viewport. Mermaid sometimes emits an SVG whose viewBox
  // is much larger than the actual content, so fitting against viewBox
  // alone produces a tiny diagram floating in empty space. We re-anchor
  // the viewBox to the content's bounding box first.
  const fitToViewport = useCallback((): void => {
    const svg = canvasRef.current?.querySelector('svg') as SVGSVGElement | null
    const viewport = viewportRef.current
    if (!svg || !viewport) return

    const BBOX_PAD = 8
    let svgW = 0
    let svgH = 0
    try {
      const bb = svg.getBBox()
      if (bb.width > 0 && bb.height > 0) {
        svgW = bb.width + BBOX_PAD * 2
        svgH = bb.height + BBOX_PAD * 2
        svg.setAttribute('viewBox', `${bb.x - BBOX_PAD} ${bb.y - BBOX_PAD} ${svgW} ${svgH}`)
        svg.setAttribute('width', String(svgW))
        svg.setAttribute('height', String(svgH))
      }
    } catch {
      // getBBox throws if SVG isn't in the DOM yet — fall through.
    }
    if (!svgW || !svgH) {
      svgW = svg.viewBox.baseVal?.width || svg.clientWidth
      svgH = svg.viewBox.baseVal?.height || svg.clientHeight
    }
    const cw = viewport.clientWidth
    const ch = viewport.clientHeight
    if (!svgW || !svgH || !cw || !ch) return
    const PADDING = 24
    // Fit to width — diagrams here read left-to-right and are usually wider
    // than tall. If the result overflows vertically the user can drag/zoom.
    const scale = Math.min((cw - PADDING * 2) / svgW, MAX_ZOOM)
    const scaledH = svgH * scale
    const tx = (cw - svgW * scale) / 2
    const ty = scaledH < ch ? (ch - scaledH) / 2 : PADDING
    setView({ scale, tx, ty })
  }, [])

  // Zoom at cursor: keep the world-point under the cursor anchored.
  const zoomAt = (clientX: number, clientY: number, factor: number): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const cx = clientX - rect.left
    const cy = clientY - rect.top
    const current = viewRef.current
    const nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.scale * factor))
    if (nextScale === current.scale) return
    const ratio = nextScale / current.scale
    const nextTx = cx - (cx - current.tx) * ratio
    const nextTy = cy - (cy - current.ty) * ratio
    setView({ scale: nextScale, tx: nextTx, ty: nextTy })
  }

  // ⌘/Ctrl + wheel = zoom at cursor. Plain wheel is left alone so the
  // outer page scrolls normally; pan happens via mouse drag instead.
  // macOS trackpad pinch arrives as wheel with ctrlKey: true.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    e.stopPropagation()
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01))
  }

  // Click-and-drag on empty canvas pans. Click on a mermaid node still
  // navigates (we leave node clicks to mermaid's bindFunctions by not
  // starting a drag if mousedown was on a `.node`).
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const target = e.target as Element
    if (target.closest('.node')) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const start = { ...viewRef.current }
    document.body.classList.add('is-panning')
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      setView({ scale: start.scale, tx: start.tx + dx, ty: start.ty + dy })
    }
    const onUp = (): void => {
      document.body.classList.remove('is-panning')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

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
        // Strip mermaid's inline max-width so our pan/zoom transform
        // controls the SVG's visible size, then fit to the viewport.
        const renderedSvg = canvasRef.current.querySelector('svg') as SVGElement | null
        if (renderedSvg) {
          renderedSvg.style.maxWidth = 'none'
          renderedSvg.style.height = 'auto'
        }
        fitToViewport()
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
  }, [currentSource, navigationTargets, renderId, fitToViewport])

  const fm = parsed.frontmatter
  const fileLabel = state.currentFile ?? ''

  const isFitted =
    Math.abs(view.scale - 1) < 0.001 && Math.abs(view.tx) < 1 && Math.abs(view.ty) < 1

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
        <MermaidErrorBanner error={errorMessage} source={currentSource} />
      ) : (
        <div
          className="diagram-canvas-wrap"
          ref={viewportRef}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
        >
          <div
            className="diagram-canvas-content"
            ref={contentRef}
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
              transformOrigin: '0 0'
            }}
          >
            <div className="diagram-canvas" ref={canvasRef} />
          </div>
          {!isFitted ? (
            <button
              className="diagram-zoom-reset"
              onClick={() => fitToViewport()}
              title="Fit to screen"
            >
              {Math.round(view.scale * 100)}% — fit
            </button>
          ) : null}
        </div>
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

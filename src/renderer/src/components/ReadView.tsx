import { useEffect, useId, useMemo, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { parseMarkdown } from '../parse'
import { useStore } from '../store'
import { MarkdownProse } from './MarkdownProse'
import { MermaidErrorBanner } from './MermaidErrorBanner'

function extractExplicitClickIds(source: string): Set<string> {
  const ids = new Set<string>()
  const re = /^\s*click\s+([A-Za-z0-9_-]+)\s+call\s+navigate\(/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) ids.add(match[1])
  return ids
}

function svgNodeMatchesId(node: Element, id: string): boolean {
  const nid = node.id
  return (
    nid === id ||
    nid.endsWith(`-${id}`) ||
    nid.includes(`-${id}-`) ||
    node.getAttribute('data-id') === id
  )
}

function attachFallbackClicks(
  container: HTMLElement,
  explicitIds: Set<string>,
  defaultTarget: string,
  onClickFallback: (target: string) => void
): void {
  const nodes = Array.from(container.querySelectorAll<SVGGElement>('.node'))
  for (const node of nodes) {
    if (node.classList.contains('clickable-node')) continue
    const hasExplicit = [...explicitIds].some((id) => svgNodeMatchesId(node, id))
    if (hasExplicit) continue
    node.style.cursor = 'pointer'
    node.classList.add('has-default-navigation')
    const existingTitle = Array.from(node.children).find((c) => c.tagName.toLowerCase() === 'title')
    existingTitle?.remove()
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = `No specific destination — opens ${defaultTarget}`
    node.prepend(title)
    node.addEventListener('click', (event) => {
      event.stopPropagation()
      onClickFallback(defaultTarget)
    })
  }
}

let mermaidInitialized = false
function ensureMermaidInitialized(): void {
  if (mermaidInitialized) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    themeVariables: {
      darkMode: true,
      background: '#0e0e11',
      primaryColor: '#1d1d22',
      primaryTextColor: '#ececf1',
      primaryBorderColor: '#3a3a44',
      secondaryColor: '#26262c',
      tertiaryColor: '#16161a',
      lineColor: '#62626e',
      textColor: '#ececf1',
      mainBkg: '#1d1d22',
      nodeBorder: '#3a3a44',
      clusterBkg: '#141417',
      clusterBorder: '#26262c',
      edgeLabelBackground: '#16161a'
    },
    fontFamily: 'inherit'
  })
  mermaidInitialized = true
}

export function ReadView({ source }: { source: string }): React.JSX.Element {
  const { state, navigateRelative, navigateAbsolute, createCurrentExplanation } = useStore()
  const parsed = useMemo(() => parseMarkdown(source), [source])
  const canvasRef = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const renderId = `mermaid-read-${reactId}`
  const [renderError, setRenderError] = useState<{ source: string; message: string } | null>(null)
  const currentSource = parsed.mermaidBlocks[0] ?? ''
  const errorMessage =
    renderError && renderError.source === currentSource ? renderError.message : null
  const explicitClickIds = useMemo(() => extractExplicitClickIds(currentSource), [currentSource])

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
        // Nodes without an explicit `click X call navigate(...)` get a
        // fallback handler so every node is at least navigable. Default
        // destination is the workspace-root overview, which is the most
        // useful "exit" for an abstract node.
        attachFallbackClicks(canvasRef.current, explicitClickIds, 'overview.md', (target) => {
          void navigateAbsolute(target, true)
        })
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
  }, [currentSource, renderId, explicitClickIds, navigateAbsolute])

  const fm = parsed.frontmatter
  const fileLabel = state.currentFile ?? ''
  const tags = Array.isArray(fm.tags) ? fm.tags : []

  return (
    <div className="read-view">
      {!state.sourceExplanationExists ? (
        <div className="read-text-col">
          <div className="explanation-empty-action" role="status">
            <div>
              <strong>This file has not been explained yet.</strong>
              <p>Generate the companion Markdown document for this file.</p>
            </div>
            <button className="primary" onClick={() => void createCurrentExplanation()}>
              Explain file
            </button>
          </div>
        </div>
      ) : null}

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
            <MermaidErrorBanner error={errorMessage} />
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

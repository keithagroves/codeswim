import { useStore } from '../store'

export function buildMermaidFixPrompt(file: string, error: string): string {
  return [
    `The mermaid block in \`${file}\` is failing to parse. Mermaid said:`,
    '',
    '```',
    error,
    '```',
    '',
    `Open ${file}, identify the cause (common ones: \`click ... call navigate(...)\` in a non-flowchart diagram; curly braces \`{...}\` inside square-bracket node labels; unbalanced quotes), and fix it via \`diagram_edit\`. Don't change anything else.`
  ].join('\n')
}

interface MermaidErrorBannerProps {
  error: string
  source?: string
}

export function MermaidErrorBanner({
  error,
  source
}: MermaidErrorBannerProps): React.JSX.Element {
  const { state, sendChat } = useStore()
  const file = state.currentFile

  return (
    <div className="banner error mermaid-error">
      <div className="mermaid-error-title">Mermaid render error</div>
      <pre className="mermaid-error-detail">{error}</pre>
      {file ? (
        <div className="mermaid-error-actions">
          <button
            className="primary"
            onClick={() => void sendChat(buildMermaidFixPrompt(file, error))}
            title="Send the error to the agent to fix"
          >
            Fix with agent
          </button>
        </div>
      ) : null}
      {source ? <pre className="mermaid-error-source">{source}</pre> : null}
    </div>
  )
}

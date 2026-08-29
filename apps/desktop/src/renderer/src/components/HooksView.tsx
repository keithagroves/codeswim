import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { SkillSummary } from '@codeswim/contract'

interface HookRow {
  command: string
  timeout?: number
}

interface ParsedHooks {
  rows: HookRow[]
  // The raw file wasn't valid JSON, or didn't match the { hooks: { SessionStart: [...] } }
  // shape — we still let the user start fresh from the row editor, but warn
  // that saving will replace whatever was there.
  unparseable: boolean
}

function parseHooksJson(raw: string): ParsedHooks {
  if (!raw.trim()) return { rows: [], unparseable: false }
  try {
    const parsed = JSON.parse(raw) as unknown
    const sessionStart = (parsed as { hooks?: { SessionStart?: unknown } })?.hooks?.SessionStart
    if (!Array.isArray(sessionStart)) return { rows: [], unparseable: true }
    const rows: HookRow[] = []
    for (const entry of sessionStart) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (typeof e.command !== 'string') continue
      rows.push({
        command: e.command,
        timeout: typeof e.timeout === 'number' && e.timeout > 0 ? e.timeout : undefined
      })
    }
    return { rows, unparseable: false }
  } catch {
    return { rows: [], unparseable: true }
  }
}

function serializeHooksJson(rows: HookRow[]): string {
  const sessionStart = rows
    .filter((r) => r.command.trim())
    .map((r) => (r.timeout ? { command: r.command, timeout: r.timeout } : { command: r.command }))
  if (sessionStart.length === 0) return ''
  return JSON.stringify({ hooks: { SessionStart: sessionStart } }, null, 2)
}

function canonical(rows: HookRow[]): string {
  return JSON.stringify(rows.filter((r) => r.command.trim()))
}

// Reads the built-in prompt files (system.txt, mdd-fixes.md) so the Hooks
// tab can show them as context: hooks only ever *append* to these — nothing
// here can edit or remove the built-ins, that stays a packaged-app concern.
function BuiltinPrompts(): React.JSX.Element | null {
  const { state, skillsList, skillsListFiles, setToolsTab, setCurrentSkill } = useStore()
  const [builtins, setBuiltins] = useState<SkillSummary[] | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const list = await skillsList(state.rootPath)
        setBuiltins(list.builtin)
      } catch {
        setBuiltins([])
      }
    })()
  }, [state.rootPath, skillsList])

  const onView = useCallback(
    async (name: string) => {
      let file = 'SKILL.md'
      try {
        const tree = await skillsListFiles('builtin', name, state.rootPath)
        const first = tree.find((n) => n.kind === 'file')
        if (first) file = first.path
      } catch {
        // fall through with the default; SkillsView surfaces the read error
      }
      setCurrentSkill({ scope: 'builtin', name, file })
      setToolsTab('context')
    },
    [skillsListFiles, state.rootPath, setCurrentSkill, setToolsTab]
  )

  if (!builtins || builtins.length === 0) return null

  return (
    <div className="hooks-builtin">
      <div className="tools-section-label">Built-in prompts (read-only)</div>
      <p className="skills-group-hint" style={{ padding: '0 12px' }}>
        Hooks below run after these — they can only add to the prompt, not change it.
      </p>
      {builtins.map((b) => (
        <button
          key={b.name}
          type="button"
          className="tree-row skills-row"
          onClick={() => void onView(b.name)}
          title={b.description}
        >
          <span className="tree-icon">≡</span>
          <span className="tree-name">{b.name}</span>
          <span className="skills-badge">read-only</span>
        </button>
      ))}
    </div>
  )
}

// Editor for .codeswim/hooks.json — a single workspace-scoped file. Shows
// SessionStart hooks as an editable list of rows (command + optional
// timeout) rather than raw JSON, so adding a hook doesn't require hand-
// writing the file. "Open in editor" still reaches the raw file for
// anything the row editor doesn't cover.
export function HooksView(): React.JSX.Element {
  const { state, toast, hooksRead, hooksWrite, hooksOpenInEditor } = useStore()
  const rootPath = state.rootPath

  const [rows, setRows] = useState<HookRow[]>([])
  const [originalRows, setOriginalRows] = useState<HookRow[]>([])
  const [unparseable, setUnparseable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const loadId = useRef(0)

  const dirty = canonical(rows) !== canonical(originalRows)

  useEffect(() => {
    const id = ++loadId.current
    if (!rootPath) {
      void Promise.resolve().then(() => {
        if (loadId.current !== id) return
        setRows([])
        setOriginalRows([])
        setUnparseable(false)
      })
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const result = await hooksRead(rootPath)
        if (loadId.current !== id) return
        const parsed = parseHooksJson(result.content)
        setRows(parsed.rows)
        setOriginalRows(parsed.rows)
        setUnparseable(parsed.unparseable)
      } catch (err) {
        if (loadId.current !== id) return
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Could not read hooks.json: ${msg}`, 'error')
      } finally {
        if (loadId.current === id) setLoading(false)
      }
    })()
  }, [rootPath, hooksRead, toast])

  const onSave = useCallback(async () => {
    if (!rootPath) return
    setSaving(true)
    try {
      const content = serializeHooksJson(rows)
      await hooksWrite(rootPath, content)
      setOriginalRows(rows)
      setUnparseable(false)
      toast('Saved .codeswim/hooks.json', 'info')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not save hooks.json: ${msg}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [rows, hooksWrite, rootPath, toast])

  const onOpenInEditor = useCallback(async () => {
    if (!rootPath) return
    if (dirty) {
      const ok = window.confirm(
        'You have unsaved changes. Open in editor anyway? Your external editor may overwrite them.'
      )
      if (!ok) return
    }
    try {
      await hooksOpenInEditor(rootPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not open in editor: ${msg}`, 'error')
    }
  }, [dirty, hooksOpenInEditor, rootPath, toast])

  const updateRow = (index: number, patch: Partial<HookRow>): void => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const removeRow = (index: number): void => {
    setRows((prev) => prev.filter((_, i) => i !== index))
  }

  const addRow = (): void => {
    setRows((prev) => [...prev, { command: '' }])
  }

  if (!rootPath) {
    return (
      <div className="skills-empty-state">
        <h2>Hooks</h2>
        <p>Open a folder to configure hooks.</p>
      </div>
    )
  }

  return (
    <div className="skills-view">
      <div className="skills-view-header">
        <div className="skills-view-title">
          <span className="skills-scope skills-scope-workspace">workspace</span>
          <code className="skills-view-file">.codeswim/hooks.json</code>
          {dirty ? <span className="skills-dirty-dot" title="Unsaved" /> : null}
        </div>
        <div className="skills-view-actions">
          <button
            className="secondary"
            onClick={() => void onOpenInEditor()}
            title="Open hooks.json in your system's default editor"
          >
            Open in editor
          </button>
          <button className="primary" onClick={() => void onSave()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <p className="tools-mcp-soon" style={{ padding: '8px 12px', margin: 0 }}>
        Each <code>SessionStart</code> command below runs at the start of every chat turn; its
        stdout is appended to the agent&rsquo;s system prompt. A bad or missing hook is skipped,
        never fatal.
      </p>
      {unparseable ? (
        <p className="skills-dirty-dot" style={{ padding: '0 12px', color: 'var(--error, #d33)' }}>
          The existing hooks.json couldn&rsquo;t be read as hook entries — Save here will replace
          its contents. Use &ldquo;Open in editor&rdquo; first if you want to fix it by hand
          instead.
        </p>
      ) : null}
      {loading ? (
        <div className="skills-loading">Loading…</div>
      ) : (
        <div className="hooks-rows">
          {rows.length === 0 ? (
            <div className="skills-empty" style={{ padding: '4px 12px' }}>
              No hooks yet.
            </div>
          ) : (
            rows.map((row, i) => (
              <div
                key={i}
                className="hooks-row"
                style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 12px' }}
              >
                <input
                  className="skills-create-input"
                  style={{ flex: 1 }}
                  placeholder="cat .codeswim/mermaid-style.md"
                  value={row.command}
                  onChange={(e) => updateRow(i, { command: e.target.value })}
                  spellCheck={false}
                />
                <input
                  className="skills-create-input"
                  style={{ width: 90 }}
                  type="number"
                  min={1}
                  placeholder="5000ms"
                  value={row.timeout ?? ''}
                  onChange={(e) =>
                    updateRow(i, { timeout: e.target.value ? Number(e.target.value) : undefined })
                  }
                  title="Timeout in ms (optional, defaults to 5000)"
                />
                <button
                  className="sidebar-icon-btn"
                  onClick={() => removeRow(i)}
                  title="Remove hook"
                >
                  ×
                </button>
              </div>
            ))
          )}
          <button className="secondary" onClick={addRow} style={{ margin: '8px 12px' }}>
            + Add hook
          </button>
        </div>
      )}
      <BuiltinPrompts />
    </div>
  )
}

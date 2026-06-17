import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type {
  SkillFileNode,
  SkillListResult,
  SkillScope,
  SkillSummary
} from '@codeswim/contract'

const SKILL_FILENAME = 'SKILL.md'

type Group = { scope: SkillScope; label: string; skills: SkillSummary[]; hint?: string }

function buildGroups(list: SkillListResult, hasWorkspace: boolean): Group[] {
  return [
    {
      scope: 'builtin',
      label: 'System prompts',
      hint: 'Read-only prompts codeswim ships to drive the agent',
      skills: list.builtin
    },
    {
      scope: 'workspace',
      label: 'Workspace',
      hint: hasWorkspace
        ? '.agents/skills/<name>/SKILL.md in this folder'
        : 'Open a folder to see workspace skills',
      skills: list.workspace
    },
    {
      scope: 'global',
      label: 'Global',
      hint: '~/.agents/skills/<name>/SKILL.md',
      skills: list.global
    }
  ]
}

const COLLAPSED_STORAGE_KEY = 'codeswim:skillsCollapsedGroups'

function loadCollapsed(): ReadonlySet<SkillScope> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed.filter((v): v is SkillScope => v === 'workspace' || v === 'global' || v === 'builtin')
    )
  } catch {
    return new Set()
  }
}

// Key used everywhere a skill identity matters (caches, expand sets).
const skillKey = (scope: SkillScope, name: string): string => `${scope}:${name}`

export function SkillsPanel(): React.JSX.Element {
  const { state, setCurrentSkill, setToolsTab, toast } = useStore()
  const toolsTab = state.toolsTab
  const [list, setList] = useState<SkillListResult | null>(null)
  const [creatingIn, setCreatingIn] = useState<'global' | 'workspace' | null>(null)
  const [newName, setNewName] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<SkillScope>>(loadCollapsed)
  // Skills the user has explicitly opened. Lazy-loaded file trees land in
  // `trees` once expanded; collapsing again leaves the cache intact so the
  // next open is instant.
  const [expandedSkills, setExpandedSkills] = useState<ReadonlySet<string>>(() => new Set())
  const [trees, setTrees] = useState<Record<string, SkillFileNode[] | 'loading' | undefined>>({})
  // Subdirectories within a skill that the user has expanded.
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set())

  const toggleGroupCollapsed = useCallback((scope: SkillScope) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.listSkills(state.rootPath)
      setList(next)
      // Drop tree caches — file layouts may have changed underneath.
      setTrees({})
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not list skills: ${msg}`, 'error')
    }
  }, [state.rootPath, toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadSkillTree = useCallback(
    async (scope: SkillScope, name: string): Promise<void> => {
      const key = skillKey(scope, name)
      setTrees((prev) => ({ ...prev, [key]: 'loading' }))
      try {
        const tree = await window.api.listSkillFiles(scope, name, state.rootPath)
        setTrees((prev) => ({ ...prev, [key]: tree }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Could not list files: ${msg}`, 'error')
        setTrees((prev) => ({ ...prev, [key]: [] }))
      }
    },
    [state.rootPath, toast]
  )

  const onSkillClick = useCallback(
    (s: SkillSummary) => {
      const key = skillKey(s.scope, s.name)
      setExpandedSkills((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      // First time we open this skill, fetch its tree. Always select SKILL.md
      // (or the only built-in file) on click so the editor has something to
      // show even before the user clicks deeper.
      if (!trees[key] && trees[key] !== 'loading') {
        void loadSkillTree(s.scope, s.name)
      }
      const file = s.scope === 'builtin' ? builtinFileNameFromTree(trees[key]) : SKILL_FILENAME
      setCurrentSkill({
        scope: s.scope,
        name: s.name,
        linkTarget: s.linkTarget,
        file
      })
    },
    [loadSkillTree, setCurrentSkill, trees]
  )

  const onFileClick = useCallback(
    (s: SkillSummary, filePath: string) => {
      setCurrentSkill({
        scope: s.scope,
        name: s.name,
        linkTarget: s.linkTarget,
        file: filePath
      })
    },
    [setCurrentSkill]
  )

  const onDirClick = useCallback((scope: SkillScope, name: string, dirPath: string) => {
    const key = `${skillKey(scope, name)}:${dirPath}`
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const onLinkFolder = async (scope: 'global' | 'workspace'): Promise<void> => {
    if (scope === 'workspace' && !state.rootPath) {
      toast('Open a folder before linking workspace skills.', 'error')
      return
    }
    try {
      const source = await window.api.pickSkillLinkSource()
      if (!source) return
      const result = await window.api.linkSkillFolder(scope, source, state.rootPath)
      await refresh()
      const linkedCount = result.linked.length
      const skippedCount = result.skipped.length
      if (linkedCount === 0 && skippedCount === 0) {
        toast('No SKILL.md folders found in that directory.', 'info')
      } else {
        toast(`Linked ${linkedCount}; skipped ${skippedCount}`, linkedCount > 0 ? 'info' : 'error')
        if (skippedCount > 0) {
          const reasons = result.skipped
            .slice(0, 5)
            .map((s) => `${s.name}: ${s.reason}`)
            .join(' · ')
          // eslint-disable-next-line no-console
          console.info('[codeswim] skipped skill links:', reasons)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not link folder: ${msg}`, 'error')
    }
  }

  const onCreate = async (scope: 'global' | 'workspace'): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    if (!/^[A-Za-z0-9._ -]+$/.test(name)) {
      toast(
        'Skill name can only contain letters, digits, spaces, dots, dashes and underscores.',
        'error'
      )
      return
    }
    if (scope === 'workspace' && !state.rootPath) {
      toast('Open a folder before creating a workspace skill.', 'error')
      return
    }
    const template = `---
name: ${name}
description: |
  One-line summary of when the agent should reach for this skill.
---

# ${name}

Write the skill body here. Use the description above to explain *when* the
agent should pick this up; use this body to explain *what* it should do.
`
    try {
      await window.api.writeSkill(scope, name, template, state.rootPath)
      setCreatingIn(null)
      setNewName('')
      await refresh()
      setCurrentSkill({ scope, name, file: SKILL_FILENAME })
      setExpandedSkills((prev) => new Set(prev).add(skillKey(scope, name)))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not create skill: ${msg}`, 'error')
    }
  }

  const groups = useMemo(
    () => (list ? buildGroups(list, !!state.rootPath) : []),
    [list, state.rootPath]
  )
  const active = state.currentSkill

  const openAgentsDoc = useCallback(
    (scope: 'workspace' | 'global') => {
      setCurrentSkill({
        kind: 'agents',
        scope,
        name: scope === 'global' ? 'Global AGENTS.md' : 'AGENTS.md',
        file: 'AGENTS.md'
      })
    },
    [setCurrentSkill]
  )
  const isAgentsActive = (scope: 'workspace' | 'global'): boolean =>
    active?.kind === 'agents' && active.scope === scope

  const renderGroup = (g: Group): React.JSX.Element => {
    const isGroupCollapsed = collapsedGroups.has(g.scope)
    return (
      <div key={g.scope} className="skills-group">
        <div className="skills-group-header">
          <button
            type="button"
            className="skills-group-toggle"
            onClick={() => toggleGroupCollapsed(g.scope)}
            aria-expanded={!isGroupCollapsed}
            title={isGroupCollapsed ? `Expand ${g.label}` : `Collapse ${g.label}`}
          >
            <span className="skills-group-chevron">{isGroupCollapsed ? '▸' : '▾'}</span>
            <span className="skills-group-label">{g.label}</span>
            <span className="skills-group-count">{g.skills.length}</span>
          </button>
          {g.scope !== 'builtin' ? (
            <div className="skills-group-actions">
              <button
                className="sidebar-icon-btn"
                onClick={() => void onLinkFolder(g.scope as 'global' | 'workspace')}
                title={`Link a folder of SKILL.md trees into ${g.label.toLowerCase()}`}
                disabled={g.scope === 'workspace' && !state.rootPath}
              >
                ⇲
              </button>
              <button
                className="sidebar-icon-btn"
                onClick={() =>
                  setCreatingIn((prev) =>
                    prev === g.scope ? null : (g.scope as 'global' | 'workspace')
                  )
                }
                title={`New ${g.label.toLowerCase()} skill`}
                disabled={g.scope === 'workspace' && !state.rootPath}
              >
                +
              </button>
            </div>
          ) : null}
        </div>
        {isGroupCollapsed ? null : (
          <>
            {g.hint ? <div className="skills-group-hint">{g.hint}</div> : null}
            {creatingIn === g.scope ? (
              <div className="skills-create-row">
                <input
                  autoFocus
                  className="skills-create-input"
                  placeholder="skill-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onCreate(g.scope as 'global' | 'workspace')
                    else if (e.key === 'Escape') {
                      setCreatingIn(null)
                      setNewName('')
                    }
                  }}
                />
                <button
                  className="skills-create-confirm"
                  onClick={() => void onCreate(g.scope as 'global' | 'workspace')}
                >
                  Create
                </button>
              </div>
            ) : null}
            {g.skills.length === 0 ? (
              <div className="skills-empty">
                {g.scope === 'workspace' && !state.rootPath
                  ? '—'
                  : g.scope === 'builtin'
                    ? 'No system prompts available.'
                    : 'None yet.'}
              </div>
            ) : (
              g.skills.map((s) => (
                <SkillRow
                  key={`${s.scope}:${s.name}`}
                  skill={s}
                  isExpanded={expandedSkills.has(skillKey(s.scope, s.name))}
                  tree={trees[skillKey(s.scope, s.name)]}
                  expandedDirs={expandedDirs}
                  active={active}
                  onSkillClick={onSkillClick}
                  onFileClick={onFileClick}
                  onDirClick={onDirClick}
                />
              ))
            )}
          </>
        )}
      </div>
    )
  }

  const agentsRow = (scope: 'workspace' | 'global', disabled: boolean): React.JSX.Element => (
    <button
      type="button"
      className={`tree-row skills-row tools-agents-row ${isAgentsActive(scope) ? 'current' : ''}`}
      onClick={() => openAgentsDoc(scope)}
      disabled={disabled}
      title={`${scope === 'global' ? 'Global' : 'Workspace'} agent instructions (AGENTS.md)`}
    >
      <span className="tree-icon">≡</span>
      <span className="tree-name">AGENTS.md</span>
      <span className="skills-badge">{scope}</span>
    </button>
  )

  const skillGroups = groups.filter((g) => g.scope !== 'builtin')
  const systemPrompts = groups.find((g) => g.scope === 'builtin')

  return (
    <aside className="sidebar" aria-label="Tools">
      <div className="sidebar-header">
        <span className="sidebar-title">Tools</span>
        {toolsTab !== 'mcp' ? (
          <button className="sidebar-icon-btn" onClick={() => void refresh()} title="Refresh">
            ↻
          </button>
        ) : null}
      </div>
      <div className="tools-tabs" role="tablist" aria-label="Tool types">
        <button
          role="tab"
          aria-selected={toolsTab === 'skills'}
          className={`tools-tab ${toolsTab === 'skills' ? 'is-active' : ''}`}
          onClick={() => setToolsTab('skills')}
        >
          Skills
        </button>
        <button
          role="tab"
          aria-selected={toolsTab === 'mcp'}
          className={`tools-tab ${toolsTab === 'mcp' ? 'is-active' : ''}`}
          onClick={() => setToolsTab('mcp')}
        >
          MCP
        </button>
        <button
          role="tab"
          aria-selected={toolsTab === 'context'}
          className={`tools-tab ${toolsTab === 'context' ? 'is-active' : ''}`}
          onClick={() => setToolsTab('context')}
        >
          Context
        </button>
      </div>
      {toolsTab === 'mcp' ? (
        <div className="sidebar-body">
          <div className="tools-mcp-empty">
            <div className="tools-mcp-title">MCP servers</div>
            <p>
              Connect Model Context Protocol servers to give the agent extra tools and data sources.
            </p>
            <p className="tools-mcp-soon">Configuration is coming soon.</p>
          </div>
        </div>
      ) : toolsTab === 'context' ? (
        <div className="sidebar-body">
          <div className="tools-section-label">Agent instructions</div>
          {agentsRow('workspace', !state.rootPath)}
          {agentsRow('global', false)}
          {list === null ? (
            <div className="sidebar-empty">Loading…</div>
          ) : systemPrompts ? (
            renderGroup(systemPrompts)
          ) : null}
        </div>
      ) : (
        <div className="sidebar-body">
          {list === null ? (
            <div className="sidebar-empty">Loading…</div>
          ) : (
            skillGroups.map(renderGroup)
          )}
        </div>
      )}
    </aside>
  )
}

function builtinFileNameFromTree(tree: SkillFileNode[] | 'loading' | undefined): string {
  if (!tree || tree === 'loading') return SKILL_FILENAME
  const first = tree.find((n) => n.kind === 'file')
  return first?.path ?? SKILL_FILENAME
}

interface SkillRowProps {
  skill: SkillSummary
  isExpanded: boolean
  tree: SkillFileNode[] | 'loading' | undefined
  expandedDirs: ReadonlySet<string>
  active: {
    scope: 'global' | 'workspace' | 'builtin'
    name: string
    linkTarget?: string
    file?: string
  } | null
  onSkillClick: (skill: SkillSummary) => void
  onFileClick: (skill: SkillSummary, filePath: string) => void
  onDirClick: (scope: SkillScope, name: string, dirPath: string) => void
}

function SkillRow({
  skill,
  isExpanded,
  tree,
  expandedDirs,
  active,
  onSkillClick,
  onFileClick,
  onDirClick
}: SkillRowProps): React.JSX.Element {
  const isCurrent = active && active.scope === skill.scope && active.name === skill.name
  const dirKey = (dirPath: string): string => `${skill.scope}:${skill.name}:${dirPath}`
  const isDirOpen = (dirPath: string): boolean => expandedDirs.has(dirKey(dirPath))

  return (
    <>
      <button
        type="button"
        className={`tree-row skills-row ${isCurrent ? 'current' : ''}`}
        onClick={() => onSkillClick(skill)}
        title={
          skill.linkTarget ? `linked from ${skill.linkTarget}` : skill.description || skill.name
        }
      >
        <span className="tree-icon">{isExpanded ? '▾' : '▸'}</span>
        <span className="tree-name">{skill.name}</span>
        {skill.readOnly ? (
          <span className="skills-badge">read-only</span>
        ) : skill.linkTarget ? (
          <span className="skills-badge skills-badge-link">linked</span>
        ) : null}
      </button>
      {isExpanded ? (
        tree === 'loading' || tree === undefined ? (
          <div className="skills-empty" style={{ paddingLeft: 32 }}>
            Loading…
          </div>
        ) : tree.length === 0 ? (
          <div className="skills-empty" style={{ paddingLeft: 32 }}>
            (empty)
          </div>
        ) : (
          <TreeChildren
            nodes={tree}
            depth={1}
            skill={skill}
            active={active}
            isDirOpen={isDirOpen}
            onFileClick={onFileClick}
            onDirClick={onDirClick}
          />
        )
      ) : null}
    </>
  )
}

interface TreeChildrenProps {
  nodes: SkillFileNode[]
  depth: number
  skill: SkillSummary
  active: SkillRowProps['active']
  isDirOpen: (dirPath: string) => boolean
  onFileClick: SkillRowProps['onFileClick']
  onDirClick: SkillRowProps['onDirClick']
}

function TreeChildren({
  nodes,
  depth,
  skill,
  active,
  isDirOpen,
  onFileClick,
  onDirClick
}: TreeChildrenProps): React.JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        const isDir = node.kind === 'dir'
        const opened = isDir && isDirOpen(node.path)
        const isCurrent =
          !isDir &&
          active?.scope === skill.scope &&
          active.name === skill.name &&
          active.file === node.path
        return (
          <div key={node.path}>
            <button
              type="button"
              className={`tree-row skills-file-row ${isCurrent ? 'current' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() =>
                isDir
                  ? onDirClick(skill.scope, skill.name, node.path)
                  : onFileClick(skill, node.path)
              }
              title={node.path}
            >
              <span className="tree-icon">{isDir ? (opened ? '▾' : '▸') : '·'}</span>
              <span className="tree-name">{node.name}</span>
            </button>
            {isDir && opened && node.children ? (
              <TreeChildren
                nodes={node.children}
                depth={depth + 1}
                skill={skill}
                active={active}
                isDirOpen={isDirOpen}
                onFileClick={onFileClick}
                onDirClick={onDirClick}
              />
            ) : null}
          </div>
        )
      })}
    </>
  )
}

import { useState } from 'react'
import { useStore, type Section } from '../store'

interface Item {
  key: Section
  label: string
  icon: React.JSX.Element
}

// 24×24, 1.5px stroke, currentColor — matches VS Code Codicon proportions
// at our 48px-wide activity bar.

function FolderIcon(): React.JSX.Element {
  return (
    <svg width="27" height="27" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5a2 2 0 0 1 2-2h3.59a2 2 0 0 1 1.41.59l1 1A2 2 0 0 0 12.41 6.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChatIcon(): React.JSX.Element {
  return (
    <svg width="27" height="27" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 4v-4H5.5A1.5 1.5 0 0 1 4 14.5v-9z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg width="27" height="27" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.5" />
      <line
        x1="15.5"
        y1="15.5"
        x2="20"
        y2="20"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ToolsIcon(): React.JSX.Element {
  // Wrench — the Tools section hosts skills, MCP servers, and other agent
  // capabilities, so a generic tool glyph rather than the old skill book.
  return (
    <svg width="27" height="27" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function TerminalIcon(): React.JSX.Element {
  return (
    <svg width="27" height="27" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M7 9l3.5 3L7 15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="13"
        y1="15"
        x2="17"
        y2="15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function GitIcon(): React.JSX.Element {
  // Commit-graph glyph: two nodes on a line with a branch tap.
  return (
    <svg width="27" height="27" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="17" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 8.5v7M6 12h8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function PeopleIcon(): React.JSX.Element {
  // Two figures — distinct from the agent's single chat bubble; this is the
  // "chat with other people on this project" section.
  return (
    <svg width="27" height="27" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M3.5 19a5.5 5.5 0 0 1 11 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M16 5.5a3 3 0 0 1 0 5.8M17 14.2a5.5 5.5 0 0 1 3.5 4.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

const ITEM_BY_KEY: Record<Section, Item> = {
  agent: { key: 'agent', label: 'Agent', icon: <ChatIcon /> },
  files: { key: 'files', label: 'Files', icon: <FolderIcon /> },
  search: { key: 'search', label: 'Search', icon: <SearchIcon /> },
  tools: { key: 'tools', label: 'Tools', icon: <ToolsIcon /> },
  git: { key: 'git', label: 'Commit', icon: <GitIcon /> },
  terminal: { key: 'terminal', label: 'Terminal', icon: <TerminalIcon /> },
  chat: { key: 'chat', label: 'Chat', icon: <PeopleIcon /> }
}

export function ActivityBar(): React.JSX.Element {
  const { state, toggleActiveSection, setActivityOrder } = useStore()
  const active = state.activeSection
  const [dragKey, setDragKey] = useState<Section | null>(null)
  const [dropBeforeKey, setDropBeforeKey] = useState<Section | null>(null)

  const onDragStart = (e: React.DragEvent<HTMLButtonElement>, key: Section): void => {
    setDragKey(key)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', key)
  }

  const onDragOver = (e: React.DragEvent<HTMLButtonElement>, key: Section): void => {
    if (!dragKey || dragKey === key) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropBeforeKey(key)
  }

  const onDragEnd = (): void => {
    setDragKey(null)
    setDropBeforeKey(null)
  }

  const onDrop = (e: React.DragEvent<HTMLButtonElement>, targetKey: Section): void => {
    e.preventDefault()
    const source = (e.dataTransfer.getData('text/plain') as Section) || dragKey
    setDragKey(null)
    setDropBeforeKey(null)
    if (!source || source === targetKey) return
    const next = state.activityOrder.filter((k) => k !== source)
    const idx = next.indexOf(targetKey)
    next.splice(idx >= 0 ? idx : next.length, 0, source)
    setActivityOrder(next)
  }

  return (
    <nav className="activity-bar" aria-label="Sections">
      {state.activityOrder.map((key) => {
        const item = ITEM_BY_KEY[key]
        if (!item) return null
        const isActive = active === key
        const isDropTarget = dropBeforeKey === key && dragKey !== key
        return (
          <button
            key={key}
            className={`activity-btn ${isActive ? 'is-active' : ''} ${isDropTarget ? 'is-drop-target' : ''}`}
            onClick={() => toggleActiveSection(key)}
            title={`${item.label}${isActive ? ' (click to hide)' : ''}`}
            aria-label={item.label}
            aria-pressed={isActive}
            draggable
            onDragStart={(e) => onDragStart(e, key)}
            onDragOver={(e) => onDragOver(e, key)}
            onDragLeave={() => setDropBeforeKey((prev) => (prev === key ? null : prev))}
            onDrop={(e) => onDrop(e, key)}
            onDragEnd={onDragEnd}
          >
            {item.icon}
          </button>
        )
      })}
    </nav>
  )
}

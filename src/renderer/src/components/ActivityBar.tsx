import { useState } from 'react'
import { useStore } from '../store'

type Section = 'agent' | 'files' | 'search'

interface Item {
  key: Section
  label: string
  icon: React.JSX.Element
}

// 24×24, 1.5px stroke, currentColor — matches VS Code Codicon proportions
// at our 48px-wide activity bar.

function FolderIcon(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

const ITEM_BY_KEY: Record<Section, Item> = {
  agent: { key: 'agent', label: 'Agent', icon: <ChatIcon /> },
  files: { key: 'files', label: 'Files', icon: <FolderIcon /> },
  search: { key: 'search', label: 'Search', icon: <SearchIcon /> }
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

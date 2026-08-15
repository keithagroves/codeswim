// Builds the first message sent to a freshly-opened agent tab when a Kanban
// card's "Start" button is clicked. Pure so it's testable without the store.

import type { KanbanCard } from '@codeswim/contract'

const PRIORITY_LABEL: Record<KanbanCard['priority'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

export function buildCardPrompt(card: KanbanCard): string {
  const lines = [`Work on this task from the board: "${card.title}"`, '']
  if (card.description.trim()) lines.push(card.description.trim(), '')
  lines.push(`Priority: ${PRIORITY_LABEL[card.priority]}`)
  if (card.labels.length > 0) lines.push(`Labels: ${card.labels.join(', ')}`)
  if (card.linkedPath) lines.push(`Related file/diagram: ${card.linkedPath}`)
  lines.push('', 'Start working on this now.')
  return lines.join('\n')
}

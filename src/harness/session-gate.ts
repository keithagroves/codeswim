// Tracks whether each agent session has touched a diagram yet.
//
// The system prompt tells the agent to edit diagrams before code; the gate is
// what makes that rule enforceable instead of suggested. The wiring layer
// (where tools are dispatched) calls `checkCodeEditAllowed` before any
// code-mutating tool fires.

export interface SessionGate {
  markDiagramEdited(sessionId: string): void
  checkCodeEditAllowed(sessionId: string): string | null
  reset(sessionId: string): void
  snapshot(sessionId: string): { diagramEdited: boolean }
}

interface State {
  diagramEdited: boolean
}

export function createSessionGate(): SessionGate {
  const state = new Map<string, State>()

  function get(sessionId: string): State {
    let s = state.get(sessionId)
    if (!s) {
      s = { diagramEdited: false }
      state.set(sessionId, s)
    }
    return s
  }

  return {
    markDiagramEdited(sessionId) {
      get(sessionId).diagramEdited = true
    },
    checkCodeEditAllowed(sessionId) {
      if (get(sessionId).diagramEdited) return null
      return (
        'code edits are gated on at least one prior `diagram_edit` call in this session — ' +
        'update the relevant diagram(s) first so the architecture is in sync with the code change'
      )
    },
    reset(sessionId) {
      state.delete(sessionId)
    },
    snapshot(sessionId) {
      return { diagramEdited: get(sessionId).diagramEdited }
    }
  }
}

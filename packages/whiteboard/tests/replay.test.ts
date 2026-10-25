// Replays saved conversations through the turn scheduler and the board model
// with a fake speaker, and checks the invariants the prototype learned the
// hard way: no overlapping boxes, arrows only join boxes on their own page,
// picks only name offered options, and nothing is cleared unless asked.
//
// Fixtures are real conversations captured with the prototype
// (~/projects/anim/canvas, `window.talkLog`), converted to the line protocol.
// To add one: capture a conversation, convert each turn to
// { question, lines: [...reply lines] }, and drop it in tests/fixtures/.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoardModel, boundsOf, type BoxEl } from '../src/board'
import { asksToClear, guardCmd } from '../src/guards'
import { isPageCmd } from '../src/page'
import { Turn, type Msg, type NarratorTransport } from '../src/turn'
import { parseLine, toSay, type Cmd } from '../src/protocol'

interface FixtureTurn {
  question: string
  lines: string[]
}

const dir = path.join(__dirname, 'fixtures')
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    name: f,
    turns: JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as FixtureTurn[]
  }))

/** Plays one fixture turn: the first sentence as the opener, the rest as one main part. */
function transportFor(turn: FixtureTurn): NarratorTransport {
  const firstSay = turn.lines.findIndex((l) => {
    const o = parseLine(l)
    return o ? toSay(o) !== null : false
  })
  const opener = firstSay >= 0 ? turn.lines[firstSay] : '{"say":"Okay."}'
  const main = turn.lines.filter((_, i) => i !== firstSay).join('\n')
  return {
    async open(mode) {
      return { send: async () => (mode === 'opener' ? opener : main) }
    }
  }
}

function assertBoardInvariants(board: BoardModel, where: string): void {
  for (const page of board.pages) {
    const els = board.elements(page.id)
    const boxes = els.filter((e): e is BoxEl => e.kind === 'box')
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boundsOf(boxes[i])!
        const b = boundsOf(boxes[j])!
        const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        expect(hit, `${where}: ${boxes[i].name} overlaps ${boxes[j].name} on "${page.name}"`).toBe(
          false
        )
      }
    }
    for (const e of els) {
      if (e.kind !== 'arrow') continue
      const names = new Set(
        els
          .filter((x) => x.kind === 'box' || x.kind === 'group')
          .map((x) => ('name' in x ? x.name : ''))
      )
      expect(
        names.has(e.from) && names.has(e.to),
        `${where}: arrow ${e.name} leaves page "${page.name}"`
      ).toBe(true)
    }
  }
}

describe.each(fixtures)('replay $name', ({ turns }) => {
  it('keeps the board legible and the guards in force', async () => {
    const board = new BoardModel()
    const history: Msg[] = []
    for (const [i, t] of turns.entries()) {
      const mayClear = asksToClear(t.question)
      const applied: Cmd[] = []
      const turn = new Turn(
        {
          transport: transportFor(t),
          speaker: { speak: async (_text, onStart) => onStart?.(), cancel: () => {} },
          run: async (cmd) => {
            if (isPageCmd(cmd)) return
            if (cmd.op === 'pick') {
              // A pick reaching the board must name an option offered earlier.
              const ok = guardCmd(cmd, { mayClear, board })
              if (ok) expect(board.offered, `turn ${i}: pick ${cmd.name}`).toContain(cmd.name)
              if (!ok) return
            }
            applied.push(cmd)
            board.apply(cmd)
          },
          describe: () => board.describe(),
          delays: { filler: 10_000, gate: 10_000 }
        },
        { question: t.question, history, mode: 'talk' }
      )
      const result = await turn.done
      expect(result.error, `turn ${i}`).toBeUndefined()
      if (!mayClear)
        expect(
          applied.some((c) => c.op === 'clear'),
          `turn ${i}: cleared without asking`
        ).toBe(false)
      history.push(
        { role: 'user', content: t.question },
        { role: 'assistant', content: result.reply }
      )
      assertBoardInvariants(board, `turn ${i}`)
    }
    // Something was actually drawn. (Older captures predate pages, so the
    // first page may stay unnamed.)
    expect(board.pages.reduce((n, p) => n + board.elements(p.id).length, 0)).toBeGreaterThan(5)
  })
})

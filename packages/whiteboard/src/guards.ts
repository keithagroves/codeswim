// Rules enforced in code, not just asked for in the prompt. The prototype
// found the model breaks each of these even when told not to.

import type { BoardModel } from './board'
import type { Cmd } from './protocol'

/** The board is the person's: the narrator may only wipe it when they ask for a fresh start. */
export function asksToClear(text: string): boolean {
  return /\b(clear|wipe|erase|start over|from scratch|fresh start|blank (board|page)|new (board|diagram|drawing))\b/i.test(
    text
  )
}

const YES =
  /\b(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|go for it|do it|build it|build that|build this|ship it|let'?s (do it|build|go)|sounds good|looks good|lgtm|make it|start building|please do|approved?|agreed)\b/i
const NO =
  /\b(no|nope|not yet|don'?t|do not|wait|hold on|hold off|stop|instead|rather|but first|before (you|we) build)\b/i

/**
 * Whether the person's message agrees to building. Building starts only on an
 * explicit yes: a hedge ("yes, but first…") or a question isn't one.
 */
export function agreesToBuild(text: string): boolean {
  const t = text.trim()
  if (!t || !YES.test(t)) return false
  if (NO.test(t)) return false
  // "Should we build it?" is asking, not agreeing.
  if (/\?\s*$/.test(t) && !/^(yes|yeah|yep|sure|ok(ay)?)\b/i.test(t)) return false
  return true
}

// A request to change something, said as an instruction: "make them even
// wider", "can you move the button up?", "actually, let's use blue".
const CHANGE =
  /^(?:(?:ok(?:ay)?|actually|hmm|great|nice|cool|now|and|so|also|please|but)[,!.]?\s+)*(?:(?:let'?s|can you|could you|would you|will you|go ahead and|i'?d like (?:you )?to|i want (?:you )?to)\s+)?(?:please\s+)?(?:make|change|move|add|remove|delete|drop|rename|increase|decrease|shrink|enlarge|widen|narrow|swap|switch|use|put|turn|set|fix|bump|reduce|center|centre|align|hide|show|replace|try|give|tweak|adjust|darken|lighten|round)\b/i
const NOT_YET =
  /\b(wait|hold on|hold off|not yet|don'?t build|before (you|we) (build|change)|what if|should we|would it)\b/i

/**
 * Whether the person's message asks for a change outright. Right after a
 * build, that is itself the go-ahead for a small follow-up ("make them even
 * wider"); a question about options ("what if…", "should we…") isn't.
 */
export function asksForChange(text: string): boolean {
  const t = text.trim()
  return !!t && CHANGE.test(t) && !NOT_YET.test(t)
}

/** `pick` may only name an option the narrator actually offered (and the board still shows). */
export function canPick(board: BoardModel, name: string): boolean {
  const el = board.named(name)
  return board.offered.includes(name) && !!el && el.kind === 'box' && !!el.option
}

/**
 * Filter one drawing command through the guards. Returns null when it must
 * be dropped.
 */
export function guardCmd(cmd: Cmd, ctx: { mayClear: boolean; board: BoardModel }): Cmd | null {
  if (cmd.op === 'clear' && !ctx.mayClear) return null
  if (cmd.op === 'pick' && !canPick(ctx.board, cmd.name)) return null
  return cmd
}

// Words that carry no meaning of their own; two sentences sharing only these
// aren't saying the same thing.
const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i in is it its it's of on or so that the then this to was we with you your".split(
    ' '
  )
)

/**
 * Whether two sentences say much the same thing: most of their meaningful
 * words in common, measured against the longer one. Measuring against the
 * shorter one let a short opener ("Postgres it is.") swallow a real sentence
 * that merely mentioned Postgres.
 */
export function similar(a: string, b: string): boolean {
  const words = (s: string): Set<string> =>
    new Set((s.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => !STOPWORDS.has(w)))
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return false
  const common = [...x].filter((w) => y.has(w)).length
  return common / Math.max(x.size, y.size) > 0.5
}

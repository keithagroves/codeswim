import type {
  CommandAgentTier,
  CommandDanger,
  CommandDescriptor,
  CommandErrorCode,
  CommandOrigin,
  JSONSchema
} from '@codeswim/contract'
import type { CommandCtx, CommandCtxFactory } from './context'
import { validateAgainstSchema } from './schema'

export interface Command<A = unknown, R = unknown> {
  id: string // 'nav.navigateAbsolute'
  domain: string // derived from the id prefix, e.g. 'nav'
  title: string // human label (future palette)
  description: string // one line, agent-facing
  schema: JSONSchema // structural args shape, checked before validate/run
  // Semantic validation — paths, current selection, cross-field rules. Runs
  // after schema validation, before danger confirmation and run.
  validate?(args: A, ctx: CommandCtx): void
  agent: CommandAgentTier
  danger?: CommandDanger & { summarize(args: A, ctx: CommandCtx): string }
  run(args: A, ctx: CommandCtx): Promise<R>
}

export class CommandRegistryError extends Error {
  readonly code: CommandErrorCode
  constructor(code: CommandErrorCode, message: string) {
    super(message)
    this.name = 'CommandRegistryError'
    this.code = code
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toDescriptor(c: Command<unknown, unknown>): CommandDescriptor {
  return {
    id: c.id,
    domain: c.domain,
    title: c.title,
    description: c.description,
    schema: c.schema,
    agent: c.agent,
    danger: c.danger ? { kind: c.danger.kind } : undefined
  }
}

// The single registry every command-invoking surface — UI components,
// keybindings, the agent bridge — calls through. `buildCtx` is invoked fresh
// on every `run`, so handlers always observe state/roots as of the call, not
// as of registry construction.
export class CommandRegistry {
  private readonly commands = new Map<string, Command<unknown, unknown>>()

  constructor(private readonly buildCtx: CommandCtxFactory) {}

  register<A, R>(command: Command<A, R>): void {
    if (this.commands.has(command.id)) {
      throw new CommandRegistryError('duplicate-command', `command already registered: ${command.id}`)
    }
    this.commands.set(command.id, command as Command<unknown, unknown>)
  }

  describe(id: string): CommandDescriptor | undefined {
    const c = this.commands.get(id)
    return c ? toDescriptor(c) : undefined
  }

  // Ranked search over agent-listed commands, for the agent's find_command
  // tool. 'hot' commands are described by their own dedicated tool instead;
  // 'never' commands must not surface here regardless of match strength.
  find(query: string): CommandDescriptor[] {
    const q = query.trim().toLowerCase()
    const listed = [...this.commands.values()].filter((c) => c.agent === 'listed')
    const matches = !q
      ? listed
      : listed.filter(
          (c) =>
            c.id.toLowerCase().includes(q) ||
            c.title.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q) ||
            c.domain.toLowerCase().includes(q)
        )
    return matches.map(toDescriptor)
  }

  async run<R = unknown>(id: string, args: unknown, origin: CommandOrigin): Promise<R> {
    const command = this.commands.get(id)
    if (!command) {
      throw new CommandRegistryError('unknown-command', `unknown command: ${id}`)
    }
    if (origin.kind === 'agent' && command.agent === 'never') {
      throw new CommandRegistryError('forbidden-origin', `command not available to agents: ${id}`)
    }
    const schemaError = validateAgainstSchema(args, command.schema)
    if (schemaError) {
      throw new CommandRegistryError('invalid-args', `${id}: ${schemaError}`)
    }
    const ctx = this.buildCtx(origin)
    try {
      command.validate?.(args, ctx)
    } catch (err) {
      throw new CommandRegistryError('invalid-args', `${id}: ${errorMessage(err)}`)
    }
    if (command.danger) {
      const allowed = await ctx.confirm(command.danger, command.danger.summarize(args, ctx))
      if (!allowed) {
        throw new CommandRegistryError('denied', `command denied: ${id}`)
      }
    }
    try {
      return (await command.run(args, ctx)) as R
    } catch (err) {
      if (err instanceof CommandRegistryError) throw err
      throw new CommandRegistryError('handler-error', `${id}: ${errorMessage(err)}`)
    }
  }
}

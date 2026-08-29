import type { AgentsDocContent } from '@codeswim/contract'
import type { CommandCtx } from './context'
import type { CommandRegistry } from './registry'

export interface HooksReadArgs {
  root: string | null
}

export interface HooksWriteArgs {
  content: string
  root: string | null
}

export interface HooksOpenInEditorArgs {
  root: string | null
}

const NULLABLE_ROOT = { type: 'string', nullable: true } as const

export function registerHooksCommands(registry: CommandRegistry): void {
  registry.register<HooksReadArgs, AgentsDocContent>({
    id: 'hooks.read',
    domain: 'hooks',
    title: 'Read .codeswim/hooks.json',
    description: 'Reads the workspace SessionStart hooks config.',
    schema: { type: 'object', required: ['root'], properties: { root: NULLABLE_ROOT } },
    agent: 'listed',
    run: (args, ctx: CommandCtx) => ctx.api.hooksRead(args.root)
  })

  registry.register<HooksWriteArgs, void>({
    id: 'hooks.write',
    domain: 'hooks',
    title: 'Write .codeswim/hooks.json',
    description: 'Writes the workspace SessionStart hooks config.',
    schema: {
      type: 'object',
      required: ['content', 'root'],
      properties: { content: { type: 'string' }, root: NULLABLE_ROOT }
    },
    // Same reasoning as skills.writeAgentsDoc: hooks feed the agent's own
    // system prompt, so letting an agent rewrite its own config is a direct
    // self-modification path.
    agent: 'never',
    run: (args, ctx) => ctx.api.hooksWrite(args.root, args.content)
  })

  registry.register<HooksOpenInEditorArgs, void>({
    id: 'hooks.openInEditor',
    domain: 'hooks',
    title: 'Open hooks.json in editor',
    description: "Opens .codeswim/hooks.json in the system's default editor.",
    schema: { type: 'object', required: ['root'], properties: { root: NULLABLE_ROOT } },
    agent: 'never',
    run: (args, ctx) => ctx.api.hooksOpenInEditor(args.root)
  })
}

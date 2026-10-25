// Whiteboard commands on the command bus, so keybindings, the UI and the
// agent reach the feature the same way (plans/talking-whiteboard.md).
//
// `whiteboard.ask` is human-only on purpose: the narrator honors a build line
// only when the person's own message agreed, and an agent able to put words
// in the person's mouth ("yes, build it") would walk straight past that
// guard — and talk out loud in their room besides.

import type { CommandRegistry } from './registry'
import { assertRelativeWorkspacePath } from './path-guard'

/** The slice of WhiteboardController the commands drive. */
export interface WhiteboardCommandTarget {
  ask(text: string): Promise<void>
  interrupt(): void
  openLink(path: string): Promise<void>
}

export interface WhiteboardAskArgs {
  text: string
}

export interface WhiteboardOpenLinkArgs {
  path: string
}

export function registerWhiteboardCommands(
  registry: CommandRegistry,
  target: () => WhiteboardCommandTarget
): void {
  registry.register<WhiteboardAskArgs, void>({
    id: 'whiteboard.ask',
    domain: 'whiteboard',
    title: 'Ask the whiteboard',
    description: 'Ask the whiteboard narrator something; it answers out loud while sketching.',
    schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    validate: (args) => {
      if (!args.text.trim()) throw new Error('text: expected a question')
    },
    agent: 'never',
    run: async (args, ctx) => {
      ctx.dispatch({ type: 'set-workspace-view', view: 'whiteboard' })
      // Don't hold the caller for the whole spoken turn.
      void target().ask(args.text)
    }
  })

  registry.register<Record<string, never>, void>({
    id: 'whiteboard.stop',
    domain: 'whiteboard',
    title: 'Stop the whiteboard narrator',
    description: 'Stops the whiteboard narrator mid-sentence. A running build carries on.',
    schema: { type: 'object' },
    agent: 'listed',
    run: async () => {
      target().interrupt()
    }
  })

  registry.register<WhiteboardOpenLinkArgs, void>({
    id: 'whiteboard.openLink',
    domain: 'whiteboard',
    title: 'Open a whiteboard link',
    description: 'Opens the workspace diagram or file a whiteboard box links to, in the navigator.',
    schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    validate: (args) => assertRelativeWorkspacePath(args.path, 'path'),
    agent: 'listed',
    run: async (args) => {
      await target().openLink(args.path)
    }
  })
}

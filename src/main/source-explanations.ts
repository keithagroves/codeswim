import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface SourceExplanation {
  sourcePath: string
  documentPath: string
  content: string
  exists: boolean
}

function resolveInside(rootPath: string, relPath: string): string {
  const root = path.resolve(rootPath)
  const absolute = path.resolve(root, relPath)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error('path escapes the workspace')
  }
  return absolute
}

function canonicalExplanationPath(sourcePath: string): string {
  return path.posix.join('.codeswim', 'explanations', `${sourcePath.replace(/\\/g, '/')}.md`)
}

async function firstReadable(
  rootPath: string,
  candidates: string[]
): Promise<{ path: string; content: string } | null> {
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(resolveInside(rootPath, candidate), 'utf-8')
      return { path: candidate, content }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return null
}

function fallbackExplanation(sourcePath: string, documentPath: string): string {
  const name = path.posix.basename(sourcePath)
  return `---
name: ${JSON.stringify(name)}
description: ${JSON.stringify(`Explanation for ${sourcePath}`)}
tags: [source, explanation, missing]
---

\`${sourcePath}\` is an implementation leaf. Codeswim intentionally does not
render its source code here.

The companion document belongs at:

\`${documentPath}\`

## What to document

- The responsibility this file owns.
- The inputs it accepts and outputs it produces.
- The important control flow and state transitions.
- Dependencies, side effects, and failure modes.
- Links back to the architecture, flow, and decision documents that explain why it exists.
`
}

export async function readSourceExplanation(
  rootPath: string,
  sourcePath: string
): Promise<SourceExplanation> {
  await fs.access(resolveInside(rootPath, sourcePath))
  const normalized = sourcePath.replace(/\\/g, '/')
  const canonical = canonicalExplanationPath(normalized)
  const ext = path.posix.extname(normalized)
  const sibling = ext ? `${normalized.slice(0, -ext.length)}.md` : `${normalized}.md`
  const adjacent = `${normalized}.md`
  const found = await firstReadable(rootPath, [...new Set([canonical, adjacent, sibling])])

  if (found) {
    return {
      sourcePath: normalized,
      documentPath: found.path,
      content: found.content,
      exists: true
    }
  }

  return {
    sourcePath: normalized,
    documentPath: canonical,
    content: fallbackExplanation(normalized, canonical),
    exists: false
  }
}

export function resolveWorkspaceFile(rootPath: string, relPath: string): string {
  return resolveInside(rootPath, relPath)
}

import { load as loadYaml } from 'js-yaml'

export interface Frontmatter {
  name?: string
  description?: string
  tags?: string[]
}

export interface ParsedDoc {
  frontmatter: Frontmatter
  prose: string
  mermaidBlocks: string[]
}

function extractFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') return { frontmatter: {}, body: normalized }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { frontmatter: {}, body: normalized }

  let parsed: Frontmatter = {}
  try {
    const obj = loadYaml(lines.slice(1, end).join('\n'))
    if (obj && typeof obj === 'object') parsed = obj as Frontmatter
  } catch {
    // ignore malformed frontmatter — show prose as-is
  }
  return { frontmatter: parsed, body: lines.slice(end + 1).join('\n') }
}

function openingFence(line: string): { marker: '`' | '~'; length: number; info: string } | null {
  const match = line.match(/^([`~]{3,})(.*)$/)
  if (!match) return null

  const fence = match[1]
  const marker = fence[0]
  if (!fence.split('').every((ch) => ch === marker)) return null
  return { marker: marker as '`' | '~', length: fence.length, info: match[2].trim() }
}

function isClosingFence(line: string, marker: '`' | '~', length: number): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith(marker.repeat(length))) return false
  return trimmed.split('').every((ch) => ch === marker)
}

function isMermaidInfo(info: string): boolean {
  return info === 'mermaid' || info === '{mermaid}' || info.startsWith('{mermaid,')
}

export function parseMarkdown(raw: string): ParsedDoc {
  const { frontmatter, body } = extractFrontmatter(raw)

  const mermaidBlocks: string[] = []
  const proseLines: string[] = []
  const lines = body.replace(/\r\n?/g, '\n').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const fence = openingFence(lines[index])
    if (!fence || !isMermaidInfo(fence.info)) {
      proseLines.push(lines[index])
      continue
    }

    const blockLines: string[] = []
    index += 1
    while (index < lines.length && !isClosingFence(lines[index], fence.marker, fence.length)) {
      blockLines.push(lines[index])
      index += 1
    }
    mermaidBlocks.push(blockLines.join('\n'))
  }

  return {
    frontmatter,
    prose: proseLines.join('\n').trim(),
    mermaidBlocks
  }
}

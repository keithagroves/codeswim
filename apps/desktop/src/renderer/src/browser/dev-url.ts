// Dev-server addresses printed by a running script ("Local: http://localhost:5173/"),
// offered in the browser panel and to the whiteboard narrator.

import { stripAnsiToPlainLines } from '../ansi'

const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/gi

/** Local addresses in a script's output, newest first, without duplicates. */
export function detectDevUrls(output: string): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  const lines = stripAnsiToPlainLines(output)
  for (let i = lines.length - 1; i >= 0 && urls.length < 5; i--) {
    for (const match of lines[i].match(LOCAL_URL) ?? []) {
      const url = match.replace(/[.,;:]+$/, '').replace('://0.0.0.0', '://localhost')
      if (seen.has(url)) continue
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

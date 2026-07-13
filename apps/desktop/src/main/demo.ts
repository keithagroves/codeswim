// Demo workspace: the bundled example project (examples/sample-architecture)
// copied into userData so it's writable — the watcher, the agent, and diagram
// sync all want a real directory, not files inside the app bundle.

import { promises as fs } from 'fs'
import { join, resolve } from 'path'

// In a packaged build the example ships as an extraResource next to the asar;
// in dev we read it straight out of the monorepo (appPath is apps/desktop).
export function demoSourceDir(appPath: string, resourcesPath: string, isPackaged: boolean): string {
  return isPackaged
    ? join(resourcesPath, 'demo')
    : resolve(appPath, '..', '..', 'examples', 'sample-architecture')
}

// Copies the demo into targetDir unless it already has content — re-clicking
// "Try the demo" reopens the user's copy (with any agent edits) rather than
// clobbering it.
export async function ensureDemoWorkspace(sourceDir: string, targetDir: string): Promise<string> {
  try {
    const existing = await fs.readdir(targetDir)
    if (existing.length > 0) return targetDir
  } catch {
    // target missing — fall through and create it
  }
  await fs.cp(sourceDir, targetDir, { recursive: true })
  return targetDir
}

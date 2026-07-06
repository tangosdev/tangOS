import { readFileSync, existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import type { TangosDescriptor, AtlasDb } from '../shared/types'

export function atlasDbPath(repoPath: string, descriptor: TangosDescriptor): string {
  const rel = descriptor.data?.dbPath || 'chaos-db.json'
  return isAbsolute(rel) ? rel : join(repoPath, rel)
}

export function readAtlas(repoPath: string, descriptor: TangosDescriptor): AtlasDb | null {
  const p = atlasDbPath(repoPath, descriptor)
  if (!existsSync(p)) return null
  try {
    const db = JSON.parse(readFileSync(p, 'utf8')) as AtlasDb
    if (!db || !Array.isArray(db.functions)) return null
    return db
  } catch {
    return null
  }
}

/**
 * Which functions does a source file own?
 *
 * Console used to assume one file per function, named after it: `src/<symbol>.c`. A decomp that
 * folds its one-function files into real translation units breaks that. A promoted unit is named
 * for its class (`d_a_obj_foo.cpp`), sits in a domain directory, and owns every method of the
 * class, so a basename lookup never finds it and the sweep, the auto-PR attribution and the ready
 * `match` calls all quietly skip it.
 *
 * The answer lives in the repo's own placement tool. The decomp's chaos-db stamps every function
 * row with `srcPath` straight from its `srcpath` resolver, so a unit's members all carry the same
 * path. This module inverts that map. It is deliberately dumb: it knows nothing about any one
 * repo's layout, and a file the atlas has never heard of is `unknown`, which callers treat as the
 * old basename rule.
 */
import { existsSync, statSync } from 'node:fs'
import type { AtlasDb, TangosDescriptor } from '../shared/types'
import { atlasDbPath, readAtlas } from './atlas'

export interface SrcFileMember {
  name: string
  module?: string
  addr?: number
  size?: number
}

export interface SrcFileIndex {
  /** repo-relative path (forward slashes) -> every function the atlas puts in that file */
  byFile: Map<string, SrcFileMember[]>
  /** function name -> the file that owns it */
  byName: Map<string, string>
}

export type SrcFileKind = 'function' | 'unit' | 'unknown'

export interface SrcFileClass {
  kind: SrcFileKind
  members: SrcFileMember[]
}

const norm = (p: string): string => p.replace(/\\/g, '/')

export function buildSrcFileIndex(db: AtlasDb | null | undefined): SrcFileIndex {
  const byFile = new Map<string, SrcFileMember[]>()
  const byName = new Map<string, string>()
  for (const f of db?.functions ?? []) {
    if (!f.srcPath) continue
    const path = norm(f.srcPath)
    // the generator writes a number; an older db may carry a hex string
    const raw = f.addr as unknown
    const addr = typeof raw === 'string' ? parseInt(raw, 16) : (raw as number)
    const member: SrcFileMember = { name: f.name, module: f.module, addr, size: f.size }
    const list = byFile.get(path)
    if (list) list.push(member)
    else byFile.set(path, [member])
    byName.set(f.name, path)
  }
  return { byFile, byName }
}

/** One owner: `function`. Several: `unit` (a folded translation unit). Not in the atlas: `unknown`. */
export function classifySrcFile(idx: SrcFileIndex | null | undefined, file: string): SrcFileClass {
  const members = idx?.byFile.get(norm(file))
  if (!members || !members.length) return { kind: 'unknown', members: [] }
  return { kind: members.length > 1 ? 'unit' : 'function', members }
}

/** Does `file` carry `func`? Atlas first (it knows the real path of a unit or a bucketed file);
 *  a file the atlas does not know falls back to the old rule, basename == function name. */
export function fileOwnsFunction(idx: SrcFileIndex | null | undefined, file: string, func: string): boolean {
  const c = classifySrcFile(idx, file)
  if (c.kind !== 'unknown') return c.members.some((m) => m.name === func)
  const f = norm(file)
  return f.endsWith(`/${func}.c`) || f.endsWith(`/${func}.cpp`)
}

/** The function a stranded file stands for, or null when the file is a multi-function unit (it is
 *  verified as a unit by the repo's own tool, not by a single-function match) or names nothing. */
export function singleFunctionOf(
  idx: SrcFileIndex | null | undefined,
  file: string
): { kind: 'function' | 'unknown'; name: string; member?: SrcFileMember } | { kind: 'unit'; members: SrcFileMember[] } {
  const c = classifySrcFile(idx, file)
  if (c.kind === 'unit') return { kind: 'unit', members: c.members }
  if (c.kind === 'function') return { kind: 'function', name: c.members[0].name, member: c.members[0] }
  const base = norm(file).replace(/^.*\//, '').replace(/\.(c|cpp)$/, '')
  return { kind: 'unknown', name: base }
}

// ---- cached loader ---------------------------------------------------------------------------
// The sweep and the attribution path ask repeatedly; the chaos-db is ~2.7 MB for a full game, so
// parse it once per file change, not once per question.
let cache: { path: string; mtime: number; idx: SrcFileIndex } | null = null

export function loadSrcFileIndex(repoPath: string, descriptor: TangosDescriptor): SrcFileIndex | null {
  try {
    const p = atlasDbPath(repoPath, descriptor)
    if (!existsSync(p)) return null
    const mtime = statSync(p).mtimeMs
    if (cache && cache.path === p && cache.mtime === mtime) return cache.idx
    const db = readAtlas(repoPath, descriptor)
    if (!db) return null
    const idx = buildSrcFileIndex(db)
    cache = { path: p, mtime, idx }
    return idx
  } catch {
    return null
  }
}

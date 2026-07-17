/**
 * Read prior matching attempts / near-miss tips for one Atlas function.
 *
 * Data stays on disk (match_attempts.jsonl, nearmiss/db.jsonl) — Console only
 * summarizes it so the operator can plan a batch. Full C is never returned;
 * optional tipSrcPath lets the UI reveal the file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import type { TangosDescriptor } from '../shared/types'

export interface AttemptNodeSummary {
  attemptId: string
  parentAttemptId: string | null
  status: string
  divergences: number | null
  improvedNearMiss: boolean
  loggedAt: string | null
  model: string | null
  harness: string | null
  reasoning: string | null
  note: string | null
  baseKind: string | null
  usedNearMissDraft: boolean | null
  usedGhidraDraft: boolean | null
  /** Depth in the tree for simple indent display (0 = root). */
  depth: number
}

export interface NearMissTipSummary {
  divergences: number | null
  source: string | null
  srcPath: string | null
  /** True if tip C exists but is not returned (size guard). */
  hasCSource: boolean
}

export interface FunctionHistory {
  functionId: string
  name: string
  /** Ordered for display: roots first, children after parents (depth-first). */
  attempts: AttemptNodeSummary[]
  tip: NearMissTipSummary | null
  attemptsPath: string
  nearMissPath: string
  /** Why empty: missing files vs no rows for this id. */
  note: string | null
}

function attemptsPath(repo: string, desc: TangosDescriptor): string {
  const rel =
    desc.project?.matchConventions?.attemptsPath?.trim() || 'config/match_attempts.jsonl'
  return isAbsolute(rel) ? rel : join(repo, rel)
}

function nearMissPath(repo: string, desc: TangosDescriptor): string {
  const rel = desc.project?.matchConventions?.nearMissDb?.trim() || 'nearmiss/db.jsonl'
  return isAbsolute(rel) ? rel : join(repo, rel)
}

function asId(module: string, addr: number): string {
  return `${module}:0x${addr.toString(16)}`
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  try {
    const out: Record<string, unknown>[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t) as Record<string, unknown>)
      } catch {
        /* skip corrupt */
      }
    }
    return out
  } catch {
    return []
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  return null
}

/** Collect rows for this function (by functionId, or module+addr, or name). */
function filterAttempts(
  rows: Record<string, unknown>[],
  functionId: string,
  module: string,
  addr: number,
  name: string
): Record<string, unknown>[] {
  const addrHex = `0x${addr.toString(16)}`
  const wantIds = new Set([functionId, asId(module, addr), `${module}:${addrHex}`])
  return rows.filter((r) => {
    const fid = str(r.functionId) || str(r.id)
    if (fid && wantIds.has(fid)) return true
    const m = str(r.module)
    const a = num(r.addr)
    if (m && a != null && m === module && a === addr) return true
    // last resort: exact name (weaker; renames break it)
    if (str(r.name) === name && (!m || m === module)) return true
    return false
  })
}

/** Depth-first order with depth, roots sorted by time. */
function orderTree(rows: Record<string, unknown>[]): AttemptNodeSummary[] {
  type Node = AttemptNodeSummary & { children: Node[] }
  const byId = new Map<string, Node>()
  const list: Node[] = []

  for (const r of rows) {
    const attemptId = str(r.attemptId) || str(r.id) || `anon-${list.length}`
    const base = r.base
    const baseKind =
      base && typeof base === 'object' ? str((base as { kind?: unknown }).kind) : str(r.baseKind)
    const node: Node = {
      attemptId,
      parentAttemptId: str(r.parentAttemptId),
      status: str(r.status) || 'unknown',
      divergences: num(r.divergences),
      improvedNearMiss: bool(r.improvedNearMiss) === true,
      loggedAt: str(r.loggedAt) || str(r.ts),
      model: str(r.model) || str((r.matchProvenance as { model?: unknown } | undefined)?.model),
      harness: str(r.harness) || str((r.matchProvenance as { harness?: unknown } | undefined)?.harness),
      reasoning:
        str(r.reasoning) || str((r.matchProvenance as { reasoning?: unknown } | undefined)?.reasoning),
      note: str(r.note),
      baseKind,
      usedNearMissDraft: bool(r.usedNearMissDraft),
      usedGhidraDraft: bool(r.usedGhidraDraft),
      depth: 0,
      children: []
    }
    byId.set(attemptId, node)
    list.push(node)
  }

  const roots: Node[] = []
  for (const n of list) {
    const p = n.parentAttemptId ? byId.get(n.parentAttemptId) : null
    if (p && p !== n) p.children.push(n)
    else roots.push(n)
  }

  const byTime = (a: Node, b: Node): number =>
    (a.loggedAt || '').localeCompare(b.loggedAt || '') || a.attemptId.localeCompare(b.attemptId)

  roots.sort(byTime)
  for (const n of list) n.children.sort(byTime)

  const out: AttemptNodeSummary[] = []
  const walk = (n: Node, depth: number): void => {
    n.depth = depth
    const { children: _c, ...rest } = n
    out.push(rest)
    for (const c of n.children) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return out
}

function findTip(
  rows: Record<string, unknown>[],
  module: string,
  addr: number,
  name: string
): NearMissTipSummary | null {
  let best: Record<string, unknown> | null = null
  let bestDiv = Infinity
  for (const r of rows) {
    const m = str(r.module) || 'arm9'
    const a = num(r.addr)
    const n = str(r.name)
    if (n !== name && !(m === module && a === addr)) continue
    if (m !== module && a !== addr && n !== name) continue
    if (a != null && a !== addr && n !== name) continue
    const d = num(r.divergences)
    const score = d ?? 9999
    if (score < bestDiv) {
      bestDiv = score
      best = r
    }
  }
  if (!best) return null
  return {
    divergences: num(best.divergences),
    source: str(best.source) || str(best.label),
    srcPath: str(best.srcPath),
    hasCSource: typeof best.c_source === 'string' && best.c_source.length > 0
  }
}

export function readFunctionHistory(
  repoPath: string,
  descriptor: TangosDescriptor,
  req: { functionId?: string; module: string; addr: number; name: string }
): FunctionHistory {
  const functionId = req.functionId || asId(req.module, req.addr)
  const aPath = attemptsPath(repoPath, descriptor)
  const nPath = nearMissPath(repoPath, descriptor)

  const attemptRows = filterAttempts(readJsonl(aPath), functionId, req.module, req.addr, req.name)
  const attempts = orderTree(attemptRows)
  const tip = findTip(readJsonl(nPath), req.module, req.addr, req.name)

  let note: string | null = null
  if (!existsSync(aPath) && !existsSync(nPath)) {
    note = 'No attempt log or near-miss DB in this repo yet.'
  } else if (!attempts.length && !tip) {
    note = 'Nothing logged for this function yet — open field for a first try.'
  }

  return {
    functionId,
    name: req.name,
    attempts,
    tip,
    attemptsPath: aPath,
    nearMissPath: nPath,
    note
  }
}

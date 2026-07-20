/**
 * Session-scoped near-miss deltas from the near-miss DB.
 *
 * Sub-agents bank tips straight to nearmiss/db.jsonl through the ingest script, so the console
 * never observes a `div=N` line for them and its per-AI near-miss count read zero while real work
 * was landing. This snapshots the DB when a session starts and reports entries that appeared (or
 * improved) since, which the caller attributes to whichever agent's batch holds that function.
 *
 * Deliberately session-only. The DB rows carry no agent field, no timestamp, and a free-form
 * `source` string whose largest bucket names no model at all, so per-agent history cannot be
 * recovered from the file after the fact. Anything older than the snapshot stays unattributed
 * rather than guessed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import type { TangosDescriptor } from '../shared/types'

export interface BankedTip {
  func: string
  div: number
  size?: number
}

/** func -> best (lowest) divergence recorded in the DB at snapshot time. */
export type NearMissSnapshot = Map<string, number>

interface WatchState {
  path: string
  snapshot: NearMissSnapshot
  /** mtime+size of the file when last read, so an unchanged DB costs one stat() instead of a parse. */
  stamp: string
}

let state: WatchState | null = null

export function nearMissDbPath(repo: string, desc: TangosDescriptor): string {
  const rel = desc.project?.matchConventions?.nearMissDb?.trim() || 'nearmiss/db.jsonl'
  return isAbsolute(rel) ? rel : join(repo, rel)
}

function stampOf(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/** Lowest divergence per function currently in the DB. Malformed rows are skipped, not fatal. */
function readBest(path: string): Map<string, { div: number; size?: number }> {
  const out = new Map<string, { div: number; size?: number }>()
  if (!existsSync(path)) return out
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    const func = typeof row.name === 'string' ? row.name.trim() : ''
    if (!func) continue
    const div = Number(row.divergences)
    if (!Number.isFinite(div) || div < 1 || div >= 999) continue
    const rawSize = Number(row.size)
    const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : undefined
    const prev = out.get(func)
    if (!prev || div < prev.div) out.set(func, { div, size })
  }
  return out
}

/** Begin (or restart) watching. Everything already in the DB becomes the baseline, so only work
 *  done from here on is attributed to an agent. */
export function beginSession(repo: string, desc: TangosDescriptor): void {
  const path = nearMissDbPath(repo, desc)
  const snapshot: NearMissSnapshot = new Map()
  for (const [func, v] of readBest(path)) snapshot.set(func, v.div)
  state = { path, snapshot, stamp: stampOf(path) }
}

export function isWatching(): boolean {
  return state != null
}

export function endSession(): void {
  state = null
}

/** Tips banked or improved since the snapshot. Each is reported once: the snapshot advances as we
 *  go, so a later poll won't re-report the same tip and double-count it. */
export function collectNewTips(): BankedTip[] {
  if (!state) return []
  const stamp = stampOf(state.path)
  if (!stamp || stamp === state.stamp) return [] // untouched since last poll
  state.stamp = stamp
  const tips: BankedTip[] = []
  for (const [func, v] of readBest(state.path)) {
    const prev = state.snapshot.get(func)
    if (prev != null && v.div >= prev) continue // nothing new for this function
    state.snapshot.set(func, v.div)
    tips.push({ func, div: v.div, size: v.size })
  }
  return tips
}

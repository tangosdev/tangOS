// Per-AI operator stats for the Chaos Controller boxes.
//
// The console only sees tool *calls*, so match count + hit rate are derived by parsing
// `match` tool output ("MATCHING VERSIONS" = a real byte match). Token usage is only
// known for console-driven API AIs (their driver reports it); external MCP AIs leave it
// undefined. Stats are lifetime, keyed by AI name, persisted in tangos-settings.json.
import type { AiStats } from '../shared/types'

const SIZE_BUCKETS: Array<[string, (n: number) => boolean]> = [
  ['<=0x40', (n) => n <= 0x40],
  ['0x40-0x200', (n) => n > 0x40 && n <= 0x200],
  ['0x200-0x800', (n) => n > 0x200 && n <= 0x800],
  ['>0x800', (n) => n > 0x800]
]
function bucketFor(size?: number): string | null {
  if (size == null || Number.isNaN(size)) return null
  for (const [label, test] of SIZE_BUCKETS) if (test(size)) return label
  return null
}

interface Persisted {
  totalMatches: number
  matchAttempts: number
  nearMisses?: number
  tokensIn?: number
  tokensOut?: number
  bySize?: Record<string, { attempts: number; matches: number }>
}
interface Current {
  task?: string
  batchId?: string
  progress?: { done: number; total: number }
}

/** True if a `match`/driver run's output reports a REAL byte match. The tool prints
 *  "MATCHING VERSIONS: 1.2/sp2p3" on a hit but "MATCHING VERSIONS: none" on a miss — so a
 *  bare "MATCHING VERSIONS" test counts misses as matches (100%-hit inflation). Require a
 *  real version token after the colon, and never accept "none". */
export function outputIsMatch(output: string): boolean {
  return /MATCHING VERSIONS:\s*(?!none\b)\S/i.test(output)
}

/** Smallest byte-diff a match/driver run reports ("N word(s) differ" or "divergences=N"), or null
 *  if none parses. A non-match with a real, small diff (compiled to the right size, a few words
 *  off) is a NEAR MISS; the sentinel 999 (size differs / way off) is not. */
export function matchDivergence(output: string): number | null {
  let min: number | null = null
  const re = /(\d+)\s+word\(s\)\s+differ|divergences?\s*=\s*(\d+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(output || '')) !== null) {
    const n = Number(m[1] ?? m[2])
    if (!Number.isNaN(n) && (min === null || n < min)) min = n
  }
  return min
}

class AiStatsStore {
  private store = new Map<string, Persisted>()
  private current = new Map<string, Current>()
  onChange?: () => void

  private raw(name: string): Persisted {
    let s = this.store.get(name)
    if (!s) {
      s = { totalMatches: 0, matchAttempts: 0 }
      this.store.set(name, s)
    }
    return s
  }

  recordMatch(name: string | undefined, ok: boolean, size?: number): void {
    if (!name) return
    const s = this.raw(name)
    s.matchAttempts++
    if (ok) s.totalMatches++
    const b = bucketFor(size)
    if (b) {
      s.bySize ??= {}
      const t = (s.bySize[b] ??= { attempts: 0, matches: 0 })
      t.attempts++
      if (ok) t.matches++
    }
    this.onChange?.()
  }

  /** A non-matching but close attempt (compiled + produced a real byte-diff). Separate from
   *  matchAttempts, which recordMatch already bumps for the same run. */
  recordNearMiss(name: string | undefined): void {
    if (!name) return
    const s = this.raw(name)
    s.nearMisses = (s.nearMisses ?? 0) + 1
    this.onChange?.()
  }

  recordTokens(name: string | undefined, tokensIn: number, tokensOut: number): void {
    if (!name) return
    const s = this.raw(name)
    s.tokensIn = (s.tokensIn ?? 0) + (tokensIn || 0)
    s.tokensOut = (s.tokensOut ?? 0) + (tokensOut || 0)
    this.onChange?.()
  }

  setCurrent(name: string | undefined, c: Current): void {
    if (!name) return
    this.current.set(name, c)
    this.onChange?.()
  }
  clearCurrent(name: string | undefined): void {
    if (!name) return
    if (this.current.delete(name)) this.onChange?.()
  }

  /** Full stats for one AI, merging lifetime tallies with the live current-task fields. */
  statsFor(name: string): AiStats {
    const s = this.store.get(name) ?? { totalMatches: 0, matchAttempts: 0 }
    const cur = this.current.get(name)
    const totalTokens = (s.tokensIn ?? 0) + (s.tokensOut ?? 0)
    return {
      totalMatches: s.totalMatches,
      matchAttempts: s.matchAttempts,
      nearMisses: s.nearMisses,
      hitRate: s.matchAttempts ? s.totalMatches / s.matchAttempts : 0,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      tokensPerMatch: s.totalMatches && totalTokens ? Math.round(totalTokens / s.totalMatches) : undefined,
      currentTask: cur?.task,
      progress: cur?.progress,
      bySize: s.bySize
    }
  }

  /** Every name we have lifetime stats for (persisted boxes survive disconnect). */
  names(): string[] {
    return [...this.store.keys()]
  }

  currentBatchId(name: string): string | undefined {
    return this.current.get(name)?.batchId
  }

  /** Fold stats keys through a canonicalizer (e.g. "Opus" -> "Claude"), summing tallies, so
   *  stats logged under old per-model/per-session names consolidate into one family box. */
  remapKeys(canon: (name: string) => string): void {
    const merged = new Map<string, Persisted>()
    for (const [name, s] of this.store) {
      const key = canon(name)
      const t = merged.get(key)
      if (!t) {
        merged.set(key, { ...s, bySize: s.bySize ? { ...s.bySize } : undefined })
        continue
      }
      t.totalMatches += s.totalMatches
      t.matchAttempts += s.matchAttempts
      if (s.nearMisses) t.nearMisses = (t.nearMisses ?? 0) + s.nearMisses
      const ti = (t.tokensIn ?? 0) + (s.tokensIn ?? 0)
      const to = (t.tokensOut ?? 0) + (s.tokensOut ?? 0)
      if (ti) t.tokensIn = ti
      if (to) t.tokensOut = to
      if (s.bySize) {
        t.bySize ??= {}
        for (const [b, v] of Object.entries(s.bySize)) {
          const tv = (t.bySize[b] ??= { attempts: 0, matches: 0 })
          tv.attempts += v.attempts
          tv.matches += v.matches
        }
      }
    }
    this.store = merged
  }

  serialize(): Record<string, Persisted> {
    return Object.fromEntries(this.store)
  }
  hydrate(data?: Record<string, Persisted>): void {
    if (!data) return
    for (const [name, s] of Object.entries(data)) {
      if (s && typeof s.totalMatches === 'number') this.store.set(name, s)
    }
  }
}

export const aiStats = new AiStatsStore()

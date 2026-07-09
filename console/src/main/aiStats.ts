// Per-AI operator stats for the Chaos Controller boxes.
//
// The console only sees tool *calls*, so match count + hit rate are derived by parsing
// `match` tool output ("MATCHING VERSIONS" = a real byte match). Token usage is only
// known for console-driven API AIs (their driver reports it); external MCP AIs leave it
// undefined. Stats are lifetime, keyed by AI name, persisted in tangos-settings.json.
import type { AiStats } from '../shared/types'

// A near miss must be genuinely CLOSE, not just an improvement: it counts only when fewer than this
// fraction of the function's words (size/4 bytes) differ. So div 75 on an 88-word function (~85%)
// is "compiled but wrong," not near, and doesn't count; a low-div attempt does. Tunable - raise for
// more lenient, lower for stricter.
const NEAR_MISS_MAX_RATIO = 0.34

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
 *  "MATCHING VERSIONS: 1.2/sp2p3" on a hit but "MATCHING VERSIONS: none" on a miss - so a
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
  private store = new Map<string, Persisted>() // all-time tallies (persisted)
  private session = new Map<string, Persisted>() // current run only (in-memory, zeroed at launch)
  private current = new Map<string, Current>()
  private bestDiv = new Map<string, number>() // best (lowest) divergence ever seen per function
  onChange?: () => void

  private rawIn(map: Map<string, Persisted>, name: string): Persisted {
    let s = map.get(name)
    if (!s) {
      s = { totalMatches: 0, matchAttempts: 0 }
      map.set(name, s)
    }
    return s
  }
  /** The all-time AND current-run tallies for a name - every record updates both. */
  private scopes(name: string): Persisted[] {
    return [this.rawIn(this.store, name), this.rawIn(this.session, name)]
  }

  recordMatch(name: string | undefined, ok: boolean, size?: number, func?: string): void {
    if (!name) return
    for (const s of this.scopes(name)) {
      s.matchAttempts++
      if (ok) s.totalMatches++
      const b = bucketFor(size)
      if (b) {
        s.bySize ??= {}
        const t = (s.bySize[b] ??= { attempts: 0, matches: 0 })
        t.attempts++
        if (ok) t.matches++
      }
    }
    if (ok && func) this.bestDiv.set(func, 0) // a byte match is divergence 0 - the best possible
    this.onChange?.()
  }

  /** A closer near-miss. Counts ONLY when it IMPROVES the function's best divergence so far -
   *  re-hitting the same div (or worse) is not progress and must not inflate the tally. bestDiv is
   *  global per function (across agents + sessions), so the win credits whoever pushed it lower.
   *  Separate from matchAttempts, which recordMatch already bumps for the same run. */
  recordNearMiss(name: string | undefined, func: string | undefined, div: number | null, size?: number): void {
    if (!name || !func || div == null || div < 1 || div >= 999) return
    const prev = this.bestDiv.get(func) ?? Infinity
    if (div >= prev) return // no improvement over the best already seen - not a win
    this.bestDiv.set(func, div) // new best; track it even if it's still too far to count below
    // Closeness floor: an improvement that's still far off (most of the function differs) compiled to
    // size but isn't "near". Only count when under NEAR_MISS_MAX_RATIO of the words differ. Unknown
    // size -> can't judge the ratio, so allow it through on the improvement gate alone.
    const words = size && size > 0 ? size / 4 : 0
    if (words && div / words >= NEAR_MISS_MAX_RATIO) return
    for (const s of this.scopes(name)) s.nearMisses = (s.nearMisses ?? 0) + 1
    this.onChange?.()
  }

  recordTokens(name: string | undefined, tokensIn: number, tokensOut: number): void {
    if (!name) return
    for (const s of this.scopes(name)) {
      s.tokensIn = (s.tokensIn ?? 0) + (tokensIn || 0)
      s.tokensOut = (s.tokensOut ?? 0) + (tokensOut || 0)
    }
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

  private statsFrom(s: Persisted | undefined, cur: Current | undefined): AiStats {
    s ??= { totalMatches: 0, matchAttempts: 0 }
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
  /** All-time stats for one AI, merged with the live current-task fields. */
  statsFor(name: string): AiStats {
    return this.statsFrom(this.store.get(name), this.current.get(name))
  }
  /** Current-run-only stats (zeroed at launch); the live task/progress fields still ride along. */
  runStatsFor(name: string): AiStats {
    return this.statsFrom(this.session.get(name), this.current.get(name))
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

  /** Wipe every tally (all-time + current run) and the per-function best-div history. */
  clearAll(): void {
    this.store.clear()
    this.session.clear()
    this.bestDiv.clear()
    this.onChange?.()
  }

  /** Seed per-function best-divergence from ground truth (the chaos-db/atlas near-miss data), so the
   *  near-miss gate respects divergences reached before this console ever observed them - e.g. a
   *  function already sitting at div 3 in the pool. Only LOWERS a known best, never raises it, so a
   *  fresher observed improvement is never clobbered by stale atlas data. */
  seedBestDiv(fns: Array<{ name: string; div?: number; matched?: boolean }>): void {
    for (const f of fns) {
      if (!f.name) continue
      const d = f.matched ? 0 : typeof f.div === 'number' && f.div >= 1 && f.div < 999 ? f.div : null
      if (d == null) continue
      const prev = this.bestDiv.get(f.name)
      if (prev == null || d < prev) this.bestDiv.set(f.name, d)
    }
  }

  serializeBestDiv(): Record<string, number> {
    return Object.fromEntries(this.bestDiv)
  }
  hydrateBestDiv(data?: Record<string, number>): void {
    if (!data) return
    for (const [k, v] of Object.entries(data)) if (typeof v === 'number') this.bestDiv.set(k, v)
  }
}

export const aiStats = new AiStatsStore()

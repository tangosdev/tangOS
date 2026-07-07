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
  tokensIn?: number
  tokensOut?: number
  bySize?: Record<string, { attempts: number; matches: number }>
}
interface Current {
  task?: string
  batchId?: string
  progress?: { done: number; total: number }
}

/** True if a `match`/driver run's output reports a real byte match. */
export function outputIsMatch(output: string): boolean {
  return /MATCHING VERSIONS/i.test(output)
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

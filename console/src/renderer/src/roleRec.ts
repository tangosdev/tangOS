import type { AiAgent } from '../../shared/types'

export interface RoleRec {
  role: string | null // null = not enough evidence to recommend a role yet
  why: string
}

/** Recommend a role for an AI ONLY from its measured strengths — no guessing a model's
 *  strengths before it has a track record here. Returns role=null until there's data. */
export function recommendRole(a: AiAgent): RoleRec {
  const s = a.stats
  const by = s.bySize
  const rate = (t?: { attempts: number; matches: number }): number | null =>
    t && t.attempts >= 2 ? t.matches / t.attempts : null

  // Need a real sample before claiming anything.
  if (by && s.matchAttempts >= 4) {
    const rBig = rate(by['>0x800'])
    const rSmall = rate(by['<=0x40'])
    if (rBig != null && rBig >= 0.4) return { role: 'Long sweep', why: 'lands large functions others skip' }
    if (rSmall != null && rSmall >= 0.6) return { role: 'Main matcher', why: 'high hit rate on everyday functions' }
    if (s.hitRate < 0.25) return { role: 'Explorer', why: 'surfaces targets but rarely lands directly' }
    if (s.hitRate >= 0.5) return { role: 'Main matcher', why: 'steady, reliable throughput' }
  }
  return { role: null, why: 'still learning — assign it work to find its strengths' }
}

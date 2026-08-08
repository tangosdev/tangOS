// The adaptive hidden role (Simple mode), pure half. The pool is not stationary: easy
// functions get matched first, so the repo's average difficulty rises as it drains, and a
// model whose track record was earned on the easy era keeps being handed work it can no
// longer land. Given an agent's RECENT form (not lifetime), the remaining pool's hidden
// 1-to-5 difficulty score, and the near-miss supply, these decide which rung of ROLE_LADDER
// the agent's next batch generates under.
//
// Demotion is one-way by design (operator decision 2026-08-08): a demoted agent gets
// productive again because the easier rungs' pools REFILL (drafters bank fresh near-misses),
// not by climbing back up. index.ts owns the stateful half (persisted rungs, the pool cache,
// wiring into the loop paths); operator-assigned roles never reach any of this.

import type { AtlasDb } from '../shared/types'
import { ROLE_LADDER } from '../shared/types'

// Ring length for aiStats' recent-outcome window (~one batch), and the least evidence a
// demotion will act on - half a window, so one unlucky pull can't demote anyone.
export const RECENT_WINDOW = 16
export const MIN_EVIDENCE = 8
// The form floor on an all-easy pool: under ~1 match in 8 recent tries, the rung is too hard.
const BASE_DEMOTE_RATE = 0.125

export interface PoolState {
  /** The hidden difficulty score, 1..5: how hard what REMAINS unmatched is. */
  score: number
  /** Unmatched functions carrying a refinable near-miss - the Refiner rung's supply. */
  refinerSupply: number
}

/** Judge the pool from what remains unmatched: early on most pending functions are small
 *  (score 1); as the easy era gets matched out the small share shrinks and the score climbs
 *  to 5. A near-missed function counts as easy whatever its size - a compiling draft plus a
 *  verifier diff is easy work. `liveMatched` folds in main's finished set so a clone that's
 *  behind can't read as "plenty of easy left". */
export function poolDifficulty(fns: AtlasDb['functions'], liveMatched?: Set<string> | null): PoolState {
  let pending = 0
  let easy = 0
  let refinerSupply = 0
  for (const f of fns) {
    if (f.matched || f.noMatch || liveMatched?.has(f.name)) continue
    pending++
    const nearMiss = typeof f.div === 'number' && f.div >= 1 && f.div < 999
    if (nearMiss) refinerSupply++
    if (nearMiss || f.size <= 0x200) easy++
  }
  if (!pending) return { score: 5, refinerSupply: 0 }
  return { score: Math.min(5, Math.max(1, Math.round(5 - 4 * (easy / pending)))), refinerSupply }
}

/** One rung down, or null to stay: thin evidence, form clears the floor, already at the
 *  bottom, or the next rung has no supply (an empty Refiner pile - see effectiveRole for how
 *  a Refiner already ON the bottom rides that out). The floor relaxes as the pool score
 *  rises: on a 5/5 pool every agent's rate collapses, and demoting them all would just
 *  reshuffle the fleet across equally hard work. */
export function demotionFor(
  current: string,
  recent: { attempts: number; matches: number },
  pool: PoolState
): string | null {
  const ladder = ROLE_LADDER as readonly string[]
  const rung = ladder.indexOf(current)
  if (rung < 0 || rung >= ladder.length - 1) return null // unknown role, or already easiest
  if (recent.attempts < MIN_EVIDENCE) return null
  const floor = BASE_DEMOTE_RATE * (1 - (pool.score - 1) / 8) // 12.5% on a 1/5 pool -> 6.25% on 5/5
  if (recent.matches / recent.attempts >= floor) return null
  const next = ladder[rung + 1]
  if (next === 'Refiner' && pool.refinerSupply === 0) return null
  return next
}

/** What a rung's batch actually generates as. Only the bottom rung can run dry in a way the
 *  scheduler errors on (the refine pile is a finite pile; every other rung draws from the
 *  unmatched pool at large), so a supply-less Refiner takes Drafter batches - which top up
 *  with random when similarity drains too. The rung itself does not move: the moment tips
 *  get banked again, Refiner batches resume. That fallback state IS the endpoint of the
 *  ladder - the pool has no easy work left to hand anyone. */
export function effectiveRole(rung: string, pool: PoolState): string {
  return rung === 'Refiner' && pool.refinerSupply === 0 ? 'Drafter' : rung
}

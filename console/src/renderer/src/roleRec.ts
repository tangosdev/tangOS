import type { AiAgent } from '../../shared/types'
import { ROLE_FIT, ROLE_LADDER } from '../../shared/types'
import { familyOf } from './efforts'

export interface RoleRec {
  role: string | null // null = not enough evidence to recommend a role yet
  why: string
}

/** Recommend a role for an AI ONLY from its measured strengths - no guessing a model's
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
    if (rBig != null && rBig >= 0.4) return { role: 'Hard matcher', why: 'lands large functions others skip' }
    if (rSmall != null && rSmall >= 0.6) return { role: 'Refiner', why: 'high hit rate - good at closing functions out' }
    if (s.hitRate < 0.25) return { role: 'Drafter', why: 'gets functions close; let the Refiner finish them' }
    if (s.hitRate >= 0.5) return { role: 'Refiner', why: 'steady, reliable at landing matches' }
  }
  return { role: null, why: 'still learning - assign it work to find its strengths' }
}

export interface AutoRole {
  role: string
  why: string
  /** assigned = the operator picked it; measured = from this agent's own record here;
   *  model = a guess from the model behind the box; fallback = no idea, take the whole pool. */
  source: 'assigned' | 'measured' | 'model' | 'fallback'
}

/** The role Simple mode runs an agent under, without asking. In order:
 *
 *  1. a role the operator assigned by hand in Advanced - never overridden,
 *  2. this agent's measured strengths here (recommendRole), once it has a record,
 *  3. the model behind the box, via ROLE_FIT. Note this is a GUESS about a model before it has
 *     proved anything here, which recommendRole deliberately refuses to make. Simple mode needs
 *     some answer to put behind one button, and a reasonable prior beats parking every fresh
 *     agent on the same role - but it is a prior, and (2) replaces it the moment there's data,
 *  4. Random - a uniform draw from the whole unmatched pool. No similarity or size bias, and it
 *     still ships the full drafts/near-miss scaffolding, so an unrecognised model gets real work
 *     rather than nothing.
 */
export function autoRole(a: AiAgent): AutoRole {
  if (a.roles.length > 0) return { role: a.roles[0], why: 'you assigned this role', source: 'assigned' }

  /** Demote-only cap: never pick a rung HARDER than the adaptive hidden role main has walked
   *  this agent down to. Lifetime stats and model priors were earned on the easy era of the
   *  pool; the rung reflects what it can land NOW. Easier picks pass through untouched, and
   *  main re-applies the same cap at Go anyway - this keeps the idle line/tooltip honest. */
  const cap = (pick: AutoRole): AutoRole => {
    const ladder = ROLE_LADDER as readonly string[]
    const rung = a.hiddenRole ? ladder.indexOf(a.hiddenRole) : -1
    const cur = ladder.indexOf(pick.role)
    if (rung < 0 || cur < 0 || cur >= rung) return pick
    return { role: a.hiddenRole!, why: 'the pool outgrew its old role - running easier work now', source: pick.source }
  }

  const measured = recommendRole(a)
  if (measured.role) return cap({ role: measured.role, why: measured.why, source: 'measured' })

  const name = (a.name || '').toLowerCase()
  for (const [role, fit] of Object.entries(ROLE_FIT)) {
    if (fit.names?.test(name)) return cap({ role, why: `${a.name} is a ${fit.strength.split(',')[0]} model`, source: 'model' })
  }
  const family = familyOf(a)
  for (const [role, fit] of Object.entries(ROLE_FIT)) {
    if (fit.families?.includes(family)) return cap({ role, why: `${family} models fit this role`, source: 'model' })
  }
  return cap({ role: 'Random', why: 'unrecognised model - drawing from the whole unmatched pool', source: 'fallback' })
}

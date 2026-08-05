/**
 * Match-convention helpers for MCP / next_batch.
 *
 * Mirrors the experimental Chaos Viewer fork: attempt-tree logging, near-miss
 * tip store, Ghidra scaffold policy, and SHARED DEFAULTS for provenance — so a
 * batch does not re-paste model/harness/sessionScope on every target.
 *
 * Draft sources are NEVER inlined into next_batch (no pasted disasm / tip C /
 * Ghidra C). Agents call tools (worklist, nearmiss_*, disasm) or open files when
 * operator toggles allow it.
 *
 * Style: free-text blocks like knownWalls / submitting; opt-in via tangos.json
 * + Console MatchingPrefs switches.
 */
import type {
  MatchingPrefs,
  TangosDescriptor,
  TangosMatchConventions,
  TangosProject
} from '../shared/types'

export function conventionsOf(project?: TangosProject | null): TangosMatchConventions | null {
  const c = project?.matchConventions
  if (!c || typeof c !== 'object') return null
  return c
}

export function attemptTreeEnabled(project?: TangosProject | null): boolean {
  return !!conventionsOf(project)?.attemptTree
}

/** Defaults when the operator has not set app prefs yet. */
export function defaultMatchingPrefs(project?: TangosProject | null): MatchingPrefs {
  const c = conventionsOf(project)
  return {
    allowNearMiss: true,
    // Ghidra off unless the descriptor opts in — matches conservative EP/viewer defaults.
    allowGhidra: !!c?.ghidraDrafts
  }
}

function paths(c: TangosMatchConventions | null): {
  attempts: string
  provenance: string
  nearMiss: string
} {
  return {
    attempts: c?.attemptsPath?.trim() || 'config/match_attempts.jsonl',
    provenance: c?.provenancePath?.trim() || 'config/match_provenance.jsonl',
    nearMiss: c?.nearMissDb?.trim() || 'nearmiss/db.jsonl'
  }
}

export type MatchGuideOpts = {
  batchSize?: number
  /** Operator toggles; when omitted, allow near-miss on / ghidra from descriptor. */
  prefs?: MatchingPrefs | null
}

/**
 * One-shot guide appended to next_batch (and optionally MCP instructions).
 * Always emits DRAFT SOURCE POLICY when prefs are provided; full attempt-tree
 * block only when attemptTree is on.
 */
export function matchConventionsGuide(desc: TangosDescriptor, opts: MatchGuideOpts | number = 1): string {
  const prefsIn = typeof opts === 'number' ? null : opts.prefs
  const prefs = prefsIn ?? defaultMatchingPrefs(desc.project)
  const c = conventionsOf(desc.project)
  const { nearMiss } = paths(c)

  const allowNear = prefs.allowNearMiss !== false
  const hasNearMissTool = !!desc.tools?.some(
    (t) => t.id === 'nearmiss_list' || t.id === 'nearmiss_stats' || /nearmiss_db/.test(t.command || '')
  )

  const policy: string[] = [
    '',
    '======================================================================',
    'DRAFT SOURCES (operator toggle — this batch)',
    '======================================================================',
    'Do NOT expect disasm / near-miss C to be pasted into this message.',
    'Pull context with tools (worklist, disasm, nearmiss_*) or local files when allowed.',
    '',
    allowNear
      ? `Near-miss tips: ON — you MAY use ${nearMiss}` +
        (hasNearMissTool ? ' and nearmiss_* tools' : '') +
        '. Keep compiling tip C; never bank non-reproducing C as a green src/ match.'
      : 'Near-miss tips: OFF — do NOT open nearmiss/db.jsonl, nearmiss_* tools, or // NONMATCHING tip C for these targets. Work them from scratch.',
    'A raw byte transcription (`asm{}`/`dcd 0x...` dump of the disassembly) is never a match — the console rejects it at verify, bank, and push; write real C or bank the near-miss instead.'
  ]

  if (allowNear && desc.project.nearMissNote) {
    policy.push(`Near-miss note: ${desc.project.nearMissNote}`)
  }

  if (!c?.attemptTree) return policy.join('\n')

  // Attempt-tree logging is CONSOLE-driven: the console writes a durable log row for every match run
  // it observes, stamping the connected agent's identity + effort + the verified outcome. So the
  // agent does NOT emit MATCH_RESULT nodes or call log_attempt/stamp_provenance - it just matches.
  return [
    ...policy,
    '',
    'Attempt logging: AUTOMATIC. The console records every try (including no_progress) with your model,',
    'effort, and the verified outcome. Do NOT emit MATCH_RESULT nodes or call log_attempt /',
    'stamp_provenance yourself. Just match: a target only counts after a verify MATCH; near-misses go',
    'to the near-miss DB, never a fake-green src/ file.'
  ].join('\n')
}

/** Short blurb for the copyable agent connect prompt (agentPrompt). */
export function matchConventionsConnectBlurb(project?: TangosProject | null): string | null {
  const c = conventionsOf(project)
  if (!c?.attemptTree) return null
  return (
    '  8. This repo logs matching attempts automatically - the console records every try (with your ' +
    'model + effort + verified outcome) as you work. You do NOT emit MATCH_RESULT nodes or call ' +
    'log_attempt/stamp_provenance. Just match: a target only counts after a verify MATCH; near-misses ' +
    'go to the near-miss DB, never a fake-green src/ file.'
  )
}

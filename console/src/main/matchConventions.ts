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
  // Back-compat: older call sites passed batchSize as the 2nd arg.
  const batchSize = typeof opts === 'number' ? opts : (opts.batchSize ?? 1)
  const prefsIn = typeof opts === 'number' ? null : opts.prefs
  const prefs = prefsIn ?? defaultMatchingPrefs(desc.project)
  const c = conventionsOf(desc.project)
  const { attempts, provenance, nearMiss } = paths(c)

  const allowNear = prefs.allowNearMiss !== false
  const allowGhidra = !!prefs.allowGhidra

  const hasNearMissTool = !!desc.tools?.some(
    (t) => t.id === 'nearmiss_list' || t.id === 'nearmiss_stats' || /nearmiss_db/.test(t.command || '')
  )
  const hasLogTool = !!desc.tools?.some((t) => t.id === 'log_attempt' || /log_attempt/.test(t.command || ''))
  const hasBankTool = !!desc.tools?.some(
    (t) => t.id === 'bank' || t.id === 'agent_bank' || /\bbank\.py\b/.test(t.command || '')
  )

  const policy: string[] = [
    '',
    '======================================================================',
    'DRAFT SOURCES (operator toggles — this batch)',
    '======================================================================',
    'Do NOT expect disasm / near-miss C / Ghidra C to be pasted into this message.',
    'Pull context with tools (worklist, disasm, nearmiss_*) or local files when allowed.',
    '',
    allowNear
      ? `Near-miss tips: ON — you MAY use ${nearMiss}` +
        (hasNearMissTool ? ' and nearmiss_* tools' : '') +
        '. Keep compiling tip C; never bank non-reproducing C as a green src/ match. Set usedNearMissDraft when you used a tip.'
      : 'Near-miss tips: OFF — do NOT open nearmiss/db.jsonl, nearmiss_* tools, or // NONMATCHING tip C for these targets. usedNearMissDraft=false.',
    allowGhidra
      ? 'Ghidra: ON — local ghidra_out/0x….c is structure/types only. REWRITE until verify MATCH; never bank decompiler C as-is. Set usedGhidraDraft when used.'
      : 'Ghidra: OFF — do NOT open ghidra_out/ or GHIDRA SCAFFOLD files. usedGhidraDraft=false.'
  ]

  if (allowNear && desc.project.nearMissNote) {
    policy.push(`Near-miss note: ${desc.project.nearMissNote}`)
  }

  if (!c?.attemptTree) {
    return policy.join('\n')
  }

  const model = c.defaultProvenance?.model?.trim() || 'grok-4.5'
  const reasoning = c.defaultProvenance?.reasoning?.trim() || 'high'
  const harness = c.defaultProvenance?.harness?.trim() || 'grok-build'
  const sessionScope = batchSize <= 1 ? 'focused' : 'batch'

  const lines: string[] = [
    ...policy,
    '',
    '======================================================================',
    'MATCH LOGGING (attempt tree) — once for this batch',
    '======================================================================',
    'WHO (credit) → MATCH_RESULT.author (GitHub login). Never put names in matchProvenance.',
    'HOW (method) → matchProvenance only (model / reasoning / harness slugs, or kind=human).',
    'EVERY TRY   → one MATCH_RESULT node in an attempt tree (including no_progress / failed).',
    '',
    'Tree shape (functionId is the stable key — never name alone):',
    '  module:0xaddr',
    '  ├─ near_miss div=40   parent=null',
    '  │  └─ near_miss div=12 parent=…  improved',
    '  │     └─ matched      parent=…',
    '',
    'Identity every node: schemaVersion=1, functionId, unique attemptId (ULID/UUID),',
    'parentAttemptId (null = root), loggedAt (UTC ISO-8601), base.kind.',
    'Draft trackers (independent, both may be true): usedNearMissDraft, usedGhidraDraft',
    '(inherit true from parent when that source was used earlier on the lineage).',
    '',
    'SHARED DEFAULTS for this batch (copy into every MATCH_RESULT unless a try differs):',
    '```yaml',
    `sessionScope: ${sessionScope}`,
    `batchSize: ${batchSize}`,
    'matchProvenance:',
    '  kind: ai',
    `  model: "${model}"`,
    `  reasoning: "${reasoning}"`,
    `  harness: "${harness}"`,
    '```',
    'Slugs only (good: grok-4.5 / grok-build; bad: "Grok 4.5" / "Grok Build").',
    '',
    'Per target, emit a slim node (fill status / attemptId / parent / base / draft flags);',
    'paste SHARED DEFAULTS for sessionScope, batchSize, author, matchProvenance.',
    '',
    `Stores: attempts → ${attempts}; final how on bank → ${provenance}.`,
    hasLogTool
      ? 'Log tries with the log_attempt tool (or tools/log_attempt.py). Prefer --src on near_miss so tip C lands in the near-miss DB (when Near-miss tips are ON).'
      : `Log tries by appending nodes operators ingest into ${attempts} (tools/log_attempt.py when present).`,
    hasBankTool
      ? 'On MATCH: bank via the bank tool (provenance required for AI: model + reasoning + harness). Bank is NOT a new try.'
      : 'On MATCH: promote verified C to src/ and stamp provenance when the repo provides a bank path.'
  ]
  return lines.join('\n')
}

/** Short blurb for the copyable agent connect prompt (agentPrompt). */
export function matchConventionsConnectBlurb(project?: TangosProject | null): string | null {
  const c = conventionsOf(project)
  if (!c?.attemptTree) return null
  const g = c.ghidraDrafts ? ' Ghidra scaffolds (ghidra_out/) are allowed as draft hints only.' : ''
  return (
    '  8. This repo uses attempt-tree logging: every try (including failures) is a MATCH_RESULT node ' +
    '(functionId + attemptId + parentAttemptId + matchProvenance). next_batch will include SHARED DEFAULTS ' +
    'and the log paths once — do not invent a second logging scheme.' +
    g
  )
}

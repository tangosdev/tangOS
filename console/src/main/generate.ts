import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { descriptorPathFor } from './descriptor'
import type { TangosDescriptor, TangosTool, GenerateReport } from '../shared/types'

function exists(repo: string, rel: string): boolean {
  return existsSync(join(repo, rel))
}

function listPy(repo: string, rel: string): string[] {
  const dir = join(repo, rel)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.py'))
  } catch {
    return []
  }
}

function gitRemote(repo: string): string | undefined {
  const cfg = join(repo, '.git', 'config')
  if (!existsSync(cfg)) return undefined
  try {
    const txt = readFileSync(cfg, 'utf8')
    const m = txt.match(/url\s*=\s*(\S+)/)
    if (!m) return undefined
    let url = m[1].trim()
    // git@github.com:owner/repo.git -> https://github.com/owner/repo
    const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
    if (ssh) url = `https://${ssh[1]}/${ssh[2]}`
    url = url.replace(/\.git$/, '')
    return url
  } catch {
    return undefined
  }
}

function detectLanguage(repo: string): string | undefined {
  // Shallow scan of a src/ dir if present.
  for (const d of ['src', 'source', '.']) {
    const dir = join(repo, d)
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir)
      if (files.some((f) => f.endsWith('.cpp') || f.endsWith('.cp') || f.endsWith('.cc'))) return 'C++'
      if (files.some((f) => f.endsWith('.c'))) return 'C'
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/** Introspect a repo and produce a draft descriptor + human-readable detection notes. Does not write. */
export function detectRepo(repoPath: string): GenerateReport {
  const notes: string[] = []
  const name = basename(repoPath)
  const github = gitRemote(repoPath)
  if (github) notes.push(`git remote: ${github}`)
  const language = detectLanguage(repoPath)
  if (language) notes.push(`language looks like ${language}`)

  const frameworks: string[] = []
  if (exists(repoPath, 'objdiff.json')) frameworks.push('objdiff')
  if (exists(repoPath, 'splat.yaml') || exists(repoPath, 'config/splat.yaml')) frameworks.push('splat')
  if (exists(repoPath, 'configure.py') || exists(repoPath, 'config.yml')) frameworks.push('dtk/decomp-toolkit')
  if (exists(repoPath, 'Makefile') || exists(repoPath, 'makefile')) frameworks.push('make')
  if (exists(repoPath, 'vendor/m2c') || exists(repoPath, 'tools/m2c')) frameworks.push('m2c')
  if (exists(repoPath, 'vendor/decomp-permuter') || exists(repoPath, 'tools/decomp-permuter')) frameworks.push('decomp-permuter')
  if (frameworks.length) notes.push(`frameworks detected: ${frameworks.join(', ')}`)

  const pyTools = listPy(repoPath, 'tools')
  if (pyTools.length) notes.push(`${pyTools.length} python script(s) in tools/`)

  const tools: TangosTool[] = []

  // Canonical build/diff/progress entry points, by well-known filename.
  // DS matching spine (match/fdiff/nearmiss/…) is detected when present so EP and
  // sm64ds-style repos get a usable tools[] without hand-writing everything.
  const KNOWN: Record<string, Omit<TangosTool, 'command'> & { rel: string }> = {
    'progress.py': { rel: 'tools/progress.py', id: 'progress', label: 'Progress report', category: 'reporting', readOnly: true, description: 'Report decomp progress.' },
    'diff.py': { rel: 'diff.py', id: 'diff', label: 'Diff a function', category: 'analysis', readOnly: true, description: 'Diff a function against the target.' },
    'first_diff.py': { rel: 'first_diff.py', id: 'first_diff', label: 'First diff', category: 'analysis', readOnly: true, description: 'Find the first differing function.' },
    'calcrom.py': { rel: 'calcrom.py', id: 'calcrom', label: 'Calc ROM progress', category: 'reporting', readOnly: true, description: 'Compute matched/total from the build.' },
    'configure.py': { rel: 'configure.py', id: 'configure', label: 'Configure build', category: 'setup', readOnly: false, description: 'Regenerate the build config (ninja/make).' },
    'match.py': {
      rel: 'tools/match.py', id: 'match', label: 'Match function', category: 'analysis', readOnly: true,
      description: 'Compile candidate C with mwccarm and compare to the ROM (relocation-aware).',
      args: [
        { name: 'c', type: 'string', flag: '--c', required: true, description: 'Candidate C/C++ path.' },
        { name: 'func', type: 'string', flag: '--func', required: true, description: 'Function symbol name.' },
        { name: 'addr', type: 'string', flag: '--addr', required: true, description: 'Address (0x…).' },
        { name: 'size', type: 'string', flag: '--size', required: true, description: 'Size (0x…).' },
        { name: 'version', type: 'string', flag: '--version', description: 'mwccarm version (e.g. 1.2/sp2p3).' },
        { name: 'module', type: 'string', flag: '--module', description: 'Module label (arm9, ov002, …).' },
        { name: 'brief', type: 'boolean', flag: '--brief', description: 'Terse pass/fail output.' }
      ]
    },
    'fdiff.py': {
      rel: 'tools/fdiff.py', id: 'fdiff', label: 'Function diff', category: 'analysis', readOnly: true,
      description: 'Per-instruction byte diff (reloc-aware) for one hard function.',
      args: [
        { name: 'c', type: 'string', flag: '--c', required: true },
        { name: 'name', type: 'string', flag: '--name', required: true },
        { name: 'addr', type: 'string', flag: '--addr' },
        { name: 'size', type: 'string', flag: '--size' },
        { name: 'module', type: 'string', flag: '--module' },
        { name: 'quiet', type: 'boolean', flag: '--quiet' }
      ]
    },
    'disasm.py': { rel: 'tools/disasm.py', id: 'disasm', label: 'Disassemble', category: 'analysis', readOnly: true, description: 'Disassemble a ROM range.' },
    'worklist.py': { rel: 'tools/worklist.py', id: 'worklist', label: 'Worklist', category: 'analysis', readOnly: true, description: 'Emit unmatched functions with resolved context.' },
    'linkcheck.py': { rel: 'tools/linkcheck.py', id: 'linkcheck', label: 'Linkcheck', category: 'analysis', readOnly: true, description: 'Linked-byte verification (wrong-callee trap).' },
    'nearmiss_db.py': {
      rel: 'tools/nearmiss_db.py', id: 'nearmiss_list', label: 'Near-miss list', category: 'reporting', readOnly: true,
      description: 'List best near-miss tips (nearmiss/db.jsonl).',
      // command overrides below
    },
    'log_attempt.py': {
      rel: 'tools/log_attempt.py', id: 'log_attempt', label: 'Log attempt', category: 'logging', readOnly: false,
      description: 'Append one matching attempt (attempt tree node) to config/match_attempts.jsonl.'
    },
    'bank.py': {
      rel: 'tools/bank.py', id: 'bank', label: 'Bank match', category: 'logging', readOnly: false,
      description: 'Bank a verified match (provenance required for AI).'
    },
    'chaos_db_ci.py': {
      rel: 'tools/chaos_db_ci.py', id: 'chaos_db', label: 'Chaos DB', category: 'reporting', readOnly: true,
      description: 'Generate chaos-db.json from committed data (no ROM).'
    },
    'unpack.py': {
      rel: 'tools/unpack.py', id: 'unpack', label: 'Unpack ROM', category: 'setup', readOnly: false,
      description: 'Unpack a legally owned .nds dump (local only).'
    }
  }
  for (const [fname, def] of Object.entries(KNOWN)) {
    if (exists(repoPath, def.rel)) {
      const { rel, ...rest } = def
      // Special command shapes that are not bare script {flags}.
      let command = `{python} ${rel} {flags}`
      if (fname === 'nearmiss_db.py') command = `{python} ${rel} list {flags}`
      tools.push({ ...rest, command })
      notes.push(`+ tool ${def.id} (${rel})`)
    }
  }
  // Also expose nearmiss stats when the DB tool exists (second MCP surface).
  if (exists(repoPath, 'tools/nearmiss_db.py')) {
    tools.push({
      id: 'nearmiss_stats',
      label: 'Near-miss stats',
      category: 'reporting',
      readOnly: true,
      command: '{python} tools/nearmiss_db.py stats',
      description: 'Summarize the near-miss tip store.'
    })
    notes.push('+ tool nearmiss_stats')
  }
  // Make target as a build tool.
  if (frameworks.includes('make')) {
    tools.push({
      id: 'build', label: 'Build', category: 'setup', readOnly: false,
      command: 'make {flags}', description: 'Build the project (runs make).',
      args: [{ name: 'target', type: 'string', positional: true, description: 'Optional make target.' }]
    })
    notes.push('+ tool build (make)')
  }

  if (tools.length === 0) {
    notes.push('no canonical entry points auto-detected - refine this descriptor by hand or with AI.')
  }

  // Experimental matching conventions (Chaos Viewer fork / EP): attempt tree + stores.
  const hasAttempts = exists(repoPath, 'config/match_attempts.jsonl') || exists(repoPath, 'tools/log_attempt.py')
  const hasNearMiss = exists(repoPath, 'nearmiss/db.jsonl') || exists(repoPath, 'tools/nearmiss_db.py')
  const hasGhidra = exists(repoPath, 'tools/ghidra') || exists(repoPath, 'tools/ghidra_targets.py')
  const matchConventions =
    hasAttempts || hasNearMiss || hasGhidra
      ? {
          attemptTree: hasAttempts,
          ...(hasAttempts
            ? { attemptsPath: 'config/match_attempts.jsonl', provenancePath: 'config/match_provenance.jsonl' }
            : {}),
          ...(hasNearMiss ? { nearMissDb: 'nearmiss/db.jsonl' } : {}),
          ghidraDrafts: hasGhidra,
          defaultProvenance: { model: 'grok-4.5', reasoning: 'high', harness: 'grok-build' }
        }
      : undefined
  if (matchConventions) {
    notes.push(
      `match conventions: attemptTree=${!!matchConventions.attemptTree} nearMiss=${!!hasNearMiss} ghidra=${hasGhidra}`
    )
  }

  const descriptor: TangosDescriptor = {
    tangosVersion: '1',
    project: {
      name,
      title: name,
      ...(github ? { github } : {}),
      ...(language ? { language } : {}),
      ...(matchConventions ? { matchConventions } : {})
    },
    runtime: { cwd: '.', python: 'python', shell: false },
    ...(frameworks.length ? { requirements: { notes: `frameworks: ${frameworks.join(', ')}` } } : {}),
    categories: [
      { id: 'reporting', label: 'Progress & Reporting', order: 1 },
      { id: 'analysis', label: 'Analysis & Debugging', order: 2 },
      { id: 'setup', label: 'Setup & Build', order: 3 },
      { id: 'logging', label: 'Match logging', order: 4 }
    ],
    tools
  }

  return { descriptor, detected: notes, wrotePath: null }
}

export function writeDescriptor(repoPath: string, descriptor: TangosDescriptor): string {
  const p = descriptorPathFor(repoPath)
  writeFileSync(p, JSON.stringify(descriptor, null, 2) + '\n', 'utf8')
  return p
}

/** Convenience: detect + write in one step. */
export function generateDescriptor(repoPath: string): GenerateReport {
  const report = detectRepo(repoPath)
  const p = writeDescriptor(repoPath, report.descriptor)
  return { ...report, wrotePath: p }
}

/** Guard used before treating a path as a repo. */
export function looksLikeRepo(repoPath: string): boolean {
  try {
    return statSync(repoPath).isDirectory()
  } catch {
    return false
  }
}

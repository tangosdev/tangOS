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
  const KNOWN: Record<string, Omit<TangosTool, 'command'> & { rel: string }> = {
    'progress.py': { rel: 'tools/progress.py', id: 'progress', label: 'Progress report', category: 'reporting', readOnly: true, description: 'Report decomp progress.' },
    'diff.py': { rel: 'diff.py', id: 'diff', label: 'Diff a function', category: 'analysis', readOnly: true, description: 'Diff a function against the target.' },
    'first_diff.py': { rel: 'first_diff.py', id: 'first_diff', label: 'First diff', category: 'analysis', readOnly: true, description: 'Find the first differing function.' },
    'calcrom.py': { rel: 'calcrom.py', id: 'calcrom', label: 'Calc ROM progress', category: 'reporting', readOnly: true, description: 'Compute matched/total from the build.' },
    'configure.py': { rel: 'configure.py', id: 'configure', label: 'Configure build', category: 'setup', readOnly: false, description: 'Regenerate the build config (ninja/make).' }
  }
  for (const [fname, def] of Object.entries(KNOWN)) {
    if (exists(repoPath, def.rel)) {
      const { rel, ...rest } = def
      tools.push({ ...rest, command: `{python} ${rel} {flags}` })
      notes.push(`+ tool ${def.id} (${rel})`)
    }
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
    notes.push('no canonical entry points auto-detected — refine this descriptor by hand or with AI.')
  }

  const descriptor: TangosDescriptor = {
    tangosVersion: '1',
    project: {
      name,
      title: name,
      ...(github ? { github } : {}),
      ...(language ? { language } : {})
    },
    runtime: { cwd: '.', python: 'python', shell: false },
    ...(frameworks.length ? { requirements: { notes: `frameworks: ${frameworks.join(', ')}` } } : {}),
    categories: [
      { id: 'reporting', label: 'Progress & Reporting', order: 1 },
      { id: 'analysis', label: 'Analysis & Debugging', order: 2 },
      { id: 'setup', label: 'Setup & Build', order: 3 }
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

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TangosDescriptor, PreflightItem, PreflightFixResult } from '../shared/types'

// pip package name -> python import name, for the ones that differ.
const IMPORT_NAME: Record<string, string> = {
  pyelftools: 'elftools',
  'py-elftools': 'elftools',
  'pillow': 'PIL',
  'pyyaml': 'yaml'
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    try {
      const c = spawn(cmd, args, { cwd, env: process.env })
      c.stdout?.on('data', (d) => (out += d))
      c.stderr?.on('data', (d) => (out += d))
      c.on('error', () => resolve({ code: -1, out }))
      c.on('close', (code) => resolve({ code: code ?? -1, out }))
    } catch {
      resolve({ code: -1, out })
    }
  })
}

/** The compiler build a project pins as its default: `project.compilerPin` when the descriptor
 *  states it, else the `version` default of its `match` tool (sm64ds: 2004/b56). Undefined when the descriptor names none, which keeps every project that
 *  never declared one on the old "the compiler folder exists" check. */
export function pinnedCompilerVersion(desc: TangosDescriptor): string | undefined {
  const explicit = desc.project?.compilerPin
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const v = desc.tools?.find((t) => t.id === 'match')?.args?.find((a) => a.name === 'version')?.default
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export interface CompilerPinStatus {
  pin: string
  ok: boolean
  /** every build found under tools/<compiler>/, as version strings (e.g. 1.2/sp2p3) */
  installed: string[]
}

/** Is the pinned compiler build actually installed under tools/<compiler>/<pin>/? Null when there
 *  is nothing to check: no pin declared, no compiler named, or no tools/<compiler>/ folder (a
 *  compiler found on PATH, or a layout this check knows nothing about). A machine that only has
 *  the older builds passes a bare "folder exists" check and then fails every verify the descriptor
 *  tells the AI to run, which is the failure this exists to name up front. */
export function compilerPinStatus(repoPath: string, desc: TangosDescriptor): CompilerPinStatus | null {
  const name = desc.requirements?.compiler
  const pin = pinnedCompilerVersion(desc)
  if (!name || !pin) return null
  const root = join(repoPath, 'tools', name)
  try {
    if (!statSync(root).isDirectory()) return null
  } catch {
    return null
  }
  const exes = [`${name}.exe`, name]
  const hasExe = (dir: string): boolean => exes.some((e) => existsSync(join(dir, e)))
  const ok = hasExe(join(root, ...pin.split('/')))
  const installed: string[] = []
  const walk = (dir: string, rel: string[], depth: number): void => {
    if (depth > 3) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (rel.length && hasExe(dir)) installed.push(rel.join('/'))
    for (const e of entries) {
      const p = join(dir, e)
      try {
        if (statSync(p).isDirectory()) walk(p, [...rel, e], depth + 1)
      } catch {
        /* unreadable entry */
      }
    }
  }
  walk(root, [], 0)
  return { pin, ok, installed: installed.sort() }
}

/** Actually check whether the repo's declared requirements are satisfied on this machine. */
export async function preflight(repoPath: string, desc: TangosDescriptor): Promise<PreflightItem[]> {
  const req = desc.requirements ?? {}
  const python = desc.runtime?.python || 'python'
  const items: PreflightItem[] = []

  {
    const r = await run(python, ['--version'], repoPath)
    items.push({
      id: 'python', label: 'Python', ok: r.code === 0,
      detail: r.code === 0 ? r.out.trim() : 'not found on PATH',
      fix: 'Install Python 3 and let the installer add it to PATH, then hit re-check.',
      fixCmd: process.platform === 'win32' ? 'winget install Python.Python.3.12' : undefined,
      // Installing a runtime changes the machine, not the repo, so it asks first and is never
      // something Go applies on its own.
      fixAction: process.platform === 'win32' ? 'python' : undefined,
      fixLabel: 'Install Python',
      fixConfirm: 'This installs Python 3.12 on this computer using winget. Continue?',
      blocksScheduling: true
    })
  }

  if (req.pythonPackages?.length) {
    const imports = req.pythonPackages.map((p) => IMPORT_NAME[p.toLowerCase()] ?? p.replace(/-/g, '_'))
    const r = await run(python, ['-c', `import ${imports.join(', ')}`], repoPath)
    if (r.code === 0) {
      items.push({ id: 'pypkgs', label: 'Python packages', ok: true, detail: req.pythonPackages.join(', ') })
    } else {
      // Find which specific imports fail, for a useful message.
      const missing: string[] = []
      for (let i = 0; i < imports.length; i++) {
        const one = await run(python, ['-c', `import ${imports[i]}`], repoPath)
        if (one.code !== 0) missing.push(req.pythonPackages[i])
      }
      const hasReqTxt = existsSync(join(repoPath, 'requirements.txt'))
      items.push({
        id: 'pypkgs', label: 'Python packages', ok: false,
        detail: `missing: ${missing.join(', ') || 'unknown'}`,
        fix: 'Run this in the repo folder, then re-check:',
        fixCmd: hasReqTxt
          ? `${python} -m pip install -r requirements.txt`
          : `${python} -m pip install ${missing.join(' ') || req.pythonPackages.join(' ')}`,
        fixAction: 'pypkgs',
        fixLabel: 'Install packages',
        blocksScheduling: true
      })
    }
  }

  if (req.compiler) {
    const name = req.compiler
    const candidates = [`tools/${name}`, `tools/${name}.exe`, name, `${name}.exe`]
    let found = candidates.find((c) => existsSync(join(repoPath, c)))
    if (!found) {
      const w = await run(process.platform === 'win32' ? 'where' : 'which', [name], repoPath)
      if (w.code === 0 && w.out.trim()) found = w.out.trim().split(/\r?\n/)[0]
    }
    const pin = found ? compilerPinStatus(repoPath, desc) : null
    if (pin && !pin.ok) {
      // The folder is there but the build the repo pins is not. Name that, and what IS installed,
      // so the fix is "get this one build", not "install a compiler" to someone who has one.
      const setup = desc.project?.setup?.trim()
      items.push({
        id: 'compiler', label: `Compiler (${name} ${pin.pin})`, ok: false,
        detail: `${name} is installed, but the pinned build ${pin.pin} is missing (found: ${pin.installed.join(', ') || 'none'})`,
        fix: `This repo verifies and builds with ${name} ${pin.pin}. Put that build in tools/${name}/${pin.pin}/ - it can't be auto-downloaded.${setup ? ` Setup notes: ${setup.slice(0, 420)}` : ''}`,
        // Every ready-made verify call names this build, so nothing can pass without it.
        blocksScheduling: true
      })
    } else {
      items.push({
        id: 'compiler', label: pin ? `Compiler (${name} ${pin.pin})` : `Compiler (${name})`, ok: !!found,
        detail: found ? `found: ${found}${pin ? ` (pinned build ${pin.pin} present)` : ''}` : 'not found in repo tools/ or on PATH',
        // No command can fetch a proprietary compiler; point at where it goes + where it comes from.
        fix: `Put ${name} (and any license file it needs) in the repo's tools/${name}/ folder - it can't be auto-downloaded. The repo's setup notes say where to get it.`
      })
    }
  }

  if (req.rom) {
    const dirs = ['extracted', 'orig', 'baserom', 'build/extracted', 'expected']
    const found = dirs.find((d) => existsSync(join(repoPath, d)))
    const hasUnpack = existsSync(join(repoPath, 'tools', 'unpack.py'))
    items.push({
      id: 'rom', label: 'Extracted ROM', ok: !!found,
      detail: found ? `found: ${found}/` : 'no extracted ROM folder found',
      fix: 'Extract your own legally-dumped ROM into the repo, then re-check.',
      fixCmd: hasUnpack ? `${python} tools/unpack.py path/to/your-dump.nds` : undefined,
      // Nothing can produce someone's ROM for them, but it can stop being a command to retype:
      // the button opens a file picker and runs the repo's own unpack tool on what they choose.
      fixAction: hasUnpack ? 'rom' : undefined,
      fixLabel: 'Choose my ROM file',
      fixNeedsFile: { title: 'Choose your legally-dumped ROM', extensions: ['nds', 'srl', 'bin'] },
      blocksScheduling: true
    })
  }

  // The scheduler ranks functions out of the Atlas DB, so a missing one fails batch generation just
  // as hard as a missing ROM - but unlike the ROM this is a derived file the console can rebuild or
  // download. It was never checked here, so it only ever surfaced as a scheduler crash AFTER a Go.
  {
    const data = desc.data ?? {}
    const rel = data.dbPath || 'chaos-db.json'
    const canRebuild = !!data.generate || !!data.committedDbUrl
    if (canRebuild) {
      const ok = existsSync(join(repoPath, rel))
      items.push({
        id: 'chaosdb', label: 'Function data', ok,
        detail: ok ? `found: ${rel}` : `${rel} is missing`,
        fix: data.committedDbUrl
          ? 'Console can download the published copy, or rebuild it from your checkout.'
          : 'Console can rebuild this from your checkout.',
        fixCmd: data.generate,
        fixAction: 'chaosdb',
        fixLabel: 'Get the data',
        // The one requirement here that needs no ROM, no install and no decision - so Go repairs
        // it silently instead of refusing over a file it could have fetched itself.
        autoFixable: true,
        blocksScheduling: true
      })
    }
  }

  return items
}

/** Repair a failing requirement. `filePath` carries the user's pick for fixes that need one (the
 *  ROM). chaosdb is handled by the caller, which owns the descriptor's URLs and the Atlas cache. */
export async function runPreflightFix(
  id: 'python' | 'pypkgs' | 'rom',
  repoPath: string,
  desc: TangosDescriptor,
  filePath?: string
): Promise<PreflightFixResult> {
  const python = desc.runtime?.python || 'python'
  if (id === 'python') {
    if (process.platform !== 'win32') {
      return { ok: false, message: 'Automatic install is Windows-only. Install Python 3 from python.org.' }
    }
    const r = await run('winget', ['install', '--id', 'Python.Python.3.12', '-e', '--accept-package-agreements', '--accept-source-agreements'], repoPath)
    return r.code === 0
      ? { ok: true, message: 'Python installed. You may need to restart Console so it picks up the new PATH.' }
      : { ok: false, message: `winget failed: ${r.out.trim().slice(-300) || `exit ${r.code}`}` }
  }
  if (id === 'pypkgs') {
    const hasReqTxt = existsSync(join(repoPath, 'requirements.txt'))
    const args = hasReqTxt
      ? ['-m', 'pip', 'install', '-r', 'requirements.txt']
      : ['-m', 'pip', 'install', ...(desc.requirements?.pythonPackages ?? [])]
    if (args.length <= 4 && !hasReqTxt) return { ok: false, message: 'This repo names no Python packages to install.' }
    const r = await run(python, args, repoPath)
    return r.code === 0
      ? { ok: true, message: 'Packages installed.' }
      : { ok: false, message: `pip failed: ${r.out.trim().slice(-300) || `exit ${r.code}`}` }
  }
  // rom
  if (!filePath) return { ok: false, message: 'No ROM file chosen.' }
  if (!existsSync(join(repoPath, 'tools', 'unpack.py'))) {
    return { ok: false, message: 'This repo has no tools/unpack.py to extract with.' }
  }
  const r = await run(python, ['tools/unpack.py', filePath], repoPath)
  return r.code === 0
    ? { ok: true, message: 'ROM extracted.' }
    // unpack.py is what knows whether the dump is the right region/version, so pass its own words
    // through rather than inventing a diagnosis here.
    : { ok: false, message: r.out.trim().slice(-400) || `unpack.py exited ${r.code}` }
}

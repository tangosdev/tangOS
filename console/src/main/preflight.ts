import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TangosDescriptor, PreflightItem } from '../shared/types'

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
      fixCmd: process.platform === 'win32' ? 'winget install Python.Python.3.12' : undefined
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
          : `${python} -m pip install ${missing.join(' ') || req.pythonPackages.join(' ')}`
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
    items.push({
      id: 'compiler', label: `Compiler (${name})`, ok: !!found,
      detail: found ? `found: ${found}` : 'not found in repo tools/ or on PATH',
      // No command can fetch a proprietary compiler; point at where it goes + where it comes from.
      fix: `Put ${name} (and any license file it needs) in the repo's tools/${name}/ folder - it can't be auto-downloaded. The repo's setup notes say where to get it.`
    })
  }

  if (req.rom) {
    const dirs = ['extracted', 'orig', 'baserom', 'build/extracted', 'expected']
    const found = dirs.find((d) => existsSync(join(repoPath, d)))
    const hasUnpack = existsSync(join(repoPath, 'tools', 'unpack.py'))
    items.push({
      id: 'rom', label: 'Extracted ROM', ok: !!found,
      detail: found ? `found: ${found}/` : 'no extracted ROM folder found',
      fix: 'Extract your own legally-dumped ROM into the repo, then re-check.',
      fixCmd: hasUnpack ? `${python} tools/unpack.py path/to/your-dump.nds` : undefined
    })
  }

  return items
}

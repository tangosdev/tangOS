import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

export const WORK_BRANCH = 'tangos/work'

export interface ChangedFile {
  path: string
  status: 'new' | 'modified'
}

function git(repo: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    try {
      const c = spawn('git', args, { cwd: repo, env: process.env })
      c.stdout?.on('data', (d) => (out += d))
      c.stderr?.on('data', (d) => (err += d))
      c.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }))
      c.on('close', (code) => resolve({ code: code ?? -1, out, err }))
    } catch (e) {
      resolve({ code: -1, out, err: String(e) })
    }
  })
}

export async function isGitRepo(repo: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--is-inside-work-tree'])).code === 0
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()
}

/** path -> porcelain XY code. Untracked is "??". */
export async function statusMap(repo: string): Promise<Map<string, string>> {
  const r = await git(repo, ['status', '--porcelain=v1', '-z'])
  const map = new Map<string, string>()
  if (r.code !== 0) return map
  for (const tok of r.out.split('\0')) {
    if (tok.length < 4) continue
    map.set(tok.slice(3), tok.slice(0, 2))
  }
  return map
}

/** Files that appeared or changed between two status snapshots. */
export function changedSince(before: Map<string, string>, after: Map<string, string>): ChangedFile[] {
  const out: ChangedFile[] = []
  for (const [path, code] of after) {
    if (before.get(path) === code) continue
    out.push({ path, status: code === '??' ? 'new' : 'modified' })
  }
  return out
}

/** Switch onto the work branch (creating it if needed); returns the branch we came from. */
export async function ensureWorkBranch(repo: string): Promise<{ base: string }> {
  const cur = await currentBranch(repo)
  if (cur === WORK_BRANCH) return { base: WORK_BRANCH }
  const exists = (await git(repo, ['rev-parse', '--verify', WORK_BRANCH])).code === 0
  const res = exists ? await git(repo, ['checkout', WORK_BRANCH]) : await git(repo, ['checkout', '-b', WORK_BRANCH])
  if (res.code !== 0) throw new Error(`could not switch to ${WORK_BRANCH}: ${res.err.trim()}`)
  return { base: cur }
}

export async function diffForFile(repo: string, f: ChangedFile): Promise<string> {
  if (f.status === 'new') {
    try {
      const lines = readFileSync(join(repo, f.path), 'utf8').split('\n').slice(0, 400)
      return `new file: ${f.path}\n` + lines.map((l) => '+ ' + l).join('\n')
    } catch {
      return `new file: ${f.path} (binary or unreadable)`
    }
  }
  return (await git(repo, ['diff', '--', f.path])).out || `(no textual diff for ${f.path})`
}

/** Commit this run's files onto the (already checked-out) work branch. */
export async function commitFiles(repo: string, files: ChangedFile[], message: string): Promise<void> {
  if (!files.length) return
  await git(repo, ['add', '--', ...files.map((f) => f.path)])
  await git(repo, ['commit', '-m', message])
}

/** Merge the work branch into base (no-ff) and delete it. Leaves you on base. */
export async function mergeWorkBranch(repo: string, base: string): Promise<void> {
  const co = await git(repo, ['checkout', base])
  if (co.code !== 0) throw new Error(`could not check out ${base}: ${co.err.trim()}`)
  const mg = await git(repo, ['merge', '--no-ff', WORK_BRANCH, '-m', `tangos: merge ${WORK_BRANCH}`])
  if (mg.code !== 0) throw new Error(`merge failed: ${mg.err.trim()}`)
  await git(repo, ['branch', '-D', WORK_BRANCH])
}

/** Abandon the work branch: back to base, delete the branch (its commits are dropped). */
export async function discardWorkBranch(repo: string, base: string): Promise<void> {
  const co = await git(repo, ['checkout', base])
  if (co.code !== 0) throw new Error(`could not check out ${base}: ${co.err.trim()}`)
  const del = await git(repo, ['branch', '-D', WORK_BRANCH])
  if (del.code !== 0) throw new Error(`could not delete ${WORK_BRANCH}: ${del.err.trim()}`)
}

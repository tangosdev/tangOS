import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

export const WORK_BRANCH = 'tangos/work'

export interface ChangedFile {
  path: string
  status: 'new' | 'modified'
}

function git(
  repo: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    try {
      const c = spawn('git', args, { cwd: repo, env: env ? { ...process.env, ...env } : process.env })
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

/** Stage matched work (new/modified sources under src/, plus any tracked-file edits like
 *  ledgers/README) and commit it on the current branch. Returns true if a commit was made.
 *  Deliberately scoped: `git add src` + `git add -u` never grabs stray untracked scratch files. */
export async function commitMatchedWork(repo: string, message: string): Promise<boolean> {
  await git(repo, ['add', '--', 'src'])
  await git(repo, ['add', '-u'])
  const staged = await git(repo, ['diff', '--cached', '--name-only'])
  if (!staged.out.trim()) return false
  const res = await git(repo, ['commit', '-m', message])
  return res.code === 0
}

/** owner/repo parsed from a GitHub remote URL (https or ssh). Prefers "origin", then the
 *  current branch's push remote, then the first remote — so a fork named "fork" still works. */
export async function remoteSlug(repo: string): Promise<{ owner: string; repo: string } | null> {
  const parse = (url: string): { owner: string; repo: string } | null => {
    const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\s*$/i.exec(url.trim())
    return m ? { owner: m[1], repo: m[2] } : null
  }
  const names: string[] = []
  const origin = await git(repo, ['remote', 'get-url', 'origin'])
  if (origin.code === 0) return parse(origin.out)
  const list = await git(repo, ['remote'])
  for (const n of list.out.split(/\s+/).filter(Boolean)) names.push(n)
  for (const n of names) {
    const u = await git(repo, ['remote', 'get-url', n])
    if (u.code === 0) {
      const slug = parse(u.out)
      if (slug) return slug
    }
  }
  return null
}

/** Whether the working tree has any uncommitted or untracked changes (matched work not yet banked). */
export async function isDirty(repo: string): Promise<boolean> {
  return (await git(repo, ['status', '--porcelain'])).out.trim().length > 0
}

/** How many commits HEAD is ahead of / behind origin/<branch>. null if the remote ref is unknown
 *  (no fetch yet, or the branch doesn't exist on origin). */
export async function aheadBehind(repo: string, branch: string): Promise<{ ahead: number; behind: number } | null> {
  const ref = `origin/${branch}`
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', ref])).code !== 0) return null
  const r = await git(repo, ['rev-list', '--left-right', '--count', `HEAD...${ref}`])
  if (r.code !== 0) return null
  const m = /(\d+)\s+(\d+)/.exec(r.out.trim())
  if (!m) return null
  return { ahead: parseInt(m[1], 10), behind: parseInt(m[2], 10) }
}

/** Update remote-tracking refs from origin (best-effort; network may be down). */
export async function fetchRemote(repo: string): Promise<boolean> {
  return (await git(repo, ['fetch', '--quiet', 'origin'])).code === 0
}

/** Fast-forward the current branch to origin/<branch>. Never rewrites or discards local commits:
 *  if the branch has diverged (local commits not on origin), the ff-only merge fails cleanly and
 *  the caller surfaces the message. Untracked files are left untouched (git refuses to clobber). */
export async function fastForwardPull(repo: string, branch: string): Promise<{ ok: boolean; err: string }> {
  const f = await git(repo, ['fetch', '--quiet', 'origin', branch])
  if (f.code !== 0) return { ok: false, err: (f.err || f.out).trim() || 'fetch failed' }
  const r = await git(repo, ['merge', '--ff-only', `origin/${branch}`])
  return { ok: r.code === 0, err: (r.err || r.out).trim() }
}

/** The remote's default branch (what a PR should target), falling back to 'main'. */
export async function defaultBranch(repo: string): Promise<string> {
  const r = await git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const m = /origin\/(.+)\s*$/.exec(r.out.trim())
  if (m) return m[1]
  for (const b of ['main', 'master']) {
    if ((await git(repo, ['rev-parse', '--verify', `origin/${b}`])).code === 0) return b
  }
  return 'main'
}

/** Push the current branch to origin/<remoteBranch> using a token-authenticated URL (the token
 *  is never persisted to git config). The branch is session-owned so a plain push suffices:
 *  it creates the branch on the first push and fast-forwards it on later ones. (--force-with-lease
 *  is unusable here — there's no remote-tracking ref for an ad-hoc URL push, so it rejects the
 *  very first create.) On a non-ff (rare), fall back to a force push of the session branch. */
export async function pushToBranch(
  repo: string,
  remoteBranch: string,
  slug: { owner: string; repo: string },
  token: string
): Promise<{ ok: boolean; err: string }> {
  const url = `https://x-access-token:${token}@github.com/${slug.owner}/${slug.repo}.git`
  const spec = `HEAD:refs/heads/${remoteBranch}`
  let r = await git(repo, ['push', url, spec])
  if (r.code !== 0 && /\bnon-fast-forward\b|\brejected\b/i.test(r.err || r.out)) {
    r = await git(repo, ['push', '--force', url, spec]) // session-owned branch: safe to force
  }
  return { ok: r.code === 0, err: (r.err || r.out).trim() }
}

/** Merge the work branch into base (no-ff) and delete it. Leaves you on base. */
export async function mergeWorkBranch(repo: string, base: string): Promise<void> {
  const co = await git(repo, ['checkout', base])
  if (co.code !== 0) throw new Error(`could not check out ${base}: ${co.err.trim()}`)
  const mg = await git(repo, ['merge', '--no-ff', WORK_BRANCH, '-m', `tangos: merge ${WORK_BRANCH}`])
  if (mg.code !== 0) throw new Error(`merge failed: ${mg.err.trim()}`)
  await git(repo, ['branch', '-D', WORK_BRANCH])
}

/** Working-tree source files that are new or modified (porcelain), for per-agent attribution. */
export async function changedSrcFiles(repo: string): Promise<string[]> {
  const map = await statusMap(repo)
  const out: string[] = []
  for (const [p, code] of map) {
    if (!p.startsWith('src/')) continue
    if (code === '!!') continue // ignored
    out.push(p)
  }
  return out
}

/** Publish ONE agent's matched files as an isolated, squashed branch without ever touching the
 *  shared working tree or the checked-out branch. It builds a tree = base tree + the given
 *  working-tree files in a throwaway index (read-tree -> add -> write-tree -> commit-tree ->
 *  update-ref), then force-pushes the branch (the agent's own rolling PR head). This is what lets
 *  several AIs share one checkout yet each land in tangos/<agent>-<session> without colliding. */
export async function pushSubsetToBranch(
  repo: string,
  branch: string,
  base: string,
  files: string[],
  message: string,
  slug: { owner: string; repo: string },
  token: string
): Promise<{ ok: boolean; err: string }> {
  if (!files.length) return { ok: false, err: 'no files to push' }
  // Prefer the remote tip so the PR diffs cleanly against current main; fall back to local base.
  let baseRef = `origin/${base}`
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', baseRef])).code !== 0) baseRef = base
  const idxFile = join(tmpdir(), `tangos-idx-${process.pid}-${Date.now()}`)
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: idxFile }
  try {
    let r = await git(repo, ['read-tree', baseRef], env)
    if (r.code !== 0) return { ok: false, err: `read-tree: ${(r.err || r.out).trim()}` }
    r = await git(repo, ['add', '--', ...files], env)
    if (r.code !== 0) return { ok: false, err: `add: ${(r.err || r.out).trim()}` }
    const tree = (await git(repo, ['write-tree'], env)).out.trim()
    if (!tree) return { ok: false, err: 'write-tree produced no tree' }
    const parent = (await git(repo, ['rev-parse', baseRef])).out.trim()
    const commit = (await git(repo, ['commit-tree', tree, '-p', parent, '-m', message], env)).out.trim()
    if (!commit) return { ok: false, err: 'commit-tree produced no commit (is git user.name/email set?)' }
    const up = await git(repo, ['update-ref', `refs/heads/${branch}`, commit])
    if (up.code !== 0) return { ok: false, err: `update-ref: ${up.err.trim()}` }
    const url = `https://x-access-token:${token}@github.com/${slug.owner}/${slug.repo}.git`
    const push = await git(repo, ['push', '--force', url, `refs/heads/${branch}:refs/heads/${branch}`])
    return { ok: push.code === 0, err: (push.err || push.out).trim() }
  } finally {
    try {
      unlinkSync(idxFile)
    } catch {
      /* index file may not exist if read-tree never ran */
    }
  }
}

/** Abandon the work branch: back to base, delete the branch (its commits are dropped). */
export async function discardWorkBranch(repo: string, base: string): Promise<void> {
  const co = await git(repo, ['checkout', base])
  if (co.code !== 0) throw new Error(`could not check out ${base}: ${co.err.trim()}`)
  const del = await git(repo, ['branch', '-D', WORK_BRANCH])
  if (del.code !== 0) throw new Error(`could not delete ${WORK_BRANCH}: ${del.err.trim()}`)
}

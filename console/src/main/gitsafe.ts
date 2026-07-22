import { spawn } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { SyncPreview } from '../shared/types'

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

/** Parse `status --porcelain=v1 -z` output into {xy, path} entries. In -z mode a rename/copy
 *  entry is followed by its ORIGINAL path as a separate NUL token with no XY prefix - a naive
 *  token loop treats that as its own (bogus) entry and mangles it via slice(). Skip it here. */
function parsePorcelainZ(out: string): Array<{ xy: string; path: string }> {
  const toks = out.split('\0')
  const entries: Array<{ xy: string; path: string }> = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.length < 4) continue
    const xy = t.slice(0, 2)
    entries.push({ xy, path: t.slice(3) })
    if (xy[0] === 'R' || xy[0] === 'C') i++ // the next token is the rename's old path - not an entry
  }
  return entries
}

/** path -> porcelain XY code. Untracked is "??". */
export async function statusMap(repo: string): Promise<Map<string, string>> {
  const r = await git(repo, ['status', '--porcelain=v1', '-z'])
  const map = new Map<string, string>()
  if (r.code !== 0) return map
  for (const e of parsePorcelainZ(r.out)) map.set(e.path, e.xy)
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

/** owner/repo parsed from a GitHub remote URL (https or ssh). Prefers "origin", then the
 *  current branch's push remote, then the first remote - so a fork named "fork" still works. */
export async function remoteSlug(repo: string): Promise<{ owner: string; repo: string } | null> {
  const parse = (url: string): { owner: string; repo: string } | null => {
    // repo segment allows dots ("some.repo"); only a trailing ".git" is stripped
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\s*$/i.exec(url.trim())
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

/** git config user.name for the repo, for naming a contributor's push branch. Falls back to ''. */
export async function gitUserName(repo: string): Promise<string> {
  return (await git(repo, ['config', 'user.name'])).out.trim()
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

/** Count of local commits whose CHANGES aren't already on origin/<branch> - the "genuinely
 *  unpublished" number, distinct from the SHA-topology `ahead` (which counts a commit as ahead even
 *  after it was squash/rebase-merged upstream under a new SHA). Robust to squash merges: first a
 *  content check (does merging HEAD into origin add anything?), then a per-commit patch-id count. */
export async function unmergedAhead(repo: string, branch: string): Promise<number> {
  const ref = `origin/${branch}`
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', ref])).code !== 0) return 0
  // Content gate (handles multi-commit squashes cherry can't): if the 3-way merge of HEAD into
  // origin yields origin's exact tree, HEAD contributes nothing new -> everything is published.
  const mt = await git(repo, ['merge-tree', '--write-tree', ref, 'HEAD'])
  if (mt.code === 0) {
    const mergedTree = mt.out.trim().split('\n')[0]
    const originTree = await git(repo, ['rev-parse', `${ref}^{tree}`])
    if (originTree.code === 0 && mergedTree === originTree.out.trim()) return 0
  }
  // There is unpublished content: count commits with no patch-equivalent upstream (git cherry
  // marks those with '+'; '-' means an equivalent is already on origin, e.g. a merged single commit).
  const r = await git(repo, ['cherry', ref, 'HEAD'])
  if (r.code !== 0) return 0
  return r.out.split('\n').filter((l) => l.startsWith('+')).length
}

/** Update remote-tracking refs from origin (best-effort; network may be down). */
export async function fetchRemote(repo: string): Promise<boolean> {
  return (await git(repo, ['fetch', '--quiet', 'origin'])).code === 0
}

/** src/*.c|.cpp files ADDED to origin/<branch> in the last `sinceHours` - i.e. functions matched
 *  (a match lands by adding its source) in that window. Fetches first so the window reflects true
 *  main, not wherever the local checkout sits. Returns the bare filename stems (no dir, no ext:
 *  "func_02048720"), which are the function names the Atlas keys on. */
export async function recentlyAddedSrc(repo: string, branch: string, sinceHours: number): Promise<string[]> {
  await git(repo, ['fetch', '--quiet', 'origin', branch])
  const r = await git(repo, [
    'log', `origin/${branch}`, `--since=${sinceHours} hours ago`,
    '--diff-filter=A', '--name-only', '--pretty=format:'
  ])
  if (r.code !== 0) return []
  const stems = new Set<string>()
  for (const line of r.out.split('\n')) {
    const p = line.trim()
    if (p.startsWith('src/') && /\.(c|cpp)$/.test(p)) stems.add(p.replace(/^src\//, '').replace(/\.(c|cpp)$/, ''))
  }
  return [...stems]
}

/** Bring in new upstream work while keeping local commits: rebase the current branch onto
 *  origin/<branch>. Fast-forwards with no local commits; otherwise replays them (dropping any that
 *  were already merged). --autostash handles uncommitted TRACKED changes.
 *
 *  Untracked files are the tricky part: a new match source you haven't committed collides with the
 *  same path arriving from upstream (someone else merged that function), and git refuses to clobber
 *  it - "would be overwritten by checkout" - aborting the whole rebase. We clear the path first,
 *  safely: every colliding untracked file is moved into a backup dir under .git/. After a SUCCESSFUL
 *  rebase, byte-identical ones (redundant dups) are discarded and any that DIFFERED are kept in the
 *  backup so nothing is lost; on FAILURE every moved file is restored exactly where it was. `note`
 *  reports any files kept aside. */
export async function rebasePull(
  repo: string,
  branch: string,
  onProgress?: (label: string, pct: number) => void
): Promise<{ ok: boolean; err: string; note?: string }> {
  const report = onProgress ?? ((): void => {})
  const ref = `origin/${branch}`

  report('Fetching from origin', 10)
  const f = await git(repo, ['fetch', '--quiet', 'origin', branch])
  if (f.code !== 0) return { ok: false, err: (f.err || f.out).trim() || 'fetch failed' }

  // Self-heal a broken half-state from a PRIOR update that conflicted and aborted messily: it can
  // leave the index with unmerged (conflict) entries and no active rebase, which then wedges EVERY
  // future update at the autostash step ("Cannot save the current index state / Cannot autostash").
  // Abort any lingering rebase/merge, then reset the still-conflicted paths to HEAD - conflict stages
  // aren't user work, and these are typically generated files (e.g. contributions.json) that get
  // their real content from the rebase below anyway.
  await git(repo, ['rebase', '--abort']) // no-op (nonzero) if no rebase is active
  await git(repo, ['merge', '--abort']) // no-op (nonzero) if no merge is active
  const unmerged = (await git(repo, ['ls-files', '--unmerged'])).out.trim()
  if (unmerged) {
    const paths = [...new Set(unmerged.split('\n').map((l) => l.split('\t').pop()).filter(Boolean))]
    // `reset -- <p>` clears the unmerged INDEX entries without touching the working tree (a
    // `checkout HEAD -- <p>` here would clobber any hand-edit made to the conflicted file). The
    // worktree content then rides the rebase's --autostash below as a normal modification.
    for (const p of paths) await git(repo, ['reset', '-q', '--', p as string])
  }

  // Find untracked files that collide with a path arriving from upstream (those block the checkout).
  // One ls-tree yields every upstream path + its blob OID, so we intersect in memory and only touch
  // the real collisions - no git subprocess per untracked file (a big repo has hundreds, and that
  // per-file spawn loop was what made Update feel frozen).
  report('Checking your local files', 30)
  const upstream = new Map<string, string>()
  for (const line of (await git(repo, ['ls-tree', '-r', ref])).out.split('\n')) {
    const m = /^\S+\s+blob\s+(\S+)\t(.+)$/.exec(line) // "<mode> blob <oid>\t<path>"
    if (m) upstream.set(m[2], m[1])
  }
  const others = (await git(repo, ['ls-files', '--others', '--exclude-standard'])).out
    .split('\n').map((s) => s.trim()).filter(Boolean)
  const collisions = others.filter((o) => upstream.has(o))

  const backupRoot = join(repo, '.git', `tangos-update-backup-${Date.now()}`)
  const moved: { path: string; identical: boolean }[] = []
  for (let i = 0; i < collisions.length; i++) {
    const path = collisions[i]
    report(`Setting aside local files (${i + 1}/${collisions.length})`, 30 + Math.round(((i + 1) / collisions.length) * 35))
    const local = (await git(repo, ['hash-object', path])).out.trim()
    try {
      const dest = join(backupRoot, path)
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(join(repo, path), dest)
      moved.push({ path, identical: local === upstream.get(path) })
    } catch {
      /* couldn't move it: the rebase will report the collision; we abort + restore below */
    }
  }

  // Put every moved file back exactly where it was. The backup dir is deleted ONLY when every
  // rename-back succeeded - on Windows a destination can be held by AV/an editor/an agent process,
  // and deleting the backup after a failed restore was a permanent-loss path for the very files
  // this mechanism exists to protect. Returns the paths it could NOT restore (still in the backup).
  const restore = (): string[] => {
    const failed: string[] = []
    for (const m of moved) {
      try {
        mkdirSync(dirname(join(repo, m.path)), { recursive: true })
        renameSync(join(backupRoot, m.path), join(repo, m.path))
      } catch {
        failed.push(m.path)
      }
    }
    if (failed.length === 0) {
      try { rmSync(backupRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    return failed
  }

  report('Applying the update', 75)
  const r = await git(repo, ['rebase', '--autostash', ref])
  if (r.code !== 0) {
    await git(repo, ['rebase', '--abort'])
    const failed = restore()
    const base = (r.err || r.out).trim() || 'rebase failed (conflict)'
    return {
      ok: false,
      err: failed.length
        ? `${base}\n${failed.length} set-aside file${failed.length === 1 ? '' : 's'} could not be moved back (still safe in ${backupRoot}): ${failed.join(', ')}`
        : base
    }
  }

  // --autostash re-applies the stashed uncommitted TRACKED changes AFTER the rebase. When that apply
  // CONFLICTS (a local edit to a file upstream also changed - e.g. the auto-generated nearmiss/db.jsonl
  // or contributions.json the console itself keeps rewriting), git leaves conflict markers in the tree
  // AND keeps the autostash, yet STILL EXITS 0 (verified). The old success path shipped that broken
  // tree with an orphaned stash - the source of the recurring UU/UD conflicts and the stray autostash
  // pile-up. Detect it, reset the conflicted files to the rebased (upstream) version - these are
  // regenerated / re-pushed by the console anyway - and drop the orphaned autostash.
  let autostashNote: string | undefined
  const popConflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).out
    .split('\n').map((s) => s.trim()).filter(Boolean)
  if (popConflicts.length) {
    await git(repo, ['checkout', '--force', 'HEAD', '--', ...popConflicts])
    await git(repo, ['stash', 'drop']) // git kept the failed autostash as stash@{0}
    autostashNote = `${popConflicts.length} locally-modified file(s) superseded by upstream during sync (reset to upstream): ${popConflicts.slice(0, 4).join(', ')}${popConflicts.length > 4 ? '…' : ''}`
  }

  // Rebase landed. Identical backups are pure dups of what upstream just checked out -> discard.
  // Differing ones are kept so the contributor can compare/recover their version.
  report('Finishing up', 95)
  const kept = moved.filter((m) => !m.identical)
  for (const m of moved) {
    if (m.identical) { try { unlinkSync(join(backupRoot, m.path)) } catch { /* ignore */ } }
  }
  let note: string | undefined = autostashNote
  if (kept.length) {
    const setAside = `Set aside ${kept.length} local file${kept.length === 1 ? '' : 's'} that upstream had also matched (different code) -> ${backupRoot}`
    note = note ? `${note}\n${setAside}` : setAside
  } else {
    try { rmSync(backupRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  report('Done', 100)
  return { ok: true, err: '', note }
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

/** Raw contents of `path` at a git `ref` (e.g. "origin/main"), or '' if the file does not exist
 *  there. Reads from the object store, so it works for a large file the GitHub contents API would
 *  truncate. Caller should fetchBase() first if reading an origin ref. */
export async function showFile(repo: string, ref: string, path: string): Promise<string> {
  const r = await git(repo, ['show', `${ref}:${path}`])
  return r.code === 0 ? r.out : ''
}

/** Push the current branch to origin/<remoteBranch> using a token-authenticated URL (the token
 *  is never persisted to git config). The branch is session-owned so a plain push suffices:
 *  it creates the branch on the first push and fast-forwards it on later ones. (--force-with-lease
 *  is unusable here - there's no remote-tracking ref for an ad-hoc URL push, so it rejects the
 *  very first create.) On a non-ff (rare), fall back to a force push of the session branch. */
/** Strip the token-authenticated URL out of git's output before it goes ANYWHERE user-visible.
 *  On a failed push, git echoes the full push URL (with the embedded token) into stderr, and that
 *  string was riding into the UI status chip, debug dumps, and shared bug reports - a credential
 *  leak. Scrub both the generic credential-in-URL shape and the literal token, at the source. */
export function scrubToken(s: string, token?: string): string {
  let out = s.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
  if (token) out = out.split(token).join('***')
  return out
}

/** Merge the work branch into base (no-ff) and delete it. Leaves you on base. */
export async function mergeWorkBranch(repo: string, base: string): Promise<void> {
  const co = await git(repo, ['checkout', base])
  if (co.code !== 0) throw new Error(`could not check out ${base}: ${co.err.trim()}`)
  const mg = await git(repo, ['merge', '--no-ff', WORK_BRANCH, '-m', `tangos: merge ${WORK_BRANCH}`])
  if (mg.code !== 0) throw new Error(`merge failed: ${mg.err.trim()}`)
  await git(repo, ['branch', '-D', WORK_BRANCH])
}

/** Best-effort `git fetch origin <branch>` so origin/<branch> is current before a push builds a
 *  PR tree on it. A checkout that hasn't fetched for hours otherwise diffs against a stale base,
 *  and the PR re-includes files that already landed upstream (the duplicate-file PR bug). Failures
 *  (offline, no remote) are swallowed - the push then falls back to whatever origin/<branch> is. */
export async function fetchBase(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ['fetch', '--quiet', 'origin', branch])).code === 0
}

/** How a working-tree file relates to origin/<base>: 'absent' (not upstream - normal for a fresh
 *  match), 'identical' (already landed upstream - nothing left to PR), or 'differs' (upstream has
 *  its own version - ours is superseded; never overwrite someone else's landed match). */
export async function upstreamState(repo: string, base: string, path: string): Promise<'absent' | 'identical' | 'differs'> {
  const ref = `origin/${base}`
  if ((await git(repo, ['cat-file', '-e', `${ref}:${path}`])).code !== 0) return 'absent'
  // diff --quiet: exit 0 = worktree file byte-equals the committed blob (after filters)
  return (await git(repo, ['diff', '--quiet', ref, '--', path])).code === 0 ? 'identical' : 'differs'
}

/** Does origin/<base>'s version of this file still carry the NONMATCHING marker? When it does, a
 *  locally verified byte-match is an UPGRADE worth shipping (nonmatching -> byte-exact), not a
 *  "superseded, drop it" the way a 'differs' against an already-matched upstream would be. */
export async function upstreamIsNonmatching(repo: string, base: string, path: string): Promise<boolean> {
  const r = await git(repo, ['show', `origin/${base}:${path}`])
  if (r.code !== 0) return false
  // The repo convention puts the marker in the file's HEADER (line 1, or right after a //cpp
  // first line). Check only the first few lines so an explanatory comment deeper in the file
  // ("// not NONMATCHING anymore") can't false-positive, and accept a block-comment form too.
  const head = r.out.split('\n', 4).join('\n')
  return /(^|\n)\s*(\/\/|\/\*)\s*NONMATCHING\b/i.test(head)
}

/** src/*.c|.cpp files a diverged local branch introduces vs origin/<base> that AREN'T already
 *  landed upstream - the genuinely-unpublished matches a diverged clone should PR. Diffs the
 *  merge-base..HEAD range (only this branch's own commits) and keeps files upstream lacks
 *  ('absent'); drops 'identical' (already merged) and 'differs' (upstream has its own version -
 *  superseded, never overwrite a landed match). A .c<->.cpp rename guard drops stale pre-rename
 *  drafts (upstream has the sibling extension). This is what stops a checkout that has drifted
 *  behind main from re-PRing already-merged work or reverting generated files. */
export async function newSrcVsBase(repo: string, base: string): Promise<string[]> {
  const ref = `origin/${base}`
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', ref])).code !== 0) return []
  const d = await git(repo, ['diff', '--name-only', '--diff-filter=ACMR', `${ref}...HEAD`, '--', 'src'])
  if (d.code !== 0) return []
  const out: string[] = []
  for (const line of d.out.split('\n')) {
    const p = line.trim()
    const m = /^(src\/.+)\.(c|cpp)$/.exec(p)
    if (!m) continue
    if ((await upstreamState(repo, base, p)) !== 'absent') continue // already landed or superseded
    const sibling = `${m[1]}.${m[2] === 'c' ? 'cpp' : 'c'}` // this match may have landed under the other ext
    if ((await git(repo, ['cat-file', '-e', `${ref}:${sibling}`])).code === 0) continue
    out.push(p)
  }
  return out
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
 *  shared working tree or the checked-out branch. It builds a tree = base tree + the given files
 *  in a throwaway index (read-tree -> stage -> write-tree -> commit-tree -> update-ref), then
 *  force-pushes the branch (the agent's own rolling PR head). This is what lets several AIs share
 *  one checkout yet each land in tangos/<agent>-<session> without colliding.
 *
 *  What gets staged, per file:
 *   - opts.contents has the path -> those EXACT bytes ship (the auto-push verified snapshot; a
 *     refine loop rewriting the worktree file between verify and push can no longer smuggle
 *     unverified bytes into a "matched" PR - the TOCTOU the snapshot gate almost closed).
 *   - opts.fromHead -> the committed HEAD blob ships (repo:pushWorkPr's contract is "push those
 *     commits", not whatever the worktree has drifted to since).
 *   - otherwise -> plain `git add` of the worktree file (legacy behavior). */
export async function pushSubsetToBranch(
  repo: string,
  branch: string,
  base: string,
  files: string[],
  message: string,
  slug: { owner: string; repo: string },
  token: string,
  opts?: { contents?: Map<string, string>; fromHead?: boolean }
): Promise<{ ok: boolean; err: string }> {
  if (!files.length) return { ok: false, err: 'no files to push' }
  // Never write the safe-mode work branch (an unset git user.name once fell back to exactly this
  // name and silently moved the checked-out branch), and never update-ref whatever IS checked out.
  if (branch === WORK_BRANCH) return { ok: false, err: `refusing to push to the reserved branch ${WORK_BRANCH}` }
  if ((await currentBranch(repo)) === branch)
    return { ok: false, err: `refusing to move the checked-out branch ${branch}` }
  // Prefer the remote tip so the PR diffs cleanly against current main; fall back to local base.
  let baseRef = `origin/${base}`
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', baseRef])).code !== 0) baseRef = base
  // Resolve the base ONCE: a concurrent fetch can move origin/<base> between read-tree and the
  // parent lookup, producing a tree built on old-base with a new-base parent - a PR that reverts
  // everything landed in between.
  const baseSha = (await git(repo, ['rev-parse', baseRef])).out.trim()
  if (!baseSha) return { ok: false, err: `could not resolve ${baseRef}` }
  const idxFile = join(tmpdir(), `tangos-idx-${process.pid}-${randomUUID()}`)
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: idxFile }
  try {
    let r = await git(repo, ['read-tree', baseSha], env)
    if (r.code !== 0) return { ok: false, err: `read-tree: ${(r.err || r.out).trim()}` }
    const plainAdd: string[] = []
    for (const f of files) {
      const snap = opts?.contents?.get(f)
      if (snap != null) {
        // Ship the snapshot bytes: hash the string into the object store, stage by oid.
        const tmp = join(tmpdir(), `tangos-blob-${randomUUID()}`)
        writeFileSync(tmp, snap)
        const oid = (await git(repo, ['hash-object', '-w', tmp])).out.trim()
        try { unlinkSync(tmp) } catch { /* ignore */ }
        if (!oid) return { ok: false, err: `hash-object failed for ${f}` }
        r = await git(repo, ['update-index', '--add', '--cacheinfo', `100644,${oid},${f}`], env)
        if (r.code !== 0) return { ok: false, err: `stage ${f}: ${(r.err || r.out).trim()}` }
      } else if (opts?.fromHead) {
        const oid = (await git(repo, ['rev-parse', `HEAD:${f}`])).out.trim()
        if (!oid) return { ok: false, err: `${f} is not in HEAD - commit it first` }
        r = await git(repo, ['update-index', '--add', '--cacheinfo', `100644,${oid},${f}`], env)
        if (r.code !== 0) return { ok: false, err: `stage ${f}: ${(r.err || r.out).trim()}` }
      } else plainAdd.push(f)
    }
    if (plainAdd.length) {
      r = await git(repo, ['add', '--', ...plainAdd], env)
      if (r.code !== 0) return { ok: false, err: `add: ${(r.err || r.out).trim()}` }
    }
    const tree = (await git(repo, ['write-tree'], env)).out.trim()
    if (!tree) return { ok: false, err: 'write-tree produced no tree' }
    const commit = (await git(repo, ['commit-tree', tree, '-p', baseSha, '-m', message], env)).out.trim()
    if (!commit) return { ok: false, err: 'commit-tree produced no commit (is git user.name/email set?)' }
    const up = await git(repo, ['update-ref', `refs/heads/${branch}`, commit])
    if (up.code !== 0) return { ok: false, err: `update-ref: ${up.err.trim()}` }
    const url = `https://x-access-token:${token}@github.com/${slug.owner}/${slug.repo}.git`
    const push = await git(repo, ['push', '--force', url, `refs/heads/${branch}:refs/heads/${branch}`])
    return { ok: push.code === 0, err: scrubToken((push.err || push.out).trim(), token) }
  } finally {
    try {
      unlinkSync(idxFile)
    } catch {
      /* index file may not exist if read-tree never ran */
    }
  }
}

/** Commit a subset of files to a LOCAL branch without pushing and without touching the working tree
 *  or the checked-out branch - the crash-proof twin of pushSubsetToBranch. Banks verified matches
 *  (the recovery branch) the instant they're found, so a crash, an app close, a Push-off session, or
 *  a failed PR can't strand finished work in an uncommitted worktree. Rebuilds the branch as a single
 *  commit = base tree + the given files every call, so it's idempotent - pass the growing cumulative
 *  set and the branch always reflects everything recovered so far.
 *
 *  Bytes staged per file mirror pushSubsetToBranch: opts.contents ships those EXACT verified bytes;
 *  otherwise the current worktree file is added. No network, so nothing here can 403/timeout - the
 *  durability guarantee holds even fully offline. */
export async function commitSubsetToLocalBranch(
  repo: string,
  branch: string,
  base: string,
  files: string[],
  message: string,
  opts?: { contents?: Map<string, string> }
): Promise<{ ok: boolean; err: string; commit?: string }> {
  if (!files.length) return { ok: false, err: 'no files to commit' }
  // Same guards as pushSubsetToBranch: never write the reserved work branch, never move whatever is
  // checked out (update-ref on the current branch would desync HEAD from the worktree).
  if (branch === WORK_BRANCH) return { ok: false, err: `refusing to write the reserved branch ${WORK_BRANCH}` }
  if ((await currentBranch(repo)) === branch)
    return { ok: false, err: `refusing to move the checked-out branch ${branch}` }
  // Prefer origin/<base> so the recovery branch diffs cleanly against current main; fall back to the
  // local base, then HEAD, so a never-fetched or detached checkout can still bank its work.
  let baseRef = `origin/${base}`
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', baseRef])).code !== 0) baseRef = base
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', baseRef])).code !== 0) baseRef = 'HEAD'
  const baseSha = (await git(repo, ['rev-parse', baseRef])).out.trim()
  if (!baseSha) return { ok: false, err: `could not resolve ${baseRef}` }
  const idxFile = join(tmpdir(), `tangos-hidx-${process.pid}-${randomUUID()}`)
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: idxFile }
  try {
    let r = await git(repo, ['read-tree', baseSha], env)
    if (r.code !== 0) return { ok: false, err: `read-tree: ${(r.err || r.out).trim()}` }
    const plainAdd: string[] = []
    for (const f of files) {
      const snap = opts?.contents?.get(f)
      if (snap != null) {
        const tmp = join(tmpdir(), `tangos-hblob-${randomUUID()}`)
        writeFileSync(tmp, snap)
        const oid = (await git(repo, ['hash-object', '-w', tmp])).out.trim()
        try { unlinkSync(tmp) } catch { /* ignore */ }
        if (!oid) return { ok: false, err: `hash-object failed for ${f}` }
        r = await git(repo, ['update-index', '--add', '--cacheinfo', `100644,${oid},${f}`], env)
        if (r.code !== 0) return { ok: false, err: `stage ${f}: ${(r.err || r.out).trim()}` }
      } else plainAdd.push(f)
    }
    if (plainAdd.length) {
      r = await git(repo, ['add', '--', ...plainAdd], env)
      if (r.code !== 0) return { ok: false, err: `add: ${(r.err || r.out).trim()}` }
    }
    const tree = (await git(repo, ['write-tree'], env)).out.trim()
    if (!tree) return { ok: false, err: 'write-tree produced no tree' }
    const commit = (await git(repo, ['commit-tree', tree, '-p', baseSha, '-m', message], env)).out.trim()
    if (!commit) return { ok: false, err: 'commit-tree produced no commit (is git user.name/email set?)' }
    const up = await git(repo, ['update-ref', `refs/heads/${branch}`, commit])
    if (up.code !== 0) return { ok: false, err: `update-ref: ${up.err.trim()}` }
    return { ok: true, err: '', commit }
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

// ---- Hard "Sync repo": reset the checkout to origin/<default>, minus the gitignored setup --------

/** What a hard sync would throw away, so the confirm can name real numbers. Fetches first so
 *  behind/ahead reflect true origin. Untracked count excludes gitignored files (porcelain omits
 *  them here), matching `git clean -fd` which keeps the extracted ROM / deps / .env. */
export async function syncPreview(repo: string): Promise<SyncPreview> {
  await fetchRemote(repo)
  const db = await defaultBranch(repo)
  const branch = await currentBranch(repo)
  const ab = await aheadBehind(repo, db)
  const r = await git(repo, ['status', '--porcelain=v1', '-uall', '-z'])
  let localChanges = 0
  let untracked = 0
  if (r.code === 0) {
    for (const e of parsePorcelainZ(r.out)) {
      if (e.xy === '??') untracked++
      else localChanges++
    }
  }
  return { branch, defaultBranch: db, behind: ab?.behind ?? 0, ahead: ab?.ahead ?? 0, localChanges, untracked }
}

/** Copy every at-risk working-tree file (modified tracked + untracked non-ignored) and bundle all
 *  local branch tips into a timestamped sibling backup folder, so a hard sync is undoable. `stamp`
 *  is passed in - main owns the clock. Ignored setup files aren't copied (the sync keeps them). */
export async function backupBeforeSync(
  repo: string,
  stamp: string
): Promise<{ path: string; files: number; bundle: boolean }> {
  const dest = join(dirname(repo), `${basename(repo)}-backup-${stamp}`)
  mkdirSync(join(dest, 'files'), { recursive: true })
  const r = await git(repo, ['status', '--porcelain=v1', '-uall', '-z'])
  let files = 0
  if (r.code === 0) {
    for (const e of parsePorcelainZ(r.out)) {
      const xy = e.xy
      if (xy[0] === 'D' || xy[1] === 'D') continue // a deletion - reset restores it from history
      const rel = e.path
      const src = join(repo, rel)
      if (!existsSync(src)) continue // already gone
      const to = join(dest, 'files', rel)
      try {
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(src, to)
        files++
      } catch {
        /* skip unreadable file */
      }
    }
  }
  const bundlePath = join(dest, 'local-commits.bundle')
  const bundle = (await git(repo, ['bundle', 'create', bundlePath, '--branches', '--tags'])).code === 0
  writeFileSync(
    join(dest, 'RESTORE.txt'),
    [
      'tangOS Console - pre-sync backup',
      `taken ${stamp} from ${repo}`,
      '',
      'files/                 working-tree copies of everything the sync deleted or reverted',
      'local-commits.bundle   all local branch tips at backup time',
      '',
      'Restore a file:   copy it back from files/ into the repo.',
      'Restore commits:  git fetch "local-commits.bundle" "refs/heads/*:refs/heads/recovered/*"',
      '                  then check out or cherry-pick what you need.',
      ''
    ].join('\n')
  )
  return { path: dest, files, bundle }
}

/** Hard-reset the checkout to origin/<default> and remove untracked (non-ignored) files - the
 *  "fresh clone" state, minus the gitignored setup (extracted ROM, deps, .env) which is kept.
 *  Destructive: discards local commits, uncommitted changes, and custom/untracked files. */
export async function syncToOrigin(
  repo: string,
  onProgress?: (label: string, pct: number) => void
): Promise<{ ok: boolean; branch: string; head: string; err?: string }> {
  if (!(await remoteSlug(repo))) return { ok: false, branch: '', head: '', err: 'no GitHub "origin" remote to sync from' }
  // Clear any in-progress rebase/merge FIRST (a wedged repo is exactly when people reach for Sync).
  // Left in place, the stale .git/rebase-merge survives the checkout and the NEXT Update's
  // self-heal `rebase --abort` would restore the pre-sync branch head - silently un-syncing.
  await git(repo, ['rebase', '--abort']) // no-op (nonzero) when no rebase is active
  await git(repo, ['merge', '--abort']) // no-op (nonzero) when no merge is active
  onProgress?.('Fetching origin', 15)
  if (!(await fetchRemote(repo))) return { ok: false, branch: '', head: '', err: 'git fetch origin failed - check your connection' }
  const db = await defaultBranch(repo)
  onProgress?.(`Resetting to origin/${db}`, 55)
  // -f discards local working-tree changes; -B resets (or creates) the local default branch to
  // origin's and switches to it, so we land on a clean default branch wherever HEAD started.
  const co = await git(repo, ['checkout', '-f', '-B', db, `origin/${db}`])
  if (co.code !== 0) return { ok: false, branch: db, head: '', err: `checkout failed: ${(co.err || co.out).trim()}` }
  await git(repo, ['reset', '--hard', `origin/${db}`]) // belt-and-suspenders in case of an odd state
  onProgress?.('Removing untracked files', 80)
  const clean = await git(repo, ['clean', '-fd']) // -d dirs, NO -x: keep gitignored setup
  if (clean.code !== 0) return { ok: false, branch: db, head: '', err: `clean failed: ${clean.err.trim()}` }
  const head = (await git(repo, ['rev-parse', '--short', 'HEAD'])).out.trim()
  onProgress?.('Done', 100)
  return { ok: true, branch: db, head }
}

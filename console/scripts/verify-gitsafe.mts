// Validates the safe-mode git plumbing in a throwaway temp repo (never your real repo).
// Run: npx tsx scripts/verify-gitsafe.mts
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  currentBranch, ensureWorkBranch, statusMap, changedSince, diffForFile, commitFiles,
  mergeWorkBranch, discardWorkBranch, WORK_BRANCH
} from '../src/main/gitsafe'

function sh(repo: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '' }
}
function log(...a: unknown[]): void {
  console.log('[gitsafe]', ...a)
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
}

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'tangos-git-'))
  sh(repo, ['init', '-b', 'main'])
  sh(repo, ['config', 'user.email', 't@t.dev'])
  sh(repo, ['config', 'user.name', 'tangos test'])
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'a.c'), 'int a(){return 1;}\n')
  sh(repo, ['add', '-A'])
  sh(repo, ['commit', '-m', 'init'])
  log('temp repo at', repo, '· base', await currentBranch(repo))

  // ---- simulate a mutating run on the work branch ----
  const { base } = await ensureWorkBranch(repo)
  assert(base === 'main', `base should be main, got ${base}`)
  assert((await currentBranch(repo)) === WORK_BRANCH, 'should be on tangos/work')

  const before = await statusMap(repo)
  writeFileSync(join(repo, 'src', 'b.c'), 'int b(){return 2;}\n') // new
  writeFileSync(join(repo, 'src', 'a.c'), 'int a(){return 42;}\n') // modified
  const after = await statusMap(repo)
  const changed = changedSince(before, after)
  log('changed:', changed.map((c) => `${c.path}:${c.status}`).join(', '))
  assert(changed.length === 2, `expected 2 changed, got ${changed.length}`)

  const newDiff = await diffForFile(repo, changed.find((c) => c.path === 'src/b.c')!)
  assert(/\+\s*int b/.test(newDiff), 'new-file diff should show added content')
  const modDiff = await diffForFile(repo, changed.find((c) => c.path === 'src/a.c')!)
  assert(modDiff.includes('42'), 'modified diff should show the new value')

  await commitFiles(repo, changed, 'tangos: test')
  assert(sh(repo, ['log', '--oneline']).stdout.includes('tangos: test'), 'work branch should have the commit')
  log('run + commit on work branch OK')

  // ---- merge path ----
  await mergeWorkBranch(repo, 'main')
  assert((await currentBranch(repo)) === 'main', 'should be back on main after merge')
  assert(existsSync(join(repo, 'src', 'b.c')), 'new file should exist on main after merge')
  assert(readFileSync(join(repo, 'src', 'a.c'), 'utf8').includes('42'), 'modification should be merged')
  assert(sh(repo, ['rev-parse', '--verify', WORK_BRANCH]).status !== 0, 'work branch should be deleted after merge')
  log('MERGE path OK')

  // ---- discard path ----
  await ensureWorkBranch(repo)
  const before2 = await statusMap(repo)
  writeFileSync(join(repo, 'src', 'c.c'), 'int c(){return 3;}\n')
  const changed2 = changedSince(before2, await statusMap(repo))
  await commitFiles(repo, changed2, 'tangos: doomed')
  await discardWorkBranch(repo, 'main')
  assert((await currentBranch(repo)) === 'main', 'should be back on main after discard')
  assert(!existsSync(join(repo, 'src', 'c.c')), 'discarded file must NOT exist on main')
  assert(sh(repo, ['rev-parse', '--verify', WORK_BRANCH]).status !== 0, 'work branch should be deleted after discard')
  log('DISCARD path OK')

  log('ALL GITSAFE CHECKS PASSED ✓')
  process.exit(0)
}

main().catch((e) => {
  console.error('[gitsafe] FAILED:', e)
  process.exit(1)
})

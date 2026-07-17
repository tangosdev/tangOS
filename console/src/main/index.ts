import './appName' // MUST be first: renames the data folder + migrates it before anything reads userData
import { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, globalShortcut } from 'electron'
import { dumpDebug, debugDir } from './debug'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, watch, existsSync, unlinkSync, mkdirSync, type FSWatcher } from 'node:fs'
import { activityBus } from './activityBus'
import { McpManager, normalizeName } from './mcpServer'
import {
  defaultMatchingPrefs,
  matchConventionsConnectBlurb
} from './matchConventions'
import { loadDescriptor, DESCRIPTOR_FILENAME } from './descriptor'
import { detectRepo, writeDescriptor, looksLikeRepo } from './generate'
import { registerAll, cliCommand } from './connect'
import { runTool } from './runTool'
import { preflight } from './preflight'
import { readAtlas } from './atlas'
import { readFunctionHistory } from './attemptHistory'
import { githubCredits } from './github'
import { fetchColors, openColorPr, viewerLogin } from './contributorColors'
import { startDeviceFlow, pollForToken } from './githubAuth'
import { encryptionAvailable, listSecrets, setSecret, deleteSecret, secretsEnv } from './secrets'
import { aiStats, outputIsMatch, matchDivergence } from './aiStats'
import { record as report, setReportsEnabled, reportsDir } from './reports'
import { ensureTips, readTips, openTips } from './tips'
import { ensureTour, readTour, openTour } from './tour'
import {
  isGitRepo, ensureWorkBranch, statusMap, changedSince, diffForFile, commitFiles,
  mergeWorkBranch, discardWorkBranch, WORK_BRANCH,
  remoteSlug, defaultBranch, currentBranch,
  pushSubsetToBranch, changedSrcFiles,
  isDirty, aheadBehind, unmergedAhead, fetchRemote, rebasePull, gitUserName,
  recentlyAddedSrc, fetchBase, upstreamState, upstreamIsNonmatching, newSrcVsBase,
  syncPreview, backupBeforeSync, syncToOrigin
} from './gitsafe'
import { ensurePullRequest, resolvePushTarget, type PushTarget } from './pullRequests'
import { writeBugReport } from './bugReport'
import { initAutoUpdate, checkForAppUpdate, quitAndInstallUpdate } from './updater'
import { release as osRelease } from 'node:os'
import type {
  TangosDescriptor, TangosRuntime, TangosTool, RepoState, McpState, Batch, BatchDraft, BatchItem,
  Review, RunResult, AtlasDb, AtlasSource, SecretsInfo, AiAgent, ConnectedClient, RepoUpdateStatus,
  SyncPreview, ViewerPrefs, BackgroundPrefs, MatchingPrefs
} from '../shared/types'

const DEFAULT_PORT = 4808

interface AppState {
  repoPath: string | null
  descriptor: TangosDescriptor | null
  descriptorPath: string | null
  validationErrors: string[]
  allowMutations: boolean
  enabledToolIds: string[]
  batches: Batch[]
  safeMode: boolean
  baseBranch: string | null
  reviews: Review[]
  reportsEnabled: boolean
  tourSeen: boolean
  updateNoteSeen: string // id of the last "Tango says" update note the user has read
  useAgents: boolean // run drivers with parallel workers (and allow concurrent drives)
  agentFanout: number // functions per sub-agent an MCP AI spawns in agents mode (batch/this = agent count)
  autoLand: boolean // after a drive, bank + verify (crackloop land) the matches into the repo
  autoPushEnabled: boolean // the "Push" toggle: with Writes + Review also on, auto-push matched work as a rolling PR
}

const state: AppState = {
  repoPath: null,
  descriptor: null,
  descriptorPath: null,
  validationErrors: [],
  allowMutations: true,
  enabledToolIds: [],
  batches: [],
  safeMode: true,
  baseBranch: null,
  reviews: [],
  reportsEnabled: false,
  tourSeen: false,
  updateNoteSeen: '',
  useAgents: false,
  agentFanout: 8,
  autoLand: true,
  autoPushEnabled: false
}

// AIs set to run continuously (the "infinite" batch size): when their batch finishes we
// generate + assign (and, for API AIs, drive) the next one.
const agentLoop = new Set<string>()
// Kill switches for in-flight API drivers, keyed by agent name, so the red Stop button can
// end a drive early. Whatever the driver already landed is kept (matches are recorded live).
const driveKills = new Map<string, () => void>()

// Full enriched worklist rows (disasm/callees/pool/...) coddog produced during genDraft, keyed by
// function name. driveBatch writes THESE as the driver's worklist so its context tool (abrow.py)
// gets real disassembly; a minimal row makes the driver fly blind (KeyError: 'disasm') and match
// nothing. Targets without a preserved row (e.g. a custom Atlas batch) are enriched on demand via
// `worklist --addr`. Cleared on repo change.
const enrichedRows = new Map<string, string>()

// Batch generation is serialized: the scheduler ranks the whole corpus and is CPU/RAM heavy,
// so running two at once (e.g. clicking Recommended on a second AI mid-generation, on top of a
// live scan) thrashes the machine and can make one scheduler die before it writes its worklist.
// Each generation waits for the previous to finish; the second also then sees the first's batch
// in the "taken" set, so two agents never get the same targets.
let genChain: Promise<unknown> = Promise.resolve()
function serializeGen<T>(fn: () => Promise<T>): Promise<T> {
  const run = genChain.then(fn, fn) // run after the previous settles (success OR failure)
  genChain = run.catch(() => {}) // a failed generation must not wedge the queue
  return run
}
// The in-flight batch generation (one at a time - see serializeGen): its kill switch, a cancel
// flag, and the scheduler's streamed output tail, so the UI's overlay can offer Cancel and a
// peek at what the scheduler is actually doing instead of a black-box spinner.
const genLive = { kill: null as (() => void) | null, cancelled: false, tail: '' }
let genOutTimer: NodeJS.Timeout | null = null // throttles gen:output sends to ~4/s (see genDraft)

// Auto-push: when Writes AND Review are both on, matched work is committed to the work branch,
// pushed to a per-session remote branch, and surfaced as ONE rolling PR (the repo's PR rules /
// CI gate the merge - this never touches the base branch directly). Gated on a real git
// checkout + a GitHub origin remote + a stored GITHUB_TOKEN; otherwise it no-ops with a note.
// YYYYMMDD-hhmm plus per-process entropy: two consoles running the same agent slug, started the
// same minute, otherwise share one remote branch and force-push each other's files out of the PR.
const SESSION_TAG = `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)}-${randomUUID().slice(0, 4)}`
type AutoPushStatus = {
  state: 'idle' | 'pushing' | 'ok' | 'error' | 'skipped'
  message?: string
  prUrl?: string
  at?: number
}
let autoPushStatus: AutoPushStatus = { state: 'idle' } // aggregate (most-recent) for the UI chip

function autoPushActive(): boolean {
  return state.autoPushEnabled && state.allowMutations && state.safeMode
}

// --- Per-agent isolation (per-agent branch + PR, chosen over shared-folder worktrees) ---
// Every AI's matched work lands on its OWN branch (tangos/<slug>-<session>) as one rolling PR,
// even though the AIs share a single checkout. Files are attributed to whichever agent's match
// first made them dirty; the shared tree and checked-out branch are never disturbed (the push
// goes through a throwaway index - see pushSubsetToBranch).
const autoPushTimers = new Map<string, ReturnType<typeof setTimeout>>()
const autoPushBusy = new Set<string>()
const claimedFiles = new Map<string, string>() // src path -> owning agent slug (first matcher wins)
const pendingByAgent = new Map<string, Set<string>>() // agent slug -> cumulative src files for its PR
let baselineDirtySrc = new Set<string>() // src already dirty before the session started (never attributed)
// src path -> file content AT VERIFY TIME. The push fires >=20s after the match and ships the
// working tree's CURRENT bytes - but refine loops keep rewriting candidate files, so without this
// snapshot a later WORSE attempt ships under a "matched" flag (the 18-of-19-near-miss PR bug).
// At flush, a file whose bytes no longer equal its verified snapshot is HELD BACK until a
// re-verify refreshes the snapshot - never pushed on the strength of a stale MATCH.
const verifiedContent = new Map<string, string>()

/** Snapshot a just-verified src file's bytes so the debounced push ships what was verified. */
function snapshotVerified(repoPath: string, relPath: string): void {
  try {
    verifiedContent.set(relPath, readFileSync(join(repoPath, relPath), 'utf8'))
  } catch {
    /* file vanished between verify and snapshot; the flush's existence check handles it */
  }
}

// Where this contributor's branches get pushed: straight to the base repo when the signed-in token
// has push access, otherwise their own fork (opened on demand). Resolving hits the GitHub API, so
// cache it per repo+base+token - the token suffix in the key re-resolves after a re-sign-in.
let pushTargetCache: { key: string; target: PushTarget } | null = null
async function getPushTarget(base: { owner: string; repo: string }, token: string): Promise<PushTarget> {
  const key = `${state.repoPath}::${base.owner}/${base.repo}::${token.slice(-8)}`
  if (pushTargetCache?.key === key && pushTargetCache.target.ok) return pushTargetCache.target
  const target = await resolvePushTarget(base, token)
  if (target.ok) pushTargetCache = { key, target }
  return target
}

/** Branch-safe identity for an AI: lowercase, alnum+dash. Kept per-model (opus != sonnet) so each
 *  gets its own branch, unlike the family-folding used for stats. */
function agentSlug(name?: string): string {
  const s = (name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'agent'
}

/** Attribute the src file(s) for the functions VERIFIED matched this run to this agent, and debounce
 *  a push of just that agent's cumulative work to its own branch/PR.
 *
 *  `matchedFuncs` MUST be the functions that actually byte-matched (the driver's landed set, or the
 *  MCP `match` tool's target). We deliberately do NOT sweep all of `changedSrcFiles`: the working
 *  tree accumulates near-miss .c files (the refine pool) and other ambient untracked sources, and
 *  blindly grabbing them is what pushed 68 non-matching files into a "matched functions" PR. Each
 *  matched function is mapped to whichever of src/<name>.c|.cpp actually changed - nothing else. */
async function noteMatchAndPush(
  agentName: string | undefined,
  matchedFuncs: Iterable<string>
): Promise<void> {
  if (!autoPushActive() || !state.repoPath) return
  const slug = agentSlug(agentName)
  const mine = pendingByAgent.get(slug) ?? new Set<string>()
  try {
    const changed = new Set(await changedSrcFiles(state.repoPath))
    for (const func of matchedFuncs) {
      if (!func) continue
      for (const cand of [`src/${func}.c`, `src/${func}.cpp`]) {
        if (!changed.has(cand) || baselineDirtySrc.has(cand)) continue // absent, or pre-existing dirt
        const owner = claimedFiles.get(cand)
        if (!owner) {
          claimedFiles.set(cand, slug)
          mine.add(cand)
          snapshotVerified(state.repoPath, cand)
        } else if (owner === slug) {
          mine.add(cand)
          snapshotVerified(state.repoPath, cand) // re-verify refreshes the pushable snapshot
        }
      }
    }
  } catch {
    /* status read failed; fall through with whatever we already have */
  }
  pendingByAgent.set(slug, mine)
  if (mine.size) scheduleAutoPush(slug)
}

/** Debounced per agent: coalesce a burst of one AI's matches into a single push ~20s after its last. */
function scheduleAutoPush(slug: string): void {
  if (!autoPushActive()) return
  const t = autoPushTimers.get(slug)
  if (t) clearTimeout(t)
  autoPushTimers.set(slug, setTimeout(() => void runAutoPush(slug), 20_000))
}

async function runAutoPush(slug: string): Promise<void> {
  const t = autoPushTimers.get(slug)
  if (t) {
    clearTimeout(t)
    autoPushTimers.delete(slug)
  }
  if (autoPushBusy.has(slug)) {
    // A push for this agent is mid-flight (they routinely outlast the 20s debounce). A plain return
    // here silently stranded whatever landed in pendingByAgent during the flight - no timer, no
    // retry, the PR never got the burst's last match. Reschedule instead of dropping.
    scheduleAutoPush(slug)
    return
  }
  if (!autoPushActive() || !state.repoPath) return
  const files = [...(pendingByAgent.get(slug) ?? [])]
  if (!files.length) return
  autoPushBusy.add(slug)
  const set = (s: AutoPushStatus): void => {
    autoPushStatus = { ...s, at: Date.now() }
    pushState()
  }
  try {
    if (!(await isGitRepo(state.repoPath))) return set({ state: 'skipped', message: 'not a git checkout - clone the repo to enable pushing' })
    const gh = await remoteSlug(state.repoPath)
    if (!gh) return set({ state: 'skipped', message: 'no GitHub "origin" remote to push to' })
    const token = secretsEnv().GITHUB_TOKEN || process.env.GITHUB_TOKEN
    if (!token) return set({ state: 'skipped', message: 'no GITHUB_TOKEN - sign into GitHub in Settings' })

    set({ state: 'pushing', message: `${slug}: ${files.length} file(s)` })
    const branch = `tangos/${slug}-${SESSION_TAG}`
    const base = await defaultBranch(state.repoPath)

    // Gate what actually ships. (1) Fetch so origin/<base> is current - a stale base is how PRs
    // re-included files that had already landed upstream. (2) A file already identical upstream
    // (or superseded by someone else's landed version) leaves the pending set for good. (3) A file
    // whose bytes no longer equal its verified-time snapshot is HELD BACK (still pending) until a
    // re-verify refreshes it - refine loops rewrite candidates, and pushing the current bytes on
    // the strength of an old MATCH is how near-misses shipped in "matched" PRs.
    await fetchBase(state.repoPath, base)
    const pending = pendingByAgent.get(slug) ?? new Set<string>()
    const ship: string[] = []
    let landedUpstream = 0
    let heldStale = 0
    for (const f of files) {
      const up = await upstreamState(state.repoPath, base, f)
      // 'identical' = already landed upstream. 'differs' = upstream has its own version, normally
      // superseded - EXCEPT when upstream is still NONMATCHING and ours is a verified match: that's
      // a real upgrade (nonmatching -> byte-exact), so ship it instead of silently dropping the win.
      if (up === 'identical' || (up === 'differs' && !(await upstreamIsNonmatching(state.repoPath, base, f)))) {
        pending.delete(f) // landed, or superseded by a real upstream match - not ours to PR
        verifiedContent.delete(f)
        landedUpstream++
        continue
      }
      let current: string | null = null
      try {
        current = readFileSync(join(state.repoPath, f), 'utf8')
      } catch {
        /* deleted since verify (e.g. a land-gate unbank) - treat as stale */
      }
      const snap = verifiedContent.get(f)
      if (current == null || snap == null || current !== snap) {
        heldStale++ // stays pending; ships when a fresh match re-snapshots it
        continue
      }
      ship.push(f)
    }
    pendingByAgent.set(slug, pending)
    if (!ship.length) {
      const why = [
        landedUpstream ? `${landedUpstream} already upstream` : '',
        heldStale ? `${heldStale} changed since verify (held for re-verify)` : ''
      ].filter(Boolean).join(', ')
      return set({ state: 'skipped', message: `${slug}: nothing to push${why ? ` (${why})` : ''}` })
    }

    // Push to the base repo if allowed, else to this user's fork (created on demand) - so contributors
    // without collaborator access still land their matches as a cross-repo PR instead of 403ing.
    const target = await getPushTarget(gh, token)
    if (!target.ok || !target.slug) {
      return set({ state: 'error', message: `can't push: ${target.error ?? 'no push target'}` })
    }
    // Stamp the pushing build's version into the commit and PR so a bad auto-PR can be traced
    // to "someone on an old Console" at a glance. The commit message is re-stamped on every
    // flush (the branch is a single force-pushed squash), so it always names the build that
    // pushed the current tree - even if the app updates mid-session after the PR opened.
    // Plain version only - a source/dev build stamps the same string as the release, so a "-dev"
    // suffix never shows up in a public PR and reads as "something special".
    const consoleVer = app.getVersion()
    // Ship the VERIFIED snapshot bytes, not the current worktree bytes: a refine loop rewriting a
    // candidate in the seconds between the gate check above and the push could otherwise smuggle
    // unverified bytes into a "matched" PR (the TOCTOU the snapshot gate nearly closed).
    const snapshots = new Map(ship.map((f) => [f, verifiedContent.get(f)!]).filter(([, v]) => v != null) as [string, string][])
    const pushed = await pushSubsetToBranch(
      state.repoPath,
      branch,
      base,
      ship,
      `tangos(${slug}): matched work [tangOS Console v${consoleVer}]`,
      target.slug,
      token,
      { contents: snapshots }
    )
    if (!pushed.ok) {
      return set({ state: 'error', message: `push failed: ${pushed.err.slice(-200)}` })
    }
    const pr = await ensurePullRequest({
      owner: gh.owner,
      repo: gh.repo,
      head: branch,
      base,
      token,
      headOwner: target.headOwner,
      title: `tangos/${slug}: matched functions (${SESSION_TAG})`,
      body: `Automated per-agent PR from tangOS Console${target.isFork ? ` (from fork \`${target.slug.owner}/${target.slug.repo}\`)` : ''} - matched functions from **${slug}** this session. CI validation + your review gate the merge.\n\nPushed from **tangOS Console v${consoleVer}** (each push re-stamps the commit message with the build that made it).`
    })
    if (!pr.ok) return set({ state: 'error', message: `pushed, but PR failed: ${pr.error}`, prUrl: undefined })
    set({ state: 'ok', message: `${slug}: ${pr.created ? 'opened' : 'updated'} PR`, prUrl: pr.url })
    report('autopush', {
      agent: slug, branch, base, files: ship.length, consoleVersion: consoleVer,
      skippedUpstream: landedUpstream, heldStale, prUrl: pr.url, created: pr.created
    })
  } catch (e) {
    set({ state: 'error', message: String((e as Error).message ?? e).slice(-200) })
  } finally {
    autoPushBusy.delete(slug)
  }
}

// ---- Stranded-match sweep ----------------------------------------------------------------------
// Agents sometimes verify a match locally and never land it - the session ends, the PR never opens,
// and the file sits in src/ as baseline dirt no flush will ever touch (it happened twice in two
// days; five verified matches were only found by hand-diffing the tree). On startup / repo load,
// re-verify the dirty src candidates against the ROM. Verified files are claimed under the
// 'recovered' slug and fed to the normal auto-push pipeline; with push off, the status chip says
// what was found instead. The baselineDirtySrc gate is deliberately bypassed for these: stranded
// files ARE baseline dirt, and per-file ROM verification is a stronger junk filter than the gate.
const SWEEP_CAP = 12 // compile runs per sweep - keeps startup cheap even on a messy tree
let sweepTimer: NodeJS.Timeout | null = null
let sweepRunning = false

function scheduleStrandedSweep(delayMs = 20_000): void {
  if (sweepTimer) clearTimeout(sweepTimer)
  sweepTimer = setTimeout(() => {
    sweepTimer = null
    void runStrandedSweep().catch(() => {})
  }, delayMs)
}

async function runStrandedSweep(): Promise<void> {
  if (sweepRunning) return
  const repo = state.repoPath
  const matchTool = state.descriptor?.tools.find((t) => t.id === 'match')
  if (!repo || !matchTool || !(await isGitRepo(repo))) return
  sweepRunning = true
  try {
    const dirty = (await changedSrcFiles(repo)).filter((f) => /^src\/[^/]+\.(c|cpp)$/.test(f))
    if (!dirty.length) return
    const base = await defaultBranch(repo)
    await fetchBase(repo, base)
    // Candidates: new files, or local rewrites of an upstream NONMATCHING (a possible upgrade).
    // 'identical' and differs-vs-a-real-upstream-match are not ours to rescue.
    const candidates: string[] = []
    for (const f of dirty) {
      const up = await upstreamState(repo, base, f)
      if (up === 'identical') continue
      if (up === 'differs' && !(await upstreamIsNonmatching(repo, base, f))) continue
      candidates.push(f)
    }
    if (!candidates.length) return
    // addr/size/module come from the repo's committed chaos-db (name-keyed); no db, no sweep.
    let meta: Map<string, { module?: string; addr?: number; size?: number }>
    try {
      const db = JSON.parse(readFileSync(join(repo, 'chaos-db.json'), 'utf8')) as AtlasDb
      meta = new Map(
        db.functions.map((fn) => [
          fn.name,
          { module: fn.module, addr: typeof fn.addr === 'string' ? parseInt(fn.addr, 16) : fn.addr, size: fn.size }
        ])
      )
    } catch {
      return
    }
    const verified: string[] = []
    let checked = 0
    for (const f of candidates) {
      if (checked >= SWEEP_CAP) {
        report('strandedSweep', { event: 'capped', checked, skipped: candidates.length - checked })
        break
      }
      const func = f.replace(/^src\//, '').replace(/\.(c|cpp)$/, '')
      const m = meta.get(func)
      if (!m?.addr || !m?.size) continue
      checked++
      // Direct runTool (the genDraft pattern): visible in the activity feed, but skips afterRun so
      // sweep verifications never pollute agent stats or batch bookkeeping.
      const res = await runTool({
        tool: matchTool,
        values: {
          c: f,
          func,
          addr: `0x${m.addr.toString(16)}`,
          size: `0x${m.size.toString(16)}`,
          module: m.module,
          brief: true
        },
        runtime: currentRuntime(),
        repoPath: repo,
        source: 'user',
        allowMutations: true, // match is read-only; this just skips the safe-mode wrap
        extraEnv: secretsEnv()
      })
      if (res.status === 'ok' && outputIsMatch(res.output)) verified.push(f)
    }
    if (!verified.length) return
    report('strandedSweep', { event: 'found', files: verified })
    if (autoPushActive()) {
      const mine = pendingByAgent.get('recovered') ?? new Set<string>()
      for (const f of verified) {
        baselineDirtySrc.delete(f) // it's verified work now, not ambient dirt
        if (!claimedFiles.has(f)) claimedFiles.set(f, 'recovered')
        if (claimedFiles.get(f) === 'recovered') {
          mine.add(f)
          snapshotVerified(repo, f)
        }
      }
      pendingByAgent.set('recovered', mine)
      if (mine.size) scheduleAutoPush('recovered')
    } else {
      const names = verified.map((f) => f.replace(/^src\//, '')).join(', ')
      autoPushStatus = {
        state: 'skipped',
        message: `stranded sweep: ${verified.length} verified match${verified.length === 1 ? '' : 'es'} sitting unpushed in src/ (${names}) - turn on Writes + Review + Push to auto-PR, or push them yourself`,
        at: Date.now()
      }
      pushState()
    }
  } finally {
    sweepRunning = false
  }
}

/**
 * Run a tool, wrapping mutating runs in safe-mode git handling when enabled:
 * isolate on the tangos/work branch, commit what changed, and record a review.
 */
async function runToolSafely(
  tool: TangosTool,
  values: Record<string, unknown>,
  source: 'ai' | 'user',
  client?: { name: string; role?: string }
): Promise<RunResult> {
  if (!state.repoPath) throw new Error('no repo selected')
  const runtime = currentRuntime()
  const base = {
    tool,
    values,
    runtime,
    repoPath: state.repoPath,
    source,
    client,
    allowMutations: state.allowMutations,
    extraEnv: secretsEnv()
  }
  const mutating = !tool.readOnly
  let res: RunResult
  if (!mutating || !state.safeMode || !(await isGitRepo(state.repoPath))) {
    res = await runTool(base) // read-only, or write with safe-mode off / no git -> run directly
  } else {
    res = await runSafeMode(base)
  }
  afterRun(tool, values, client, res)
  return res
}

// Safe-mode mutating runs are SERIALIZED: two overlapping runs each snapshot before/after status,
// so the first to finish commits the other's half-written files under its own review label, and the
// second run's review then misses its own files (already committed). Real whenever two agents run
// mutating tools at once. Read-only runs are untouched - they never enter this chain.
let safeModeChain: Promise<unknown> = Promise.resolve()
function runSafeMode(base: Parameters<typeof runTool>[0]): Promise<RunResult> {
  const next = safeModeChain.then(() => runSafeModeInner(base))
  safeModeChain = next.catch(() => {}) // a failed run must not wedge the chain
  return next
}

/** Mutating run under safe mode: isolate on the work branch, commit what changed, record a review. */
async function runSafeModeInner(base: Parameters<typeof runTool>[0]): Promise<RunResult> {
  const tool = base.tool
  try {
    const { base: from } = await ensureWorkBranch(state.repoPath!)
    if (from !== WORK_BRANCH) state.baseBranch = from
  } catch {
    return runTool(base) // couldn't isolate (e.g. dirty conflict) -> run normally
  }
  const before = await statusMap(state.repoPath!)
  const res = await runTool(base)
  const after = await statusMap(state.repoPath!)
  const changed = changedSince(before, after)
  if (changed.length) {
    try {
      const files = []
      for (const f of changed) files.push({ path: f.path, status: f.status, diff: await diffForFile(state.repoPath!, f) })
      await commitFiles(state.repoPath!, changed, `tangos: ${tool.id}`)
      state.reviews.push({
        id: randomUUID(),
        toolId: tool.id,
        label: tool.label || tool.id,
        createdAt: Date.now(),
        base: state.baseBranch || 'main',
        files
      })
      pushState()
    } catch {
      /* commit failed; leave changes in place uncommitted */
    }
  }
  return res
}

function parseHexish(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseInt(v, v.trim().toLowerCase().startsWith('0x') ? 16 : 10)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

/** Post-run bookkeeping: derive per-AI match stats + mark batch items done from `match` runs. */
function afterRun(
  tool: TangosTool,
  values: Record<string, unknown>,
  client: { name: string; role?: string } | undefined,
  res: RunResult
): void {
  report('run', {
    agent: client?.name ?? 'user',
    tool: tool.id,
    status: res.status,
    exitCode: res.exitCode,
    args: values,
    outputTail: (res.output || '').slice(-4000)
  })
  if (tool.id !== 'match') return
  const ok = res.status === 'ok' && outputIsMatch(res.output)
  const func = typeof values.func === 'string' ? values.func : undefined
  aiStats.recordMatch(client?.name, ok, parseHexish(values.size), func)
  if (!ok) {
    // A non-match that compiled to a small real byte-diff is a near miss - but counted only when it
    // IMPROVES the function's best divergence so far (the gate lives inside recordNearMiss).
    aiStats.recordNearMiss(client?.name, func, matchDivergence(res.output), parseHexish(values.size))
  }
  // Any match attempt (hit or miss) marks the target WORKED so it leaves the "N in queue" count; a
  // hit additionally marks it done for the % matched bar. A near-miss the agent moves on from still
  // counts as worked - the queue reflects what is left to grind, not just what verified.
  if (func) {
    if (ok) markItemDone(func)
    else markItemWorked(func)
  }
  // A verified match means the agent wrote a matching source; when Writes + Review + Push are on,
  // attribute ONLY this matched function's src to the agent and roll it into its branch/PR (debounced
  // so a burst becomes one push). Gate on the specific func so ambient near-miss files aren't swept.
  if (ok && typeof values.func === 'string') void noteMatchAndPush(client?.name, [values.func])
}

// Keep a looping self-serving (MCP) agent's queue topped up to this many batches, so there's always a
// spare ready the instant it finishes one - it never parks waiting for the scheduler mid-loop. (One
// active + one queued.) Console-driven agents don't need it: their drive loop generates on demand.
const LOOP_QUEUE_DEPTH = 2
// One scheduler run in flight per agent - the heavy coddog runs must never overlap.
const loopReassigning = new Set<string>()
// After a failed generation, don't auto-retry until this timestamp - a permanently-failing scheduler
// (dry pool, broken setup) must NOT spin back-to-back corpus ranks forever. The next natural trigger
// (pull/poll/completion) after the cooldown re-attempts.
const loopGenCooldownUntil = new Map<string, number>()
const LOOP_GEN_COOLDOWN_MS = 2 * 60_000

function openLoopBatches(agentName: string): number {
  return state.batches.filter((b) => b.targetAgent === agentName && b.status !== 'done').length
}

/** Top the agent's queue back up to LOOP_QUEUE_DEPTH, one scheduler run at a time, chaining on
 *  SUCCESS until it's full - so filling from empty, and a pull that frees a slot, both converge.
 *  A failure sets a cooldown instead of chaining (no infinite retry). No-ops for console-driven
 *  agents, a stopped agent, an already-full queue, or a run in flight. */
function ensureLoopQueue(agentName: string): void {
  if (!agentLoop.has(agentName) || isConsoleDrivable(agentName)) return
  if (loopReassigning.has(agentName)) return // a run is already in flight; its finally re-checks depth
  if ((loopGenCooldownUntil.get(agentName) ?? 0) > Date.now()) return // recent failure - back off
  if (openLoopBatches(agentName) >= LOOP_QUEUE_DEPTH) return
  loopReassigning.add(agentName)
  const role = agentRoles[agentName]?.[0]
  let failed = false
  void assignToAgent(agentName, role ?? 'Unassigned', roleBatchSize(role), true)
    .then(() => loopGenCooldownUntil.delete(agentName))
    .catch((e) => {
      failed = true
      loopGenCooldownUntil.set(agentName, Date.now() + LOOP_GEN_COOLDOWN_MS)
      report('batch', { event: 'loop-reassign-failed', agent: agentName, error: String((e as Error)?.message ?? e) })
    })
    .finally(() => {
      loopReassigning.delete(agentName)
      if (!failed) ensureLoopQueue(agentName) // still short (filling 0->2)? make the next
    })
}

/** Continuous mode (looping agents): retire any targeted batch whose items are all worked THROUGH -
 *  matched OR attempted-and-moved-on - and queue the next. Shared by markItemWorked/markItemDone so a
 *  loop advances once the agent has ground through a batch, not only when every target byte-matched. */
function advanceLoopingBatches(): void {
  for (const b of state.batches) {
    if (
      b.targetAgent &&
      b.status !== 'done' &&
      b.items.length &&
      b.items.every((i) => i.done || i.worked) &&
      agentLoop.has(b.targetAgent)
    ) {
      b.status = 'done'
      ensureLoopQueue(b.targetAgent)
    }
  }
}

/** A looping agent polled next_batch with nothing queued for it. If it's sitting on an ACTIVE batch,
 *  it's telling us it's done with that batch even though some targets never got worked - symbol drift,
 *  an unmatchable target, or it simply moved on - which is exactly why advanceLoopingBatches (needs
 *  every item worked) never retired it. Retire the stuck batch and generate the next, so an infinite
 *  agent can never strand itself on a batch it couldn't fully clear. A genuinely dry queue (nothing
 *  active) is left alone here - that path refills on batch completion, not on every empty poll. */
function kickLoopReassign(agentName: string): void {
  if (!agentLoop.has(agentName)) return
  const active = state.batches.find((b) => b.status === 'active' && b.targetAgent === agentName)
  if (!active) return
  // Churn guard: a batch that's young AND untouched isn't "stuck" - the agent just re-polled without
  // working yet (post-summary re-poll, double poll). Retiring it here burned a full scheduler run
  // every ~80s (the worked:0 retire storm in the reports). Top the queue up instead and let the
  // agent's next pull retire the abandoned active naturally.
  const age = Date.now() - (active.activatedAt ?? active.createdAt)
  const worked = active.items.filter((i) => i.worked || i.done).length
  if (worked === 0 && age < 3 * 60_000) {
    ensureLoopQueue(agentName)
    return
  }
  active.status = 'done'
  report('batch', {
    event: 'loop-retire-stuck',
    batchId: active.id,
    agent: agentName,
    worked: active.items.filter((i) => i.worked || i.done).length,
    total: active.items.length
  })
  pushState()
  ensureLoopQueue(agentName)
}

/** Flag a target WORKED (an agent attempted it, hit or miss) across any batch that lists it. Drives
 *  the "N in queue" count down as targets are ground through - distinct from `done` (verified match). */
function markItemWorked(func: string): void {
  let changed = false
  for (const b of state.batches)
    for (const it of b.items)
      if (it.ref === func && !it.worked) {
        it.worked = true
        changed = true
      }
  if (!changed) return
  pushState()
  advanceLoopingBatches()
}

/** Flag a target done across any batch that lists it (drives batch % complete). A matched target
 *  is also `worked`. */
function markItemDone(func: string): void {
  let changed = false
  for (const b of state.batches)
    for (const it of b.items)
      if (it.ref === func && !it.done) {
        it.done = true
        it.worked = true
        changed = true
      }
  if (!changed) return
  pushState()
  advanceLoopingBatches()
}

/** Pull the next queued batch addressed to this agent (or unaddressed): mark it active,
 *  retire this agent's previous active batch, and record it as the agent's current task. */
function pullNextBatch(agentName?: string): Batch | null {
  const mine = (b: Batch): boolean => !b.targetAgent || b.targetAgent === agentName
  const idx = state.batches.findIndex((b) => b.status === 'queued' && mine(b))
  if (idx === -1) return null
  // Retire only THIS agent's previous active batch. An unaddressed batch is pullable by everyone,
  // so retiring every active `mine(b)` here force-closed OTHER agents' in-progress unaddressed
  // batches - their unworked functions then left the taken set and could be re-handed to a second
  // agent while the first was still writing them (the double-grind the taken set exists to stop).
  const pulledByMe = (b: Batch): boolean =>
    agentName != null && (b.targetAgent === agentName || (!b.targetAgent && b.pulledBy === agentName))
  for (const b of state.batches) if (b.status === 'active' && pulledByMe(b)) b.status = 'done'
  const batch = state.batches[idx]
  batch.status = 'active'
  batch.activatedAt = Date.now()
  batch.pulledBy = agentName
  if (agentName) {
    const done = batch.items.filter((i) => i.done).length
    aiStats.setCurrent(agentName, {
      task: batch.title || 'batch',
      batchId: batch.id,
      progress: { done, total: batch.items.length }
    })
    // Pulling one frees a queue slot: refill NOW (while the agent works this batch) so the next is
    // already queued when it finishes - the double-buffer that keeps an infinite loop from stalling.
    ensureLoopQueue(agentName)
  }
  pushState()
  return batch
}

// Long-poll support for next_batch. Returning instantly-empty makes the AGENT own an expensive
// re-poll loop (it burns tokens waking up, re-reading context, deciding "still empty", sleeping).
// Instead the MCP handler awaits here: it resolves the moment a matching batch is enqueued, or
// after a short timeout, so the model parks on one blocking call instead of spinning.
interface BatchWaiter {
  agentName?: string
  resolve: (b: Batch | null) => void
  timer: ReturnType<typeof setTimeout>
}
const batchWaiters = new Set<BatchWaiter>()

/** Called by addBatch: hand the freshly-enqueued work to a parked waiter (first match wins;
 *  pullNextBatch marks it active so no two waiters get the same batch). */
function notifyBatchWaiters(): void {
  for (const w of [...batchWaiters]) {
    const b = pullNextBatch(w.agentName)
    if (!b) continue // not for this waiter (or already taken) - keep it parked
    clearTimeout(w.timer)
    batchWaiters.delete(w)
    w.resolve(b)
  }
}

/** Resolve immediately if work is queued, else block up to timeoutMs for an enqueue (then null). */
function waitForBatch(agentName: string | undefined, timeoutMs: number): Promise<Batch | null> {
  const now = pullNextBatch(agentName)
  if (now) return Promise.resolve(now)
  // Nothing queued, but if this is a looping agent sitting on a batch it's evidently finished with
  // (it's asking for more), retire that batch and generate the next. Without this the loop stalls
  // whenever the agent leaves targets unworked (symbol drift) so "every item worked" never trips.
  if (agentName) kickLoopReassign(agentName)
  return new Promise((resolve) => {
    const w: BatchWaiter = {
      agentName,
      resolve,
      timer: setTimeout(() => {
        batchWaiters.delete(w)
        resolve(null)
      }, timeoutMs)
    }
    batchWaiters.add(w)
  })
}

function currentRuntime(): TangosRuntime {
  return state.descriptor?.runtime ?? { cwd: '.', python: 'python', shell: false }
}

// Remember the last-opened repo + each agent's assigned role + reasoning effort across sessions.
let agentRoles: Record<string, string[]> = {}
let agentEfforts: Record<string, string> = {}
// Chaos Viewer prefs (theme + contributor colors); unknown theme ids are sanitized renderer-side.
let viewerPrefs: ViewerPrefs = { theme: 'classic', contributorColors: false }
// Animated gradient-background pref (on by default); the palette follows the active theme.
let bgPrefs: BackgroundPrefs = { enabled: true }
// Your confirmed contributor color: overlays your own legend entry immediately (and across
// restarts) while the color PR waits to merge, so the pick never visually reverts.
let myContributorColor: string | null = null
// Draft-source toggles for agents (near-miss tips / Ghidra scaffolds). Policy only — never paste C.
let matchingPrefs: MatchingPrefs = { allowNearMiss: true, allowGhidra: false }
function settingsFile(): string {
  return join(app.getPath('userData'), 'tangos-settings.json')
}
function saveSettings(): void {
  try {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        lastRepo: state.repoPath,
        agentRoles,
        agentEfforts,
        agentStats: aiStats.serialize(),
        agentBestDiv: aiStats.serializeBestDiv(),
        reportsEnabled: state.reportsEnabled,
        tourSeen: state.tourSeen,
        updateNoteSeen: state.updateNoteSeen,
        useAgents: state.useAgents,
        agentFanout: state.agentFanout,
        autoLand: state.autoLand,
        autoPushEnabled: state.autoPushEnabled,
        viewerPrefs,
        bgPrefs,
        myContributorColor,
        matchingPrefs,
        // Whether the MCP server is on RIGHT NOW = whether the user last left it on. The next
        // launch auto-starts it (update restarts kept killing agents' connection point).
        mcpRunning: !!mcp.url
      })
    )
  } catch {
    /* ignore */
  }
}
function loadSettings(): {
  lastRepo?: string
  agentRoles?: Record<string, string | string[]> // string = legacy single-role format
  agentEfforts?: Record<string, string>
  agentStats?: Record<string, { totalMatches: number; matchAttempts: number }>
  agentBestDiv?: Record<string, number>
  reportsEnabled?: boolean
  tourSeen?: boolean
  updateNoteSeen?: string
  useAgents?: boolean
  agentFanout?: number
  autoLand?: boolean
  autoPushEnabled?: boolean
  viewerPrefs?: Partial<ViewerPrefs>
  bgPrefs?: Partial<BackgroundPrefs>
  myContributorColor?: string | null
  matchingPrefs?: Partial<MatchingPrefs>
  mcpRunning?: boolean
} {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

const mcp = new McpManager(() => ({
  descriptor: state.descriptor!,
  repoPath: state.repoPath!,
  runtime: currentRuntime(),
  allowMutations: state.allowMutations,
  enabledToolIds: state.enabledToolIds,
  matchingPrefs,
  batchApi: { next: pullNextBatch, wait: waitForBatch, list: () => state.batches },
  run: runToolSafely
}))
mcp.onClientsChange = () => pushState()
// Push raw-traffic updates to the UI at most ~once/2s so a client that hits the
// endpoint but never completes the MCP handshake still shows up as "requests seen".
let trafficPush: NodeJS.Timeout | null = null
mcp.onTraffic = () => {
  if (trafficPush) return
  trafficPush = setTimeout(() => {
    trafficPush = null
    pushState()
  }, 2000)
}
mcp.roleForName = (name) => agentRoles[name]
mcp.onRolesAssigned = (name, roles) => {
  if (roles.length) agentRoles[name] = roles
  else delete agentRoles[name]
  saveSettings()
}
// Per-AI stats changed: refresh the UI (debounced ~250ms - during a hot drive, stats tick on every
// streamed target, and every un-debounced push serialized the FULL state over IPC), and persist
// (longer debounce) so lifetime totals survive.
let statsPushTimer: NodeJS.Timeout | null = null
let statsTimer: NodeJS.Timeout | null = null
aiStats.onChange = () => {
  if (!statsPushTimer) {
    statsPushTimer = setTimeout(() => {
      statsPushTimer = null
      pushState()
    }, 250)
  }
  if (statsTimer) return
  statsTimer = setTimeout(() => {
    statsTimer = null
    saveSettings()
  }, 3000)
}

let mainWindow: BrowserWindow | null = null

// Cache the loaded Atlas data so popouts + view-switches reuse it instantly
// instead of re-reading/re-fetching the ~2MB data every time.
let atlasCache: { repo: string | null; local?: AtlasDb | null; live?: AtlasDb | null; liveAt?: number } = { repo: null }

// One shared fetch of the live chaos-db so the Live view AND the batcher's matched-check don't
// hammer raw GitHub into a 429. Passive callers reuse anything within TTL and hit the CDN (no
// cache-bust); a user Live refresh (force) re-fetches fresh but no more than once per throttle
// window; a rate-limit/failure serves the last good copy instead of erroring.
const LIVE_TTL_MS = 60_000
const LIVE_FORCE_THROTTLE_MS = 20_000
async function loadLiveDb(force: boolean): Promise<AtlasDb> {
  const url = state.descriptor?.data?.committedDbUrl
  if (!url) throw new Error('this repo has no committedDbUrl in tangos.json')
  const cached = atlasCache.repo === state.repoPath ? atlasCache.live : undefined
  const age = cached && atlasCache.liveAt ? Date.now() - atlasCache.liveAt : Infinity
  // A user Live refresh re-fetches once past the short throttle window; passive callers reuse for the
  // full TTL. Either way, within the window the in-memory copy is served - no network hit.
  const maxAge = force ? LIVE_FORCE_THROTTLE_MS : LIVE_TTL_MS
  if (cached && age < maxAge) return cached
  // Passive refresh rides the CDN cache (~5 min) to spare the rate limit; force busts it for freshness.
  const target = force ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15000)
  try {
    const r = await fetch(target, { signal: ac.signal })
    if (!r.ok) {
      if (cached) return cached // rate-limited/offline: keep showing the last good copy
      throw new Error(
        r.status === 429
          ? 'GitHub is rate-limiting the live data feed - try Live again in a minute (local data still works).'
          : `live fetch failed: HTTP ${r.status}`
      )
    }
    const db = (await r.json()) as AtlasDb
    atlasCache = { ...atlasCache, repo: state.repoPath, live: db, liveAt: Date.now() }
    aiStats.seedBestDiv(db.functions) // ground-truth near-miss baseline for the improvement gate
    return db
  } catch (e) {
    if (cached) return cached
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function repoState(): RepoState {
  return {
    path: state.repoPath,
    descriptor: state.descriptor,
    descriptorPath: state.descriptorPath,
    hasDescriptor: !!state.descriptor,
    validationErrors: state.validationErrors,
    // A ".git" entry (dir or file) means a real checkout. A "Download ZIP" snapshot has none:
    // it can't commit/push and its tooling is likely stale - the renderer warns on this.
    isGit: !!state.repoPath && existsSync(join(state.repoPath, '.git'))
  }
}

function mcpState(): McpState {
  return {
    running: mcp.running,
    port: mcp.port,
    url: mcp.url,
    connectedClients: mcp.connectedClients,
    requestsSeen: mcp.requestsSeen,
    lastContactAt: mcp.lastContactAt
  }
}

/** A copyable onboarding prompt the human hands to an AI agent so it knows what tangOS is
 *  and how to connect + start working. Built live from the loaded repo + the server URL. */
function agentPrompt(): string {
  const url = mcp.url ?? `http://127.0.0.1:${DEFAULT_PORT}/mcp`
  const proj = state.descriptor?.project
  const title = proj?.title || proj?.name || 'this decompilation project'
  const enabled = new Set(state.enabledToolIds)
  const toolIds = (state.descriptor?.tools ?? []).filter((t) => enabled.has(t.id)).map((t) => t.id)
  const shown = toolIds.slice(0, 12).join(', ') + (toolIds.length > 12 ? `, +${toolIds.length - 12} more` : '')
  const lines: (string | null)[] = [
    `You are connecting to tangOS Console - a local bridge that exposes the ${title} toolchain to you as MCP tools, with a live viewer the human is watching in real time.`,
    proj?.tagline ? `Project: ${proj.tagline}` : null,
    '',
    'CONNECT - the endpoint is the same for everyone; only the way you register it differs by client. Add it as a Streamable HTTP MCP server:',
    `  URL (Streamable HTTP):  ${url}`,
    `  - Claude Code:                       ${cliCommand(url)}`,
    `  - Cursor / Cline / Windsurf / Roo:   add to your mcp.json -> "mcpServers": { "tangos": { "url": "${url}" } }`,
    `  - Claude Desktop:                    "tangos": { "command": "npx", "args": ["-y", "mcp-remote", "${url}"] }`,
    '  - No native MCP (a browser chatbot like grok.com / chatgpt.com, or any client that cannot reach a local HTTP MCP): you CANNOT connect directly. Have the human run your calls, or from the tangOS console dir run:',
    '        npx tsx scripts/mcp-run.mts <calls.json> <your-name>',
    '      where calls.json is e.g. [{"tool":"next_batch","args":{}}] - pass your name (grok, glm, ...) so the live viewer tags your runs.',
    '  VERIFY you actually connected: call list_tools (or next_batch) and confirm a real tool result comes back. If nothing round-trips, you are NOT connected - do not report "connected" without a tool response, and check that the console shows your session under Connected agents.',
    '',
    'THEN:',
    '  1. Your first and ONLY action is to call next_batch. It BLOCKS server-side until a batch is ready (or ~45s) - so you do NOT wait, sleep, or heartbeat yourself; just call it and it parks until there is work. If it ever returns empty (a timeout), your entire next response is a single next_batch call to keep parking, nothing else. While idle do NOTHING else - no other tools, no reading files or notes, no "setting up" or picking your own targets. Self-assigning work on an empty queue is the #1 way to waste tokens here; do not do it.',
    `  2. ONLY once next_batch hands you a real batch do you start using tools. It gives your role (if any), each target WITH a ready-to-run match call, this repo's KNOWN WALLS, and how to work them. Then drive the toolchain: ${shown}.`,
    '  3. Respect required args: each tool lists its REQUIRED args (see list_tools or tangos.json tools[]) - e.g. match needs c, func, addr, size. Use the ready call next_batch gives you; never omit `c`.',
    '  4. On any tool error (-32602 / compile fail): read that tool\'s args in tangos.json, fix the call, and RETRY. Never end your turn on the first failed call.',
    '  5. Every call streams into the human\'s live viewer tagged with your name - skip the narration and just work. If you hit a known wall, say so plainly and move on rather than grinding.',
    '  6. Stay in your lane: edit source only for your assigned targets, and if an edit makes a function worse, revert it - never leave a tracked file regressed. Keep scratch files, notes, and reports in a temp dir, not in the repo or next to source.',
    state.useAgents
      ? `  7. Agents mode is ON: if you fan out into sub-agents, put ~${state.agentFanout} functions in EACH (e.g. a 16-function batch -> about ${Math.max(1, Math.round(16 / state.agentFanout))} sub-agents). NEVER spawn one sub-agent per function - that multiplies token cost for no gain.`
      : '  7. Work your whole batch yourself in one context. Do NOT spawn one sub-agent per function - it wastes tokens.',
    proj?.readFirst ? `\nREAD FIRST: ${proj.readFirst}` : null,
    matchConventionsConnectBlurb(proj)
  ]
  return lines.filter((l) => l !== null).join('\n').trim()
}

// Stored API keys that surface a provider as an AI in the controller, mapped to its name.
// Claude (Opus/Fable/Sonnet) + GLM + DeepSeek + Nemotron (local LM Studio) are console-drivable
// (glm_refine driver); the rest appear as available AIs. One key can back several provider boxes:
// the Anthropic key drives three distinct model boxes (Opus, Fable, Sonnet) that run and score
// independently. Nemotron's key is a local nominal one - LM Studio ignores it, so the stored value
// just acts as the provider's on/off switch (a stored key = box appears + is drivable).
const LLM_KEYS: Record<string, string[]> = {
  ANTHROPIC_API_KEY: ['Opus', 'Fable', 'Sonnet'],
  GLM_API_KEY: ['GLM'],
  DEEPSEEK_API_KEY: ['DeepSeek'],
  GROK_API_KEY: ['Grok'],
  // 'GPT', not 'ChatGPT': normalizeName folds gpt/codex/chatgpt MCP clients to 'GPT', and a
  // mismatched provider name split one agent into two boxes with divided roles/efforts/stats.
  OPENAI_API_KEY: ['GPT'],
  NEMOTRON_API_KEY: ['Nemotron']
}
// Providers currently being driven by the console (Phase D populates this).
const apiDriving = new Set<string>()

/** The controller roster: one AiAgent per name, merging live MCP sessions, keyed API
 *  providers, and previously-seen names (whose boxes persist grayed-out). */
function agentsSnapshot(): AiAgent[] {
  const byName = new Map<string, AiAgent>()
  // Last MCP request time per agent name (any tool call OR next_batch poll), remembered across
  // disconnect. Drives the presence dot's green -> yellow -> red decay in the controller.
  const active = mcp.activityByName()

  // 1. live MCP clients, collapsed by name (a reconnecting agent is one box).
  const grouped = new Map<string, ConnectedClient[]>()
  for (const c of mcp.getClients()) {
    const arr = grouped.get(c.name)
    if (arr) arr.push(c)
    else grouped.set(c.name, [c])
  }
  for (const [name, list] of grouped) {
    byName.set(name, {
      name,
      kind: 'mcp',
      roles: list.find((c) => c.roles.length)?.roles ?? agentRoles[name] ?? [],
      effort: agentEfforts[name],
      connected: true,
      sessions: list.length,
      currentBatchId: aiStats.currentBatchId(name),
      lastSeen: active.get(name),
      stats: aiStats.statsFor(name),
      run: aiStats.runStatsFor(name)
    })
  }

  // 2. keyed API providers (drivable). One key can back several boxes (Anthropic -> Opus/Fable/
  //    Sonnet). If already live via MCP, just tag the provider.
  for (const s of listSecrets()) {
    for (const provider of LLM_KEYS[s.name] ?? []) {
    const existing = byName.get(provider)
    if (existing) {
      existing.provider = provider
      continue
    }
    byName.set(provider, {
      name: provider,
      kind: 'api',
      provider,
      roles: agentRoles[provider] ?? [],
      effort: agentEfforts[provider],
      connected: apiDriving.has(provider),
      currentBatchId: aiStats.currentBatchId(provider),
      stats: aiStats.statsFor(provider),
      run: aiStats.runStatsFor(provider)
    })
    }
  }

  // 3. previously-seen names with lifetime stats but no live session -> a disconnected box whose
  //    dot decays yellow -> red from its last-seen time (below), instead of an instant gray-out.
  for (const name of aiStats.names()) {
    if (byName.has(name)) continue
    byName.set(name, {
      name,
      kind: 'mcp',
      roles: agentRoles[name] ?? [],
      effort: agentEfforts[name],
      connected: false,
      lastSeen: active.get(name),
      stats: aiStats.statsFor(name),
      run: aiStats.runStatsFor(name)
    })
  }

  // 4. recently-active names not covered above (e.g. an agent that connected, did no matches, then
  //    cleanly disconnected). Keep its box visible so it decays yellow -> red rather than vanishing.
  for (const [name, ts] of active) {
    if (byName.has(name)) continue
    byName.set(name, {
      name,
      kind: 'mcp',
      roles: agentRoles[name] ?? [],
      effort: agentEfforts[name],
      connected: false,
      lastSeen: ts,
      stats: aiStats.statsFor(name),
      run: aiStats.runStatsFor(name)
    })
  }

  return [...byName.values()]
}

function fullState() {
  return {
    repo: repoState(),
    mcp: mcpState(),
    allowMutations: state.allowMutations,
    enabledToolIds: state.enabledToolIds,
    batches: state.batches,
    safeMode: state.safeMode,
    baseBranch: state.baseBranch,
    reviews: state.reviews,
    clients: mcp.getClients(),
    agents: agentsSnapshot(),
    reportsEnabled: state.reportsEnabled,
    tourSeen: state.tourSeen,
    updateNoteSeen: state.updateNoteSeen,
    useAgents: state.useAgents,
    agentFanout: state.agentFanout,
    autoLand: state.autoLand,
    autoPush: { enabled: state.autoPushEnabled, on: autoPushActive(), ...autoPushStatus },
    looping: [...agentLoop]
  }
}

function pushState(): void {
  mainWindow?.webContents.send('state', fullState())
}

// ---- descriptor hot-reload -------------------------------------------------
// Re-read tangos.json after an on-disk edit so a connected AI picks up new/changed
// tools without restarting the server. Session work (batches, reviews) is preserved.
let descriptorWatcher: FSWatcher | null = null
let reloadTimer: NodeJS.Timeout | null = null

function reloadDescriptor(reason: 'watch' | 'manual'): RepoState {
  if (!state.repoPath || !looksLikeRepo(state.repoPath)) return repoState()
  const { descriptor, descriptorPath, errors } = loadDescriptor(state.repoPath)
  if (!descriptorPath) return repoState() // file vanished; keep current in-memory descriptor
  state.descriptor = descriptor
  state.descriptorPath = descriptorPath
  state.validationErrors = errors
  // Preserve the user's enable/disable choices; expose brand-new tools as enabled.
  const ids = (descriptor?.tools ?? []).map((t) => t.id)
  const known = new Set(ids)
  const kept = state.enabledToolIds.filter((id) => known.has(id))
  const keptSet = new Set(kept)
  state.enabledToolIds = [...kept, ...ids.filter((id) => !keptSet.has(id))]
  // Connected AIs re-register the changed toolset the next time they reconnect.
  mcp.resetSessions()
  pushState()
  mainWindow?.webContents.send('descriptor:reloaded', { toolCount: ids.length, errors: errors.length, reason })
  return repoState()
}

function watchDescriptor(repoPath: string | null): void {
  if (descriptorWatcher) {
    try {
      descriptorWatcher.close()
    } catch {
      /* ignore */
    }
    descriptorWatcher = null
  }
  if (!repoPath || !looksLikeRepo(repoPath)) return
  try {
    // Watch the repo dir (non-recursive): survives the atomic rename many editors use
    // on save, which a single-file watch would stop seeing.
    descriptorWatcher = watch(repoPath, { persistent: false }, (_evt, filename) => {
      if (filename !== DESCRIPTOR_FILENAME) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => reloadDescriptor('watch'), 250)
    })
  } catch {
    /* fs.watch unsupported on this path; the manual Reload button still works */
  }
}

function setRepo(path: string | null): RepoState {
  state.repoPath = path
  if (path && looksLikeRepo(path)) {
    const { descriptor, descriptorPath, errors } = loadDescriptor(path)
    // Only treat as loaded if the file actually existed (errors from "missing file" -> no descriptor).
    if (descriptorPath) {
      state.descriptor = descriptor
      state.descriptorPath = descriptorPath
      state.validationErrors = errors
    } else {
      state.descriptor = null
      state.descriptorPath = null
      state.validationErrors = []
    }
  } else {
    state.descriptor = null
    state.descriptorPath = null
    state.validationErrors = []
  }
  // Default: every tool in the new descriptor is enabled (exposed to the AI).
  state.enabledToolIds = state.descriptor ? state.descriptor.tools.map((t) => t.id) : []
  // Seed Ghidra toggle from the repo's matchConventions when opening a repo (near-miss stays as user left it).
  if (state.descriptor) {
    const d = defaultMatchingPrefs(state.descriptor.project)
    matchingPrefs = { ...matchingPrefs, allowGhidra: d.allowGhidra }
  }
  // Batches + pending reviews are repo-specific; reset for the new repo.
  state.batches = []
  state.reviews = []
  state.baseBranch = null
  enrichedRows.clear() // preserved coddog context belongs to the old repo
  atlasCache = { repo: state.repoPath }
  // Auto-push session state is repo-relative: a 20s timer pending across a repo switch would fire
  // runAutoPush against the NEW repoPath using files claimed in the OLD repo (a same-named
  // src/<func>.c in both repos could ship into the wrong repo's PR under an old claim).
  for (const t of autoPushTimers.values()) clearTimeout(t)
  autoPushTimers.clear()
  claimedFiles.clear()
  pendingByAgent.clear()
  verifiedContent.clear()
  baselineDirtySrc = new Set()
  // Changing the repo invalidates any AI sessions' tool lists.
  mcp.resetSessions()
  // Watch the new repo's tangos.json so on-disk edits hot-reload.
  watchDescriptor(state.repoPath)
  if (state.repoPath) saveSettings()
  // Rescue pass for verified-but-never-pushed matches from dead agent sessions (runs ~20s after
  // load so startup stays snappy; covers app launch AND repo switches since both come through here).
  if (state.repoPath) scheduleStrandedSweep()
  pushState()
  return repoState()
}

// The mascot icon for the taskbar + window (build/icon.png, packed with the app).
function appIcon(): string | undefined {
  const p = join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(p) ? p : undefined
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: 'tangOS',
    icon: appIcon(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('win:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:maximized', false))

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' }) // dev build: DevTools open

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Forward activity events to the renderer live viewer.
activityBus.on('activity', (ev) => {
  mainWindow?.webContents.send('activity', ev)
})

// ---- IPC ------------------------------------------------------------------

ipcMain.handle('app:getState', () => fullState())
ipcMain.handle('activity:snapshot', () => activityBus.snapshot())

ipcMain.handle('repo:preflight', async () => {
  if (!state.descriptor || !state.repoPath) return []
  return preflight(state.repoPath, state.descriptor)
})

ipcMain.handle('atlas:load', () => {
  if (!state.descriptor || !state.repoPath) return null
  if (atlasCache.repo === state.repoPath && atlasCache.local !== undefined) return atlasCache.local
  const db = readAtlas(state.repoPath, state.descriptor)
  atlasCache = { ...atlasCache, repo: state.repoPath, local: db }
  return db
})

ipcMain.handle('github:credits', async () => {
  return githubCredits(state.descriptor?.project?.github ?? '', secretsEnv().GITHUB_TOKEN || process.env.GITHUB_TOKEN)
})

// Shared contributor colors: the repo-committed login->hex map, plus who "you" are (the stored
// token's login) so the legend knows which entry gets the picker. YOUR locally-saved pick overlays
// your own entry so a pending (unmerged) color never visually reverts under a stale shared fetch.
ipcMain.handle('colors:get', async (): Promise<{ colors: Record<string, string>; you: string | null }> => {
  const repo = state.repoPath
  const slug = repo && (await isGitRepo(repo)) ? await remoteSlug(repo) : null
  const branch = slug && repo ? await defaultBranch(repo) : 'main'
  const token = secretsEnv().GITHUB_TOKEN || process.env.GITHUB_TOKEN
  const [colors, you] = await Promise.all([fetchColors(slug, branch, repo), viewerLogin(token)])
  if (you && myContributorColor) colors[you] = myContributorColor
  return { colors, you }
})

// Confirm YOUR color: persist the pick locally (instant + revert-proof for you) and open a one-file
// PR against the repo (only your own key can change; branches auto-delete on merge).
ipcMain.handle('colors:propose', async (_e, color: string): Promise<{ ok: boolean; error?: string; prUrl?: string }> => {
  const repo = state.repoPath
  if (!repo || !(await isGitRepo(repo))) return { ok: false, error: 'not a git checkout' }
  const slug = await remoteSlug(repo)
  if (!slug) return { ok: false, error: 'no GitHub origin remote' }
  const token = secretsEnv().GITHUB_TOKEN || process.env.GITHUB_TOKEN
  if (!token) return { ok: false, error: 'sign into GitHub in Settings first' }
  const branch = await defaultBranch(repo)
  const r = await openColorPr(repo, slug, branch, token, String(color))
  if (!r.ok) return { ok: false, error: r.error }
  myContributorColor = String(color)
  saveSettings()
  return { ok: true, prUrl: r.prUrl }
})

// GitHub device-flow sign-in: return the user code + verification URL to show, open the
// browser, and poll in the background; on approval store the token and notify the UI.
ipcMain.handle('github:signin', async () => {
  const clientId = state.descriptor?.project?.githubClientId
  const dc = await startDeviceFlow(clientId)
  await shell.openExternal(dc.verificationUri).catch(() => {})
  pollForToken(dc, clientId)
    .then((token) => {
      setSecret('GITHUB_TOKEN', token)
      mainWindow?.webContents.send('github:signedin', { ok: true })
      pushState()
    })
    .catch((e: unknown) => {
      mainWindow?.webContents.send('github:signedin', { ok: false, error: String((e as Error).message ?? e) })
    })
  return { userCode: dc.userCode, verificationUri: dc.verificationUri }
})

ipcMain.handle('atlas:current', () => {
  // Whatever's already loaded (live preferred), else local - never fetches. For popouts.
  if (atlasCache.repo === state.repoPath) {
    if (atlasCache.live) return atlasCache.live
    if (atlasCache.local) return atlasCache.local
  }
  if (!state.descriptor || !state.repoPath) return null
  const db = readAtlas(state.repoPath, state.descriptor)
  atlasCache = { ...atlasCache, repo: state.repoPath, local: db }
  return db
})

ipcMain.handle('atlas:loadLive', (_e, force?: boolean) => loadLiveDb(!!force))

// Source lines for the selected function at dive zoom. srcPath (repo-relative) is read
// with a path-traversal guard; unmatched functions fall back to a disasm text field on
// the chaos-db row when the generator provides one. Best-effort: null instead of throwing.
const SOURCE_LINE_CAP = 400
ipcMain.handle(
  'atlas:functionHistory',
  (
    _e,
    req: { functionId?: string; module: string; addr: number; name: string }
  ): import('../shared/types').FunctionHistory | null => {
    if (!state.repoPath || !state.descriptor) return null
    if (!req || typeof req.module !== 'string' || typeof req.name !== 'string') return null
    const addr = typeof req.addr === 'number' ? req.addr : parseInt(String(req.addr), 0)
    if (!Number.isFinite(addr)) return null
    return readFunctionHistory(state.repoPath, state.descriptor, {
      functionId: req.functionId,
      module: req.module,
      addr,
      name: req.name
    })
  }
)

ipcMain.handle('atlas:source', (_e, req: { id: string; srcPath?: string }): AtlasSource | null => {
  const repo = state.repoPath
  if (!repo || !req || typeof req.id !== 'string') return null
  if (typeof req.srcPath === 'string' && req.srcPath) {
    try {
      const root = resolve(repo)
      const p = resolve(root, req.srcPath)
      // win32 paths compare case-insensitively (repo picker casing is not stable)
      const norm = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
      const rel = relative(norm(root), norm(p))
      if (rel && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(p)) {
        const lines = readFileSync(p, 'utf8').split(/\r?\n/)
        return {
          lines: lines.slice(0, SOURCE_LINE_CAP),
          truncated: lines.length > SOURCE_LINE_CAP,
          kind: 'src',
          path: req.srcPath
        }
      }
    } catch {
      /* fall through to the chaos-db row */
    }
  }
  try {
    const db = atlasCache.repo === repo ? atlasCache.live ?? atlasCache.local : null
    const row = db?.functions.find((f) => f.id === req.id) as unknown as Record<string, unknown> | undefined
    const disasm = row && typeof row.disasm === 'string' ? row.disasm : null
    if (disasm) {
      const lines = disasm.split(/\r?\n/)
      return { lines: lines.slice(0, SOURCE_LINE_CAP), truncated: lines.length > SOURCE_LINE_CAP, kind: 'disasm' }
    }
  } catch {
    /* no source available */
  }
  return null
})

ipcMain.handle('viewer:getPrefs', (): ViewerPrefs => viewerPrefs)

ipcMain.handle('viewer:setPrefs', (_e, p: Partial<ViewerPrefs>): ViewerPrefs => {
  viewerPrefs = {
    theme: typeof p?.theme === 'string' ? p.theme : viewerPrefs.theme,
    contributorColors: typeof p?.contributorColors === 'boolean' ? p.contributorColors : viewerPrefs.contributorColors
  }
  saveSettings()
  return viewerPrefs
})

ipcMain.handle('matching:getPrefs', (): MatchingPrefs => matchingPrefs)
ipcMain.handle('matching:setPrefs', (_e, p: Partial<MatchingPrefs>): MatchingPrefs => {
  if (typeof p?.allowNearMiss === 'boolean') matchingPrefs.allowNearMiss = p.allowNearMiss
  if (typeof p?.allowGhidra === 'boolean') matchingPrefs.allowGhidra = p.allowGhidra
  saveSettings()
  // next_batch policy is live via getCtx(); tool list is fixed per MCP session —
  // agent should reconnect (or restart MCP) after flipping Near-miss so nearmiss_* hide/show.
  return matchingPrefs
})

ipcMain.handle('bg:getPrefs', (): BackgroundPrefs => bgPrefs)

ipcMain.handle('bg:setPrefs', (_e, p: Partial<BackgroundPrefs>): BackgroundPrefs => {
  bgPrefs = { enabled: typeof p?.enabled === 'boolean' ? p.enabled : bgPrefs.enabled }
  saveSettings()
  return bgPrefs
})

// Function names matched (src file added to origin/main) within the last `sinceHours` (default 24),
// for the contributors legend's "recent activity" badge. Best-effort: [] when not a git checkout.
ipcMain.handle('atlas:recentAdds', async (_e, sinceHours?: number): Promise<string[]> => {
  const repo = state.repoPath
  if (!repo || !(await isGitRepo(repo))) return []
  try {
    return await recentlyAddedSrc(repo, await defaultBranch(repo), sinceHours ?? 24)
  } catch {
    return []
  }
})

// Regenerate the local Atlas DB (chaos-db.json) from the current repo state and refresh the cache,
// so the Atlas AND the near-miss/refine pool reflect what's actually in src/ now. Best-effort.
async function regenAtlasDb(source: 'user' | 'ai'): Promise<AtlasDb | null> {
  if (!state.repoPath || !state.descriptor?.data?.generate) return null
  const dbRel = state.descriptor.data.dbPath || 'chaos-db.json'
  const tool: TangosTool = {
    id: 'generate_atlas_data',
    label: 'Refresh Atlas data',
    category: 'reporting',
    readOnly: true,
    command: state.descriptor.data.generate
  }
  await runTool({
    tool,
    values: { out: dbRel },
    runtime: currentRuntime(),
    repoPath: state.repoPath,
    source,
    allowMutations: true,
    extraEnv: secretsEnv()
  })
  const db = readAtlas(state.repoPath, state.descriptor)
  atlasCache = { ...atlasCache, repo: state.repoPath, local: db }
  if (db) aiStats.seedBestDiv(db.functions) // keep the near-miss gate's baseline current after a land
  return db
}

// After a drive lands matches, chaos-db.json is stale until regenerated. Debounce a background regen
// so a burst of landed drives (loop mode) coalesces into one refresh instead of one per drive.
let atlasRegenTimer: ReturnType<typeof setTimeout> | null = null
function scheduleAtlasRegen(): void {
  if (atlasRegenTimer) clearTimeout(atlasRegenTimer)
  atlasRegenTimer = setTimeout(() => {
    atlasRegenTimer = null
    regenAtlasDb('ai')
      .then(() => pushState())
      .catch(() => {})
  }, 8000)
}

ipcMain.handle('atlas:generate', async () => {
  if (!state.repoPath || !state.descriptor?.data?.generate) {
    throw new Error('this repo has no data.generate command in tangos.json')
  }
  return regenAtlasDb('user')
})

// A role shapes BOTH what the scheduler picks and the default batch size:
//  - Hard matcher -> large functions (min-size floor), fewer per batch
//  - Drafter      -> similarity-anchored unmatched functions (stage 1: produce drafts)
//  - Refiner      -> the near-miss refine pile (stage 2: drafts -> matches)
//  - Random       -> any unmatched function, uniformly at random
//  - default/none -> plain similarity scheduler (same pool as Drafter)
function genPlanFor(role: string | undefined, count: number): { schedId: string; values: Record<string, unknown> } {
  switch (role) {
    case 'Hard matcher':
      // The big/hard functions - min-size floor so coddog only surfaces meaty targets.
      return { schedId: 'coddog', values: { limit: count, min: '0x200' } }
    case 'Drafter':
      // Stage 1: unmatched functions with a similar matched sibling to adapt into a draft. Plain
      // coddog (similarity-anchored) - same pool as the default, framed as draft production.
      return { schedId: 'coddog', values: { limit: count } }
    case 'Refiner':
      // Stage 2: near-misses that already carry a draft. include_attempted so a driven refiner keeps
      // working the pool instead of drying up to ~1 target once refine_wl's ledger has seen it all.
      return { schedId: 'refine_wl', values: { limit: count, include_attempted: true } }
    case 'Random':
      // Pull ANY unmatched function at random - any size, no similarity/easy bias. worklist --random
      // reshuffles every run, so an infinite loop re-rolls a fresh set each batch (see genDraft's loop
      // re-assign). Streams JSONL to stdout (no `out` arg) - genDraft reads that channel below.
      return { schedId: 'worklist', values: { random: true, limit: count } }
    default:
      return { schedId: 'coddog', values: { limit: count } }
  }
}
/** Sensible default batch size per role (Hard matcher is heavy -> fewer targets per batch). */
export const roleBatchSize = (role?: string): number => (role === 'Hard matcher' ? 8 : 16)

// Generate a batch scheduled for this AI's role (similarity, large-function sweep, spread
// survey, or near-miss refine). Each target carries scaffolding metadata for the agent.
// Names of functions already matched in the LIVE committed data (chaos-db on the chaos-data branch).
// coddog judges "matched" from the local src/ tree, which goes stale the moment main gets ahead, so
// a clone that's behind re-hands functions others already merged. Best-effort: returns null when the
// repo has no committedDbUrl or the fetch fails, so batch generation still works offline.
async function liveMatchedNames(): Promise<Set<string> | null> {
  if (!state.descriptor?.data?.committedDbUrl) return null
  // Passive (force=false): reuses the shared TTL cache and the CDN, so generating batch after batch
  // no longer spams the feed toward a 429. Falls back to null offline/on failure.
  try {
    const db = await loadLiveDb(false)
    return new Set(db.functions.filter((f) => f.matched).map((f) => f.name))
  } catch {
    return null
  }
}

async function genDraft(role: string | undefined, count: number): Promise<BatchDraft> {
  if (!state.repoPath || !state.descriptor) throw new Error('no repo loaded')
  // Functions already handed out (in a still-open batch) - never generate these again so
  // two AIs don't grind the same target and repeated Assigns don't return the same list.
  const taken = new Set(
    state.batches.filter((b) => b.status !== 'done').flatMap((b) => b.items.map((i) => i.ref))
  )
  // Over-fetch beyond `count`: sibling-name dupes get dropped below, so without headroom "give me
  // 20" quietly lands short. coddog ranks the whole corpus regardless of limit (it only truncates
  // the result), so a bigger limit is nearly free. Extra headroom when the live-matched cross-check
  // is on: on a clone that's behind main, a chunk of each pull is dropped as already-matched
  // upstream (see the matchedLive filter below), so budget for that drop instead of landing short.
  const liveDropBudget = state.descriptor.data?.committedDbUrl ? count * 2 : 0
  const plan = genPlanFor(role, count + taken.size + Math.max(count, 16) + liveDropBudget)
  // The planned scheduler, falling back to coddog, then any read-only limit+out tool.
  const sched =
    state.descriptor.tools.find((t) => t.id === plan.schedId) ??
    state.descriptor.tools.find((t) => t.id === 'coddog') ??
    state.descriptor.tools.find(
      (t) => t.readOnly && t.args?.some((a) => a.name === 'out') && t.args?.some((a) => a.name === 'limit')
    )
  if (!sched) throw new Error('this repo has no similarity scheduler (coddog) in tangos.json')
  // Most schedulers (coddog/refine_wl) write their worklist JSONL to a temp `out` file; some
  // (worklist, for the Random role) stream it to stdout and take no `out` arg. Detect which so
  // we read the right channel and never hand a tool an `out` flag it would reject.
  const schedWritesFile = sched.args?.some((a) => a.name === 'out') ?? false

  const outPath = join(app.getPath('temp'), `tangos-batch-${randomUUID()}.jsonl`)
  // The scheduler ranks the whole corpus every run (coddog disassembles + scores thousands of
  // functions, then keeps `limit`), so a cold machine can take a minute+. Cap it so a wedged or
  // pathologically slow run surfaces a clear error instead of an app that looks frozen forever.
  let schedKill: (() => void) | null = null
  let timedOut = false
  const SCHED_TIMEOUT_MS = 5 * 60 * 1000
  const timer = setTimeout(() => {
    timedOut = true
    schedKill?.()
  }, SCHED_TIMEOUT_MS)
  genLive.kill = null
  genLive.cancelled = false
  genLive.tail = ''
  mainWindow?.webContents.send('gen:output', '') // reset the overlay's peek from any previous run
  let res: RunResult
  try {
    res = await runTool({
      tool: sched,
      values: schedWritesFile ? { ...plan.values, out: outPath } : plan.values,
      runtime: currentRuntime(),
      source: 'user',
      repoPath: state.repoPath,
      // Batch generation only writes a temp worklist (outPath, in the app temp dir), never repo
      // source, so it must not be gated by the Writes toggle. Some schedulers (refine_wl) are
      // flagged mutating; allow this internal prep run regardless. Actual agent writes stay gated.
      allowMutations: true,
      extraEnv: secretsEnv(),
      onSpawn: ({ kill }) => {
        schedKill = kill
        genLive.kill = kill
      },
      // Stream the scheduler's output to the generating box's overlay ("peek the operational
      // details") so a long corpus rank isn't a black box.
      onOutput: (chunk) => {
        genLive.tail = (genLive.tail + chunk).slice(-4000)
        // Throttle to ~4/s: the scheduler chatters for up to 5 minutes, and every send re-rendered
        // the whole Controller - even with the gen log closed.
        if (!genOutTimer) {
          genOutTimer = setTimeout(() => {
            genOutTimer = null
            mainWindow?.webContents.send('gen:output', genLive.tail)
          }, 250)
        }
      }
    })
  } finally {
    clearTimeout(timer)
    genLive.kill = null
  }
  if (genLive.cancelled) throw new Error('Batch generation cancelled.')
  if (timedOut) {
    throw new Error(
      `the similarity scheduler (${sched.id}) ran longer than 5 minutes and was stopped. ` +
        `It ranks the whole corpus each time; try a smaller batch, a specific module, or check that the repo is set up.`
    )
  }

  let lines: string[] = []
  if (!schedWritesFile) {
    // Stdout scheduler (worklist): the JSONL worklist IS the tool's stdout, not a temp file. Keep
    // only JSON-object lines so any "[tangos] ... ok" header / blank lines are ignored.
    lines = (res.output || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
    if (!lines.length) {
      const tail = (res.output || '').trim().slice(-800) || '(the scheduler produced no output at all)'
      throw new Error(
        `No work for the "${role ?? 'selected'}" role right now - the scheduler surfaced no unmatched functions.\n\n--- scheduler output ---\n${tail}`
      )
    }
  } else try {
    lines = readFileSync(outPath, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    // No worklist file -> the scheduler crashed/exited early. Surface the REAL cause (on a fresh
    // machine this is almost always a setup problem) with a targeted hint, not a generic message.
    const out = (res.output || '').trim()
    const tail = out ? out.slice(-800) : '(the scheduler produced no output at all)'
    // A scheduler that classified its pool and chose nothing is NOT a setup failure - it just has
    // no work for this role right now. Say that plainly instead of pointing at the ROM/deps.
    if (/nothing to (refine|match|do)|chose 0\b|0 refine-routable|no (routable|refinable|eligible|matchable)/i.test(out)) {
      const why =
        sched.id === 'refine_wl'
          ? 'No near-misses are close enough to refine right now - the pool has candidates but none pass the current divergence threshold. Switch this AI to the "Drafter" role for fresh functions, or come back once more near-misses land.'
          : 'The scheduler found no eligible targets for this role right now. Try a different role, size, or module.'
      throw new Error(`No work for the "${role ?? 'selected'}" role right now.\n\n${why}\n\n--- scheduler output ---\n${tail}`)
    }
    let hint: string
    if (/ModuleNotFoundError|No module named|ImportError/i.test(out))
      hint = 'Python packages are missing. In the repo folder run:  pip install -r requirements.txt  (needs capstone, ndspy, pyelftools).'
    else if (/extracted|FileNotFoundError|No such file|\.bin/i.test(out))
      hint = 'The ROM does not look extracted. Run the repo setup (tools/unpack.py on your own legally-dumped ROM) to create the extracted/ folder coddog reads.'
    else if (res.status === 'error' && !out)
      hint = 'Could not run Python at all - check that `python` is installed and on PATH (the repo\'s runtime uses `python`).'
    else hint = 'The scheduler ran but wrote nothing. Check the output below and that the repo is fully set up (deps + extracted ROM).'
    throw new Error(`Batch scheduler (${sched.id}) produced no worklist - exit ${res.exitCode ?? '?'}.\n\n${hint}\n\n--- scheduler output ---\n${tail}`)
  }
  // Cross-check the LIVE matched set so a behind clone doesn't get handed functions already merged on
  // main (the reported "20 of 40 were already done" bug). Best-effort; null = fall back to local view.
  const matchedLive = await liveMatchedNames()
  let droppedMatched = 0
  const items: BatchItem[] = []
  for (const line of lines) {
    if (items.length >= count) break
    try {
      const r = JSON.parse(line) as {
        name: string; module?: string; addr?: string; size?: string; target_hex?: string
        coddog_sim?: number; siblings?: { name: string; sim: number }[]
      }
      if (taken.has(r.name)) continue // already assigned elsewhere, or a same-name sibling above
      if (matchedLive?.has(r.name)) { droppedMatched++; continue } // already matched on main since this clone synced
      const addr = r.addr ? parseInt(r.addr, 16) : undefined
      const size = r.size ? parseInt(r.size, 16) : undefined
      const sib = r.siblings?.[0]
      const sim = Math.round((r.coddog_sim ?? sib?.sim ?? 0) * 100)
      items.push({
        id: `gen-${r.name}`,
        ref: r.name,
        module: r.module,
        addr,
        size,
        targetHex: r.target_hex,
        label: sib ? `${sim}% like ${sib.name}` : undefined
      })
      // Keep coddog's FULL enriched row (disasm/callees/pool) so driveBatch can hand the driver real
      // context instead of a stripped-down row its context tool can't read.
      enrichedRows.set(r.name, line)
      // Sibling thunks (e.g. _ZThn80_*D0Ev) share a mangled name across addresses; one source
      // matches them all, so never put the same name in a batch twice - it just looks like the
      // scheduler handed out the same target repeatedly.
      taken.add(r.name)
    } catch {
      /* skip malformed rows */
    }
  }
  try {
    unlinkSync(outPath)
  } catch {
    /* ignore */
  }
  if (droppedMatched) console.log(`[genDraft] skipped ${droppedMatched} target(s) already matched on main (clone may be behind)`)
  if (!items.length) {
    throw new Error(
      droppedMatched
        ? `Every candidate for this batch is already matched on main (${droppedMatched} skipped) - your clone is behind. Hit Refresh, then generate again.`
        : 'scheduler returned no functions'
    )
  }
  // Batch prompt stays short; MATCH LOGGING / SHARED DEFAULTS are appended by next_batch
  // when project.matchConventions.attemptTree is set (same once-per-batch rule as Chaos Viewer).
  const prompt =
    'Match these targets. Each was picked by opcode similarity to an already-matched sibling ' +
    '(shown per target) - lean on that sibling as scaffolding. Run `match` on each; use `fdiff` on near-misses. ' +
    'Bank near-misses to the near-miss DB when the repo provides one — never park non-reproducing C as a green src/ match.'
  const label = role && role !== 'Unassigned' ? role : 'Similarity'
  // Landed short of what was asked? Say why. A high dropped-as-matched count means the clone is
  // behind main (the fix is to sync, not to grind); otherwise the role's pool is simply drained.
  let note: string | undefined
  if (items.length < count) {
    note =
      droppedMatched > 0
        ? `Got ${items.length} of ${count} - ${droppedMatched} candidate${droppedMatched === 1 ? ' was' : 's were'} already matched on main. Your clone is behind; hit Refresh (or pull) to sync, then generate again.`
        : `Got ${items.length} of ${count} - that's all the unmatched targets this role can find right now.`
  }
  return { title: `${label} batch (${items.length})`, prompt, items, note } satisfies BatchDraft
}

ipcMain.handle('batch:generate', async (_e, arg: number | { count?: number; role?: string } = 16) => {
  const role = typeof arg === 'object' ? arg.role : undefined
  const count = (typeof arg === 'object' ? arg.count : arg) ?? roleBatchSize(role)
  return serializeGen(() => genDraft(role, count)) // share the single-scheduler-at-a-time queue
})

ipcMain.handle('repo:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose a decomp repo folder',
    properties: ['openDirectory']
  })
  if (res.canceled || res.filePaths.length === 0) return repoState()
  return setRepo(res.filePaths[0])
})

ipcMain.handle('repo:set', (_e, path: string) => setRepo(path))

ipcMain.handle('descriptor:generatePreview', (_e, path?: string) => {
  const repo = path || state.repoPath
  if (!repo) throw new Error('no repo selected')
  return detectRepo(repo)
})

ipcMain.handle('descriptor:write', (_e, descriptor: TangosDescriptor) => {
  if (!state.repoPath) throw new Error('no repo selected')
  writeDescriptor(state.repoPath, descriptor)
  return setRepo(state.repoPath)
})

ipcMain.handle('descriptor:reload', () => reloadDescriptor('manual'))

// ---- API-key vault --------------------------------------------------------

function secretsInfo(): SecretsInfo {
  return {
    available: encryptionAvailable(),
    secrets: listSecrets(),
    declared: state.descriptor?.runtime?.envKeys ?? [],
    help: state.descriptor?.runtime?.envKeyHelp ?? {}
  }
}

ipcMain.handle('secrets:info', () => secretsInfo())
ipcMain.handle('secrets:set', (_e, p: { name: string; value: string }) => {
  setSecret(p.name, p.value)
  return secretsInfo()
})
ipcMain.handle('secrets:delete', (_e, name: string) => {
  deleteSecret(name)
  return secretsInfo()
})

async function startMcpServer(): Promise<void> {
  if (!state.descriptor || state.validationErrors.length > 0) {
    throw new Error('cannot start: descriptor missing or invalid')
  }
  // Snapshot src files already dirty before any AI connects; these are never attributed to an
  // agent's per-agent PR (they're pre-existing local work, not this session's matches).
  if (state.repoPath) {
    try {
      baselineDirtySrc = new Set(await changedSrcFiles(state.repoPath))
    } catch {
      baselineDirtySrc = new Set()
    }
  }
  let port = DEFAULT_PORT
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await mcp.start(port)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        port++
        continue
      }
      throw e
    }
  }
  pushState()
}

ipcMain.handle('mcp:start', async () => {
  await startMcpServer()
  saveSettings() // remember the server is ON, so the next launch (e.g. an update restart) resumes it
  return mcpState()
})

ipcMain.handle('mcp:stop', async () => {
  await mcp.stop()
  saveSettings() // user turned it OFF - don't resurrect it next launch
  pushState()
  return mcpState()
})

ipcMain.handle('mcp:connect', () => {
  if (!mcp.url) throw new Error('server not running')
  return { outcomes: registerAll(mcp.url), cli: cliCommand(mcp.url) }
})

ipcMain.handle('mcp:agentPrompt', () => agentPrompt())

ipcMain.handle('policy:setMutations', (_e, allow: boolean) => {
  state.allowMutations = !!allow
  pushState()
  return state.allowMutations
})

function addBatch(draft: BatchDraft, targetAgent?: string): Batch[] {
  const b: Batch = {
    id: randomUUID(),
    title: (draft.title ?? '').trim() || `Batch ${state.batches.length + 1}`,
    prompt: draft.prompt ?? '',
    items: draft.items ?? [],
    status: 'queued',
    createdAt: Date.now(),
    targetAgent: targetAgent || undefined,
    note: draft.note
  }
  state.batches.push(b)
  pruneDoneBatches()
  report('batch', {
    event: 'created',
    batchId: b.id,
    title: b.title,
    targetAgent: b.targetAgent ?? null,
    targets: b.items.length,
    items: b.items.map((i) => i.ref)
  })
  pushState()
  notifyBatchWaiters() // wake any agent long-polling next_batch for this work
  return state.batches
}

// Long-running sessions (infinite loops make a 16-item batch per cycle, forever) used to grow
// state.batches without bound - and the FULL array serializes to the renderer on every pushState,
// while markItemWorked/Done scan all of it per match. Keep a bounded tail of done batches for the
// UI/history and drop the oldest, releasing their preserved coddog rows (enrichedRows holds tens of
// KB of disasm/context per target) unless the same function reappears in a still-open batch.
const DONE_BATCHES_KEPT = 30
function pruneDoneBatches(): void {
  const done = state.batches.filter((b) => b.status === 'done')
  if (done.length <= DONE_BATCHES_KEPT) return
  const drop = new Set(done.slice(0, done.length - DONE_BATCHES_KEPT).map((b) => b.id))
  const dropped = state.batches.filter((b) => drop.has(b.id))
  state.batches = state.batches.filter((b) => !drop.has(b.id))
  const stillOpen = new Set(
    state.batches.filter((b) => b.status !== 'done').flatMap((b) => b.items.map((i) => i.ref))
  )
  for (const b of dropped)
    for (const it of b.items) if (!stillOpen.has(it.ref)) enrichedRows.delete(it.ref)
}

ipcMain.handle('batch:enqueue', (_e, draft: BatchDraft) => addBatch(draft))

// Address a batch to one AI by name: only that agent's next_batch (or console-driven run) gets it.
ipcMain.handle('batch:assign', (_e, payload: { draft: BatchDraft; agentName: string }) =>
  addBatch(payload.draft, payload.agentName)
)

/** Generate a role-aware batch and address it to one AI, setting/clearing its loop flag.
 *  Serialized against other generations so schedulers never run concurrently. */
function assignToAgent(agentName: string, role: string, count: number, loop: boolean): Promise<void> {
  if (loop) agentLoop.add(agentName)
  else agentLoop.delete(agentName)
  return serializeGen(async () => {
    const draft = await genDraft(role && role !== 'Unassigned' ? role : undefined, count)
    addBatch(draft, agentName) // inside the lock, so the next queued generation sees these as taken
  })
}

ipcMain.handle('ai:assign', async (_e, p: { agent: string; role?: string; count: number; loop?: boolean }) => {
  await assignToAgent(p.agent, p.role ?? 'Unassigned', p.count, !!p.loop)
  // Infinite mode replaces the manual Drive button with Stop, so a console-driven agent (GLM/Claude)
  // would otherwise sit on its freshly-queued batch forever - the "GLM on infinite never starts"
  // bug. Kick the drive loop off here. Fire-and-forget: it runs until Stop, so awaiting it would
  // hang this IPC for the whole session. (A live MCP agent self-serves via next_batch - skip it.)
  if (p.loop && isConsoleDrivable(p.agent)) {
    void startDriveLoop(p.agent).catch((e) => {
      report('drive', { agent: p.agent, status: 'error', error: String((e as Error)?.message ?? e) })
      pushState() // the loop cleared agentLoop on error; refresh so the box stops showing as looping
    })
  } else if (p.loop) {
    // MCP loop: pre-generate the spare so the second batch is ready the moment the agent finishes the
    // first, instead of the agent parking on next_batch while the scheduler runs.
    ensureLoopQueue(p.agent)
  }
  return { ok: true }
})
// Stop an AI's continuous loop (it finishes its current batch, then no more are queued).
ipcMain.handle('ai:stop', (_e, agentName: string) => {
  agentLoop.delete(agentName) // stop any continuous loop from re-assigning
  driveStopRequested.add(agentName) // end the queue walk after the current batch is killed below
  driveKills.get(agentName)?.() // kill an in-flight driver early; matches found so far are kept
  // Drop the pre-generated spare(s) too: the loop queue keeps LOOP_QUEUE_DEPTH batches buffered, and
  // without this an MCP agent pulls and works one MORE full batch after Stop - contradicting the
  // handler's own contract. Their functions become assignable again (the taken-set frees up).
  state.batches = state.batches.filter((b) => !(b.targetAgent === agentName && b.status === 'queued'))
  pushState()
  return true
})

// Cancel the in-flight batch generation (the overlay's Cancel button). Kills the scheduler
// process; genDraft then surfaces a calm "cancelled" instead of a scary produced-no-worklist error.
ipcMain.handle('batch:cancelGen', () => {
  genLive.cancelled = true
  genLive.kill?.()
  return true
})

// Empty an agent's queue: drop its QUEUED batches (an actively-driving batch is untouched - Stop
// handles that). The functions inside become assignable again (genDraft's taken-set frees up).
ipcMain.handle('batch:clearQueue', (_e, agentName: string) => {
  state.batches = state.batches.filter((b) => !(b.targetAgent === agentName && b.status === 'queued'))
  pushState()
  return state.batches
})

/** Fetch one target's full enriched worklist row (disasm/callees/pool) via `worklist --addr`, for
 *  batch targets coddog didn't produce (e.g. functions picked in the Atlas). Returns the JSONL row
 *  string, or null if the repo has no worklist tool / the target can't be located. Quiet: spawns
 *  python directly rather than through runTool, so it never clutters the live viewer. */
async function enrichTarget(item: BatchItem): Promise<string | null> {
  const repo = state.repoPath
  if (!repo || item.addr == null || !item.module) return null
  if (!state.descriptor?.tools?.some((t) => t.id === 'worklist')) return null
  const py = currentRuntime().python || 'python'
  const addr = '0x' + item.addr.toString(16).padStart(8, '0')
  const out = await new Promise<string>((resolve) => {
    let buf = ''
    try {
      // --max 0xffffff disables worklist.py's default 0x200 (512-byte) size filter: when we pin the
      // exact function by --addr we want THAT function whatever its size, else every pick over 512
      // bytes is silently dropped ("none of this batch's targets could be enriched").
      const c = spawn(py, ['tools/worklist.py', '--module', item.module!, '--addr', addr, '--max', '0xffffff'], {
        cwd: repo,
        env: { ...process.env, ...secretsEnv() }
      })
      // Hard cap: never let one slow/hung target wedge the whole drive. Kill + skip it after 20s.
      const timer = setTimeout(() => {
        try { c.kill() } catch { /* already gone */ }
        resolve('')
      }, 20000)
      c.stdout?.on('data', (d) => (buf += String(d)))
      c.on('error', () => { clearTimeout(timer); resolve('') })
      c.on('close', () => { clearTimeout(timer); resolve(buf) })
    } catch {
      resolve('')
    }
  })
  // worklist prints one enriched JSON row (when not --pretty). Take the last line that looks like it.
  return (
    out
      .split('\n')
      .map((l) => l.trim())
      .reverse()
      .find((l) => l.startsWith('{') && l.includes('"disasm"')) ?? null
  )
}

// Nemotron runs on a LOCAL LM Studio server (localhost:1234). Ping /v1/models before driving so a
// stopped server surfaces as a plain "start it" message instead of a raw connection error deep
// inside glm_refine - AND return the model id that's actually loaded. The id is not stable: the
// launcher aliases it "nemo" (--identifier nemo), but a GUI/default load reports the full
// "nemotron-3-nano-30b-a3b", so a hardcoded "nemo" 400s half the time. Discover it instead, skipping
// any embedding model LM Studio keeps loaded alongside the chat one. Short timeout - it's localhost.
async function nemotronModelId(): Promise<string> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 2500)
  let ids: string[]
  try {
    const r = await fetch('http://localhost:1234/v1/models', { signal: ac.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const body = (await r.json()) as { data?: { id?: string }[] }
    ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id)
  } catch {
    throw new Error(
      "Nemotron isn't reachable at localhost:1234 - start LM Studio first (run Start-Nemotron.ps1 in C:\\Users\\bmanu\\Documents\\Nemotron-3), then try again."
    )
  } finally {
    clearTimeout(timer)
  }
  const chat = ids.find((id) => !/embed/i.test(id))
  if (!chat)
    throw new Error(
      `LM Studio is up at localhost:1234 but no chat model is loaded${ids.length ? ` (only: ${ids.join(', ')})` : ''} - load Nemotron via Start-Nemotron.ps1, then try again.`
    )
  return chat
}

// Console-drive a keyed API provider on its assigned batch: write a worklist and run the
// model driver (glm_refine, Anthropic-dialect) tagged as that AI, then fold the reported
// landed matches + token usage into its stats.
async function driveBatch(agentName: string): Promise<void> {
  if (!state.repoPath) throw new Error('no repo selected')
  const env = secretsEnv()
  const driverEnv: Record<string, string> = {}
  // Claude models share the Anthropic key but drive different models, each its own box.
  const CLAUDE_MODEL: Record<string, string> = {
    Opus: 'claude-opus-4-8',
    Fable: 'claude-fable-5',
    Sonnet: 'claude-sonnet-5'
  }
  if (agentName === 'GLM') {
    if (!env.GLM_API_KEY) throw new Error('no GLM_API_KEY stored - add it in Settings')
  } else if (CLAUDE_MODEL[agentName]) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('no ANTHROPIC_API_KEY stored - add it in Settings')
    driverEnv.GLM_API_KEY = env.ANTHROPIC_API_KEY // the driver reads GLM_API_KEY; point it at Anthropic
    driverEnv.GLM_BASE_URL = 'https://api.anthropic.com'
    driverEnv.GLM_MODEL = CLAUDE_MODEL[agentName]
  } else if (agentName === 'DeepSeek') {
    if (!env.DEEPSEEK_API_KEY) throw new Error('no DEEPSEEK_API_KEY stored - add it in Settings')
    driverEnv.GLM_API_KEY = env.DEEPSEEK_API_KEY
    driverEnv.GLM_BASE_URL = 'https://api.deepseek.com'
    driverEnv.GLM_DIALECT = 'openai' // DeepSeek is OpenAI /chat/completions, not the Anthropic dialect
    // The effort box picks the model. IMPORTANT: default to reasoner when no choice is stored -
    // the dropdown DISPLAYS "reasoner" (the family default) without ever writing agentEfforts, so
    // requiring === 'reasoner' silently drove deepseek-chat while the UI said reasoner.
    driverEnv.GLM_MODEL = agentEfforts['DeepSeek'] === 'chat' ? 'deepseek-chat' : 'deepseek-reasoner'
  } else if (agentName === 'Nemotron') {
    // Local Nemotron-3 via LM Studio's OpenAI-compatible server on localhost:1234. Same driver path
    // as DeepSeek - OpenAI /chat/completions dialect, answer in `content` (its reasoning goes to
    // reasoning_content, which glm_refine ignores). The local server ignores the key, but glm_refine
    // requires GLM_API_KEY set, so fall back to a nominal value. The health-check doubles as model
    // discovery: it fails fast with a clear message if the server is down and returns the loaded id.
    driverEnv.GLM_MODEL = await nemotronModelId()
    driverEnv.GLM_API_KEY = env.NEMOTRON_API_KEY || 'lm-studio'
    driverEnv.GLM_BASE_URL = 'http://localhost:1234/v1'
    driverEnv.GLM_DIALECT = 'openai'
  } else {
    throw new Error(`${agentName} has no console driver yet (idle-only)`)
  }
  // Reasoning effort chosen on the AI box (falls back to the family default). Claude models map it to
  // the extended-thinking budget; GLM forces it off (thinking starves its code block); DeepSeek picks
  // the model by effort (chat vs reasoner) and the reasoner thinks on its own, so both pass 'off'.
  const effortDefault: Record<string, string> = { Opus: 'high', Fable: 'high', Sonnet: 'high' }
  driverEnv.TANGOS_EFFORT =
    agentName === 'GLM' || agentName === 'DeepSeek' || agentName === 'Nemotron'
      ? 'off'
      : agentEfforts[agentName] ?? effortDefault[agentName] ?? ''
  const batch = state.batches.find((b) => b.targetAgent === agentName && b.status !== 'done')
  if (!batch) throw new Error(`no batch assigned to ${agentName} - assign one first`)
  // Build the driver worklist with FULL context. Prefer coddog's preserved enriched row (from
  // genDraft); for a target without one (a batch hand-picked in the Atlas), enrich on demand via
  // `worklist --addr`. Enrich in parallel (capped) with a live "Preparing N/M" status - 50 picks
  // done sequentially + silently was minutes of a dead-looking "Stop" (the custom-batch "nothing
  // happened" symptom). A target we can neither preserve nor enrich (no addr/module, or timed out)
  // is skipped, not fatal.
  const toEnrich = batch.items.filter((i) => !enrichedRows.has(i.ref))
  let prepared = batch.items.length - toEnrich.length
  const showPrep = (): void => {
    aiStats.setCurrent(agentName, { task: `Preparing targets (${prepared}/${batch.items.length})…`, batchId: batch.id })
    pushState()
  }
  if (toEnrich.length) {
    showPrep()
    let next = 0
    let couldNotEnrich = 0
    const workers = Array.from({ length: Math.min(6, toEnrich.length) }, async () => {
      while (next < toEnrich.length) {
        const item = toEnrich[next++]
        const enriched = await enrichTarget(item)
        if (enriched) enrichedRows.set(item.ref, enriched)
        else couldNotEnrich++
        prepared++
        showPrep()
      }
    })
    await Promise.all(workers)
    if (couldNotEnrich) console.log(`[driveBatch] ${agentName}: ${couldNotEnrich}/${batch.items.length} target(s) had no enrichable context and were skipped`)
  }
  const enriched = batch.items.map((i) => enrichedRows.get(i.ref)).filter((r): r is string => !!r)
  if (!enriched.length)
    throw new Error(
      `none of this batch's ${batch.items.length} target(s) could be enriched with context - pick targets with an addr + module the worklist tool knows, or generate the batch with the Recommended button (coddog)`
    )
  // Ship EVERY enriched row, draft or not. glm_refine handles both: a row with a draft gets the
  // refine prompt, a fresh one gets the explicit "NO DRAFT YET - write the complete source from
  // scratch" prompt (the old filter-and-throw here predates that upgrade and blocked hand-picked
  // targets from being driven at all - a hand-assigned batch should just be attempted, role or not).
  const rows = enriched
  const fresh = rows.filter((line) => {
    try {
      return !(JSON.parse(line) as { draft?: string }).draft?.trim()
    } catch {
      return true
    }
  }).length
  if (fresh) console.log(`[driveBatch] ${agentName}: ${fresh}/${rows.length} fresh target(s) - driver drafts those from scratch`)

  // Stable, discoverable location (not a random temp name) so the run's "open folder" link
  // always resolves to real files. One worklist + output per agent; the next drive overwrites.
  const driveDir = join(app.getPath('temp'), 'tangos-drives')
  mkdirSync(driveDir, { recursive: true })
  const slug = agentName.replace(/[^a-z0-9]/gi, '_')
  const wl = join(driveDir, `${slug}.worklist.jsonl`)
  const outPath = join(driveDir, `${slug}.results.output`)
  writeFileSync(wl, rows.join('\n'))
  const tool: TangosTool = {
    id: 'glm_refine',
    label: `Drive ${agentName}`,
    category: 'matching',
    readOnly: false,
    command: '{python} tools/glm_refine.py --wl {wl} --out {out} --jobs {jobs}'
  }
  // GLM's default endpoint is z.ai's Coding Plan, which is ~single-concurrency: parallel workers
  // just 429 each other into a slow retry grind (function 1 lands, the rest hang). Drive it
  // sequentially. Nemotron is one local LM Studio model on one GPU - parallel requests just queue
  // and multiply latency, so it's serial too. Anthropic (Claude) handles concurrency, so it still
  // gets parallel under "Use agents".
  const jobs = agentName === 'GLM' || agentName === 'Nemotron' ? 1 : state.useAgents ? 3 : 1
  batch.status = 'active'
  apiDriving.add(agentName)
  aiStats.setCurrent(agentName, {
    task: batch.title,
    batchId: batch.id,
    progress: { done: batch.items.filter((i) => i.done).length, total: batch.items.length }
  })
  pushState()
  // Live progress: the driver prints a result-first header per finished target, e.g.
  //   "(3/64) func_ov062_02114f98: MATCH"  or  "(4/64) func_...: div=7"
  // (its per-attempt lines follow, indented). Parse the headers as they stream so the bar
  // climbs the instant a match lands (and a Stop mid-run still leaves every completed target
  // counted). recorded[] avoids double-counting against the final .output reconciliation below.
  const recorded = new Set<string>()
  const DONE_RE = /^\((\d+)\/(\d+)\)\s+(\S+):\s+(MATCH|div=\d+)/
  let lineBuf = ''
  const onOutput = (chunk: string, stream: 'stdout' | 'stderr'): void => {
    if (stream !== 'stdout') return
    lineBuf += chunk
    let nl: number
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl)
      lineBuf = lineBuf.slice(nl + 1)
      const m = DONE_RE.exec(line.trim())
      if (!m) continue
      const name = m[3]
      const ok = m[4] === 'MATCH'
      if (recorded.has(name)) continue
      recorded.add(name)
      const item = batch.items.find((i) => i.ref === name)
      aiStats.recordMatch(agentName, ok, item?.size, name)
      // a "div=N" line: compiled draft, close but not matching - counts only if it beats the best div
      if (!ok) aiStats.recordNearMiss(agentName, name, Number(m[4].replace('div=', '')), item?.size)
      // Every target the driver reaches is WORKED (it advances the analyzed bar) whether it matched,
      // near-missed, or dead-ended; a hit additionally marks it done.
      if (item) {
        item.worked = true
        if (ok) item.done = true
      }
      aiStats.setCurrent(agentName, {
        task: batch.title,
        batchId: batch.id,
        progress: { done: batch.items.filter((i) => i.worked || i.done).length, total: batch.items.length }
      })
      pushState() // climb the bar mid-run
    }
  }
  try {
    const res = await runTool({
      tool,
      values: { wl, out: outPath, jobs },
      runtime: currentRuntime(),
      repoPath: state.repoPath,
      source: 'ai',
      client: { name: agentName },
      allowMutations: true,
      extraEnv: { ...env, ...driverEnv },
      onOutput,
      onSpawn: ({ kill }) => driveKills.set(agentName, kill)
    })
    let landed: string[] = []
    let tin = 0
    let tout = 0
    let rawOut = ''
    try {
      rawOut = readFileSync(outPath, 'utf8')
      const out = JSON.parse(rawOut) as {
        landed?: Array<string | { name?: string }>
        landedNames?: string[]
        matches?: Array<string | { name?: string }>
        results?: Array<{ name?: string; matched?: boolean }>
        tokensIn?: number
        tokensOut?: number
        inputTokens?: number
        outputTokens?: number
        tokensPerLanded?: number
      }
      const landedRaw = out.landedNames ?? out.landed ?? out.matches ?? []
      landed = (landedRaw as Array<string | { name?: string }>)
        .map((x) => (typeof x === 'string' ? x : x?.name))
        .filter((x): x is string => !!x)
      // Reconcile with the stream via the driver's authoritative results[] (every target it
      // reached, matched or not). Anything the live parse missed gets recorded here; targets
      // that never ran (e.g. an early Stop) aren't in results[], so a partial run doesn't
      // tank hit rate with un-attempted functions.
      for (const r of out.results ?? []) {
        if (!r.name || recorded.has(r.name)) continue
        recorded.add(r.name)
        const item = batch.items.find((i) => i.ref === r.name)
        aiStats.recordMatch(agentName, !!r.matched, item?.size, r.name)
        if (item) {
          item.worked = true
          if (r.matched) item.done = true
        }
      }
      tin = out.tokensIn ?? out.inputTokens ?? 0
      tout = out.tokensOut ?? out.outputTokens ?? (out.tokensPerLanded ? out.tokensPerLanded * landed.length : 0)
      if (tin || tout) aiStats.recordTokens(agentName, tin, tout)
    } catch {
      /* no parseable driver output */
    }
    report('drive', {
      agent: agentName,
      batchId: batch.id,
      title: batch.title,
      targets: batch.items.length,
      status: res.status,
      landed: landed.length,
      landedNames: landed,
      tokensIn: tin,
      tokensOut: tout,
      driverOutputTail: (res.output || '').slice(-3000),
      resultFileTail: rawOut.slice(-3000)
    })

    // Land the matches into the repo. The driver only WRITES matching sources to a scratch
    // dir + the results file; without this step they never reach src/, the ledger, or git.
    // `crackloop land` banks the sources, runs the free-tier clone/paramclone post-pass, and
    // linkcheck-gates everything banked. We deliberately stop BEFORE git commit/push - that
    // stays a manual, reviewable step (the console never pushes to the public repo on its own).
    if (state.autoLand && landed.length) {
      const landTool: TangosTool = {
        id: 'crackloop_land',
        label: `Land ${agentName} matches`,
        category: 'matching',
        readOnly: false,
        command: '{python} tools/crackloop.py land --output {out} --wl {wl} --no-claims'
      }
      const landRes = await runTool({
        tool: landTool,
        values: { out: outPath, wl },
        runtime: currentRuntime(),
        repoPath: state.repoPath,
        source: 'ai',
        client: { name: agentName },
        allowMutations: true,
        extraEnv: env
      })
      const wrong = /LINK GATE: (\d+) WRONG/.exec(landRes.output || '')
      report('land', {
        agent: agentName,
        batchId: batch.id,
        landed: landed.length,
        landedNames: landed,
        status: landRes.status,
        wrongBanks: wrong ? Number(wrong[1]) : 0,
        outputTail: (landRes.output || '').slice(-4000)
      })
      await noteMatchAndPush(agentName, landed) // ONLY this driver's landed matches - not ambient near-misses
      scheduleAtlasRegen() // matches are now in src/ - refresh chaos-db so Atlas + near-miss pool track them
    }
  } finally {
    apiDriving.delete(agentName)
    driveKills.delete(agentName)
    aiStats.clearCurrent(agentName)
    batch.status = 'done'
    // Leave wl + outPath on disk so the run's "open folder" link stays useful after it ends;
    // the next drive for this agent overwrites them.
    pushState()
  }
}

// One drive for a console-driven agent - and, while it's in continuous (infinite) mode, generate +
// assign + drive the next, and the next, until Stop. Guarded so an agent only ever has ONE loop:
// driveLoopActive closes the brief between-batch window where apiDriving is momentarily empty, while
// apiDriving still guards the driveBatch level itself (it's added synchronously before driveBatch's
// first await, so a near-simultaneous second start no-ops instead of double-walking the worklist -
// the "two 6/14s" symptom).
const driveLoopActive = new Set<string>()
const driveStopRequested = new Set<string>() // Stop ends the whole queue walk, not just the current batch
async function startDriveLoop(agentName: string): Promise<void> {
  if (driveLoopActive.has(agentName) || apiDriving.has(agentName)) return
  driveLoopActive.add(agentName)
  driveStopRequested.delete(agentName)
  try {
    for (;;) {
      // Queue model: drive works through EVERYTHING queued for this agent, batch after batch.
      // Infinite mode additionally refills the queue when it runs dry; one-shot mode just stops.
      const pending = state.batches.some((b) => b.targetAgent === agentName && b.status !== 'done')
      if (!pending) {
        if (!agentLoop.has(agentName) || driveStopRequested.has(agentName)) break
        const primary = agentRoles[agentName]?.[0]
        await assignToAgent(agentName, primary ?? 'Unassigned', roleBatchSize(primary), true)
      }
      // Re-check AFTER the (minutes-long) generation: a Stop pressed while the scheduler ran used to
      // slip through here and drive the entire fresh batch end-to-end (paid API calls) anyway.
      if (driveStopRequested.has(agentName)) break
      await driveBatch(agentName)
      if (driveStopRequested.has(agentName)) break
    }
  } catch (e) {
    agentLoop.delete(agentName) // stop the loop on any error
    throw e
  } finally {
    driveLoopActive.delete(agentName)
    driveStopRequested.delete(agentName)
  }
}

/** True when the console itself drives this agent: a keyed API provider (GLM/Claude) that isn't
 *  currently a live MCP session. An MCP agent self-serves work via next_batch and needs no driver. */
function isConsoleDrivable(name: string): boolean {
  if (mcp.getClients().some((c) => c.name === name)) return false
  return listSecrets().some((s) => (LLM_KEYS[s.name] ?? []).includes(name))
}

ipcMain.handle('ai:drive', async (_e, agentName: string) => {
  await startDriveLoop(agentName)
  return { ok: true }
})

ipcMain.handle('batch:remove', (_e, id: string) => {
  state.batches = state.batches.filter((b) => b.id !== id)
  pushState()
  return state.batches
})

ipcMain.handle('batch:reorder', (_e, payload: { id: string; dir: 'up' | 'down' }) => {
  const i = state.batches.findIndex((b) => b.id === payload.id)
  if (i < 0) return state.batches
  const j = payload.dir === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= state.batches.length) return state.batches
  const [x] = state.batches.splice(i, 1)
  state.batches.splice(j, 0, x)
  pushState()
  return state.batches
})

ipcMain.handle('batch:clearDone', () => {
  state.batches = state.batches.filter((b) => b.status !== 'done')
  pushState()
  return state.batches
})

ipcMain.handle('policy:setEnabledTools', (_e, ids: string[]) => {
  const valid = new Set((state.descriptor?.tools ?? []).map((t) => t.id))
  state.enabledToolIds = (ids ?? []).filter((id) => valid.has(id))
  // Re-expose the changed toolset to any AI that reconnects.
  mcp.resetSessions()
  pushState()
  return state.enabledToolIds
})

ipcMain.handle('tool:run', async (_e, payload: { toolId: string; values: Record<string, unknown> }) => {
  if (!state.descriptor || !state.repoPath) throw new Error('no repo/descriptor')
  const tool = state.descriptor.tools.find((t) => t.id === payload.toolId)
  if (!tool) throw new Error(`unknown tool: ${payload.toolId}`)
  return runToolSafely(tool, payload.values ?? {}, 'user')
})

// Assign roles by AI name (works for live MCP sessions, keyed API providers, and
// offline-but-seen agents alike). Applies to any live sessions and persists by name.
// An AI can hold several roles at once (e.g. main matcher + verifier).
ipcMain.handle('clients:setRoles', (_e, p: { name: string; roles: string[] }) => {
  const roles = (p.roles ?? []).filter((r) => r && r !== 'Unassigned')
  const live = mcp.getClients().find((c) => c.name === p.name)
  if (live) {
    mcp.setRoles(live.id, roles) // applies to all same-name sessions + persists via onRolesAssigned
  } else {
    if (roles.length) agentRoles[p.name] = roles
    else delete agentRoles[p.name]
    saveSettings()
  }
  pushState()
  return agentsSnapshot()
})

// Set an agent's reasoning-effort level (valid values depend on the model family; see efforts.ts).
// Console-driven API agents pass it to the driver; for MCP agents it's a recorded preference.
ipcMain.handle('clients:setEffort', (_e, p: { name: string; effort: string }) => {
  if (p.effort) agentEfforts[p.name] = p.effort
  else delete agentEfforts[p.name]
  saveSettings()
  pushState()
  return agentsSnapshot()
})

ipcMain.handle('policy:setSafeMode', (_e, on: boolean) => {
  state.safeMode = !!on
  pushState()
  return state.safeMode
})

ipcMain.handle('policy:setUseAgents', (_e, on: boolean) => {
  state.useAgents = !!on
  saveSettings()
  pushState()
  return state.useAgents
})

ipcMain.handle('policy:setAgentFanout', (_e, n: number) => {
  // Functions per sub-agent in agents mode. Clamp to something sane; 8 is the default.
  const v = Math.floor(Number(n))
  state.agentFanout = Number.isFinite(v) && v >= 1 ? Math.min(64, v) : 8
  saveSettings()
  pushState()
  return state.agentFanout
})
ipcMain.handle('policy:setAutoLand', (_e, on: boolean) => {
  state.autoLand = !!on
  saveSettings()
  pushState()
  return state.autoLand
})
ipcMain.handle('policy:setAutoPush', (_e, on: boolean) => {
  state.autoPushEnabled = !!on
  autoPushStatus = { state: 'idle' } // clear any stale status when toggling
  if (!on) {
    for (const t of autoPushTimers.values()) clearTimeout(t)
    autoPushTimers.clear()
  }
  saveSettings()
  pushState()
  return state.autoPushEnabled
})
ipcMain.handle('policy:setReports', (_e, on: boolean) => {
  state.reportsEnabled = !!on
  setReportsEnabled(state.reportsEnabled)
  saveSettings()
  pushState()
  return state.reportsEnabled
})
ipcMain.handle('reports:open', async () => {
  await shell.openPath(reportsDir())
  return reportsDir()
})

ipcMain.handle('tips:get', () => readTips())
ipcMain.handle('tips:open', () => {
  openTips()
  return true
})
ipcMain.handle('app:version', () => app.getVersion())
// Manual "is a newer build out?" check, driven by the top-bar refresh button. Also fires the
// updater events that keep the top banner live while the app is open.
ipcMain.handle('app:checkUpdate', () => checkForAppUpdate())
ipcMain.handle('app:quitAndInstall', () => quitAndInstallUpdate())
// Wipe all AI stats (all-time + current run + best-div history). onChange persists + pushes state.
ipcMain.handle('stats:clearAll', () => {
  aiStats.clearAll()
  return true
})
ipcMain.handle('debug:dump', () => dumpDebug(mainWindow, fullState(), activityBus.snapshot()))
ipcMain.handle('debug:open', async () => {
  await shell.openPath(debugDir())
  return debugDir()
})
ipcMain.handle('tour:get', () => readTour())
ipcMain.handle('tour:open', () => {
  openTour()
  return true
})
ipcMain.handle('tour:seen', () => {
  state.tourSeen = true
  saveSettings()
  pushState()
  return true
})
ipcMain.handle('tour:replay', () => {
  state.tourSeen = false
  saveSettings()
  pushState()
  return true
})
// "Tango says" update note: remember which announcement the user has read so the
// unread-mail badge stays until they open it, then never comes back for that note.
ipcMain.handle('tango:noteSeen', (_e, id: string) => {
  state.updateNoteSeen = typeof id === 'string' ? id : ''
  saveSettings()
  pushState()
  return true
})

ipcMain.handle('review:merge', async () => {
  if (!state.repoPath || !state.baseBranch) throw new Error('nothing to merge')
  await mergeWorkBranch(state.repoPath, state.baseBranch)
  state.reviews = []
  state.baseBranch = null
  pushState()
  return true
})

ipcMain.handle('review:discard', async () => {
  if (!state.repoPath || !state.baseBranch) throw new Error('nothing to discard')
  await discardWorkBranch(state.repoPath, state.baseBranch)
  state.reviews = []
  state.baseBranch = null
  pushState()
  return true
})

ipcMain.handle('repo:cloneAndOpen', async (_e, url: string) => {
  if (!mainWindow) return { ok: false, error: 'no window' }
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to clone the repo into',
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
  const parent = res.filePaths[0]
  const name = (url.replace(/\/+$/, '').split('/').pop() || 'repo').replace(/\.git$/, '')
  const dest = join(parent, name)
  const clone = await new Promise<{ code: number; out: string }>((resolve) => {
    let out = ''
    const child = spawn('git', ['clone', '--progress', url, dest], { env: process.env })
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', (e) => resolve({ code: -1, out: out + String(e) }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
  if (clone.code !== 0) return { ok: false, error: clone.out.slice(-400) }
  return { ok: true, repo: setRepo(dest) }
})

ipcMain.handle('repo:clone', async (_e, payload: { url: string; dest: string }) => {
  return new Promise((resolve) => {
    const child = spawn('git', ['clone', payload.url, payload.dest], { env: process.env })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', (err) => resolve({ ok: false, output: String(err) }))
    child.on('close', (code) => resolve({ ok: code === 0, output: out, code }))
  })
})

// Is this checkout behind its remote? Fetches (best-effort) then reports ahead/behind vs the
// default branch, so the renderer can offer a one-click update when the local tooling is stale.
ipcMain.handle('repo:updateStatus', async (): Promise<RepoUpdateStatus> => {
  const repo = state.repoPath
  if (!repo || !(await isGitRepo(repo))) return { isGit: false }
  try {
    const fetched = await fetchRemote(repo)
    const [branch, db, dirty] = await Promise.all([currentBranch(repo), defaultBranch(repo), isDirty(repo)])
    const ab = await aheadBehind(repo, db)
    // "behind" and "unpublished" are independent signals: behind drives the Update offer regardless
    // of local commits; unmergedAhead is the real unpublished count (already-merged commits excluded).
    const unmerged = ab && ab.ahead > 0 ? await unmergedAhead(repo, db) : 0
    return {
      isGit: true, branch, defaultBranch: db,
      ahead: ab?.ahead ?? 0, unmergedAhead: unmerged, behind: ab?.behind ?? 0, dirty, fetched
    }
  } catch (e) {
    return { isGit: true, error: String(e) }
  }
})

// Bring the local checkout up to the remote default branch by rebasing onto it: fast-forwards when
// there are no local commits, and keeps local commits (replaying them, dropping already-merged ones)
// when there are - so having unpublished work never blocks getting new upstream work. Auto-stashes
// uncommitted tracked changes; never touches untracked matched work; aborts cleanly on a conflict.
// On success, reload the descriptor (tangos.json may have moved) and drop the atlas cache.
ipcMain.handle('repo:pull', async (): Promise<{ ok: boolean; err?: string; behind?: number; note?: string }> => {
  const repo = state.repoPath
  if (!repo || !(await isGitRepo(repo))) return { ok: false, err: 'not a git checkout' }
  const db = await defaultBranch(repo)
  const res = await rebasePull(repo, db, (label, pct) =>
    mainWindow?.webContents.send('repo:pullProgress', { label, pct })
  )
  if (res.ok) {
    atlasCache = { repo: null }
    reloadDescriptor('manual')
  }
  const ab = res.ok ? await aheadBehind(repo, db) : null
  return { ok: res.ok, err: res.ok ? undefined : res.err, behind: ab?.behind, note: res.note }
})

// Hard "Sync repo": preview what a reset-to-origin would discard, so the confirm shows real numbers.
ipcMain.handle('repo:syncPreview', async (): Promise<SyncPreview> => {
  const repo = state.repoPath
  if (!repo || !(await isGitRepo(repo)))
    return { branch: '', defaultBranch: 'main', behind: 0, ahead: 0, localChanges: 0, untracked: 0, error: 'not a git checkout' }
  try {
    return await syncPreview(repo)
  } catch (e) {
    return { branch: '', defaultBranch: 'main', behind: 0, ahead: 0, localChanges: 0, untracked: 0, error: String(e) }
  }
})

// Back up everything a sync would destroy (working-tree changes, untracked files, local commits)
// into a timestamped sibling folder, so the destructive sync is undoable.
ipcMain.handle('repo:backup', async (): Promise<{ ok: boolean; path?: string; files?: number; bundle?: boolean; error?: string }> => {
  const repo = state.repoPath
  if (!repo || !(await isGitRepo(repo))) return { ok: false, error: 'not a git checkout' }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const r = await backupBeforeSync(repo, stamp)
    // bundle=false means the commit bundle FAILED - the UI must not claim "commits backed up"
    // right before the user runs a sync that discards those commits.
    return { ok: true, path: r.path, files: r.files, bundle: r.bundle }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// The destructive part: fetch + reset --hard origin/<default> + clean -fd (keeps gitignored setup).
// Gets the checkout back to a fresh-clone src tree. On success, drop caches so the atlas + matched
// set re-derive from the now-current tree.
ipcMain.handle('repo:sync', async (): Promise<{ ok: boolean; branch?: string; head?: string; error?: string }> => {
  const repo = state.repoPath
  if (!repo || !(await isGitRepo(repo))) return { ok: false, error: 'not a git checkout' }
  const r = await syncToOrigin(repo, (label, pct) => mainWindow?.webContents.send('repo:syncProgress', { label, pct }))
  if (r.ok) {
    atlasCache = { repo: null }
    reloadDescriptor('manual')
    scheduleAtlasRegen()
    pushState()
  }
  return { ok: r.ok, branch: r.branch, head: r.head, error: r.err }
})

// Diverged clone (local commits the remote lacks, can't fast-forward): push those commits to a
// per-user branch and open a PR, so the contributor's committed work reaches the shared repo the
// same way auto-push does. Leaves their local branch untouched.
ipcMain.handle('repo:pushWorkPr', async (): Promise<{ ok: boolean; url?: string; error?: string }> => {
  const repo = state.repoPath
  if (!repo || !(await isGitRepo(repo))) return { ok: false, error: 'not a git checkout' }
  const gh = await remoteSlug(repo)
  if (!gh) return { ok: false, error: 'no GitHub "origin" remote to push to' }
  const token = secretsEnv().GITHUB_TOKEN || process.env.GITHUB_TOKEN
  if (!token) return { ok: false, error: 'not signed into GitHub - sign in from Settings first' }
  const base = await defaultBranch(repo)
  // Refresh origin/<base> so we diff against CURRENT main, not a stale checkout. Without this a
  // clone that has drifted behind main re-PRs work that already landed upstream - the giant
  // stale-duplicate PR (its content is all merged, so merging it would only revert docs/db and
  // un-match files). Then build the PR from origin/<base> + only the genuinely-new matches, the
  // same way auto-push does (throwaway index in pushSubsetToBranch - the local branch is untouched).
  await fetchBase(repo, base)
  const files = await newSrcVsBase(repo, base)
  if (!files.length) {
    return { ok: false, error: `nothing to push - your local matches are already on ${base} upstream (Sync to catch up)` }
  }
  // Fallback must never be 'work': `tangos/work` IS the safe-mode work branch (WORK_BRANCH), and a
  // contributor with no git user.name once collided with it - update-ref then moved the checked-out
  // branch out from under HEAD. pushSubsetToBranch refuses it too; this keeps the name sensible.
  const who = (await gitUserName(repo)).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
  const branch = `tangos/${who && `tangos/${who}` !== WORK_BRANCH ? who : `pr-${randomUUID().slice(0, 6)}`}`
  // Push to the base repo if this account can, otherwise to its fork (created on demand), so a
  // contributor without collaborator access still opens a cross-repo PR instead of getting a 403.
  const target = await getPushTarget(gh, token)
  if (!target.ok || !target.slug) return { ok: false, error: target.error ?? 'could not resolve a push target' }
  const consoleVer = app.getVersion() // plain version, no "-dev" suffix (see noteMatchAndPush)
  // fromHead: this handler's contract is "publish those COMMITS" - ship the committed HEAD blobs,
  // not whatever the worktree has drifted to since (an agent dirtying a committed match mid-push
  // otherwise shipped the dirty bytes, and a deleted worktree file killed the whole push).
  const pushed = await pushSubsetToBranch(
    repo, branch, base, files,
    `tangos: matched work (${branch}) [tangOS Console v${consoleVer}]`,
    target.slug, token,
    { fromHead: true }
  )
  if (!pushed.ok) return { ok: false, error: `push failed: ${pushed.err.slice(-160)}` }
  const pr = await ensurePullRequest({
    owner: gh.owner,
    repo: gh.repo,
    head: branch,
    base,
    token,
    headOwner: target.headOwner,
    title: `tangos: matched work (${branch})`,
    body: `${files.length} matched function${files.length === 1 ? '' : 's'} pushed from tangOS Console${target.isFork ? ` (from fork \`${target.slug.owner}/${target.slug.repo}\`)` : ''}. Review + CI gate the merge.`
  })
  if (!pr.ok) return { ok: false, error: `pushed to ${target.slug.owner}/${target.slug.repo}:${branch}, but PR failed: ${pr.error}` }
  return { ok: true, url: pr.url }
})

ipcMain.handle('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.handle('win:maximizeToggle', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return false
  if (w.isMaximized()) {
    w.unmaximize()
    return false
  }
  w.maximize()
  return true
})
ipcMain.handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
ipcMain.handle('win:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)

const popouts = new Map<string, BrowserWindow>()
ipcMain.handle('draft:addItem', (_e, item: BatchItem) => {
  // relay an add-to-batch from a popout window to the main window's composer
  mainWindow?.webContents.send('draft:add', item)
})

ipcMain.handle('atlas:popout', (_e, module: string) => {
  const existing = popouts.get(module)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  const win = new BrowserWindow({
    width: 560,
    height: 920,
    minWidth: 400,
    minHeight: 560,
    icon: appIcon(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  popouts.set(module, win)
  win.on('closed', () => popouts.delete(module))
  win.on('maximize', () => win.webContents.send('win:maximized', true))
  win.on('unmaximize', () => win.webContents.send('win:maximized', false))
  const rurl = process.env['ELECTRON_RENDERER_URL']
  if (rurl) win.loadURL(`${rurl}#popout=${encodeURIComponent(module)}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `popout=${encodeURIComponent(module)}` })
})

ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
// Reveal a path in the OS file manager: if the file/dir still exists, open its folder with
// it selected; otherwise (a temp file that a finished run already cleaned up) open the
// containing folder so it's never a dead click.
ipcMain.handle('shell:revealPath', (_e, p: string) => {
  if (existsSync(p)) {
    shell.showItemInFolder(p)
    return ''
  }
  const dir = dirname(p)
  return existsSync(dir) ? shell.openPath(dir) : shell.openPath(p)
})
ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(text)
  return true
})

// ---- bug report -----------------------------------------------------------
ipcMain.handle('bug:pickScreenshots', async () => {
  if (!mainWindow) return []
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach screenshots',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  })
  return res.canceled ? [] : res.filePaths
})
ipcMain.handle('bug:saveImage', (_e, bytes: number[], ext: string) => {
  try {
    const dir = join(app.getPath('temp'), 'tangos-bug-paste')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, `paste-${Date.now()}.${(ext || 'png').replace(/[^a-z0-9]/gi, '')}`)
    writeFileSync(p, Buffer.from(bytes))
    return p
  } catch {
    return null
  }
})
ipcMain.handle('bug:submit', async (_e, payload: { description: string; screenshots: string[] }) => {
  const isGit = !!state.repoPath && existsSync(join(state.repoPath, '.git'))
  let branch: string | undefined
  if (isGit && state.repoPath) {
    try {
      branch = (await currentBranch(state.repoPath)) || undefined
    } catch {
      /* ignore */
    }
  }
  const debug = {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      os: osRelease()
    },
    repo: { path: state.repoPath, project: state.descriptor?.project?.name, isGit, branch, validation: state.validationErrors },
    mcp: mcpState(),
    policies: {
      allowMutations: state.allowMutations,
      safeMode: state.safeMode,
      useAgents: state.useAgents,
      agentFanout: state.agentFanout,
      autoLand: state.autoLand,
      autoPushEnabled: state.autoPushEnabled
    },
    autoPush: autoPushStatus,
    agents: agentsSnapshot().map((a) => ({
      name: a.name,
      kind: a.kind,
      roles: a.roles,
      connected: a.connected,
      matches: a.stats.totalMatches,
      attempts: a.stats.matchAttempts,
      hitRate: a.stats.hitRate
    })),
    recentRuns: activityBus
      .snapshot()
      .slice(-25)
      .map((r) => ({
        tool: r.toolId,
        label: r.label,
        status: r.status,
        exitCode: r.exitCode,
        source: r.source,
        client: r.client?.name,
        ms: (r.finishedAt ?? Date.now()) - r.startedAt,
        outputTail: (r.output || '').slice(-1500)
      })),
    secretsPresent: listSecrets().map((s) => s.name) // NAMES only, never the values
  }
  const { folder, markdown } = writeBugReport({
    description: payload.description,
    screenshots: payload.screenshots ?? [],
    debug,
    appVersion: app.getVersion()
  })
  clipboard.writeText(markdown)
  await shell.openPath(folder)
  return { folder }
})

// ---- lifecycle ------------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(null) // no native File/Edit/View menu - we use our own chrome
  const saved = loadSettings()
  // migrate legacy single-role (string) entries to the multi-role (string[]) format, AND map the
  // old 7-role names onto the pruned 4-role set so a stored assignment never points at a dead role.
  const ROLE_MIGRATE: Record<string, string> = {
    'Main matcher': 'Drafter',
    'Explorer': 'Drafter',
    'Long sweep': 'Hard matcher',
    'Draft checker': 'Refiner',
    'Finisher': 'Random',
    'Verifier': '' // dropped - no equivalent, so it clears
  }
  agentRoles = Object.fromEntries(
    Object.entries(saved.agentRoles ?? {}).map(([k, v]) => [
      k,
      [
        ...new Set(
          (Array.isArray(v) ? v : [v])
            .map((r) => (r in ROLE_MIGRATE ? ROLE_MIGRATE[r] : r))
            .filter((r) => r && r !== 'Unassigned')
        )
      ]
    ])
  )
  agentEfforts = { ...(saved.agentEfforts ?? {}) }
  aiStats.hydrate(saved.agentStats)
  aiStats.hydrateBestDiv(saved.agentBestDiv)
  aiStats.remapKeys(normalizeName) // fold old per-model/per-session stat keys into one family box
  state.reportsEnabled = saved.reportsEnabled ?? false
  state.tourSeen = saved.tourSeen ?? false
  state.updateNoteSeen = saved.updateNoteSeen ?? ''
  state.useAgents = saved.useAgents ?? false
  state.agentFanout = saved.agentFanout ?? 8
  state.autoLand = saved.autoLand ?? true
  state.autoPushEnabled = saved.autoPushEnabled ?? false
  viewerPrefs = {
    theme: typeof saved.viewerPrefs?.theme === 'string' ? saved.viewerPrefs.theme : viewerPrefs.theme,
    contributorColors:
      typeof saved.viewerPrefs?.contributorColors === 'boolean'
        ? saved.viewerPrefs.contributorColors
        : viewerPrefs.contributorColors
  }
  bgPrefs = { enabled: typeof saved.bgPrefs?.enabled === 'boolean' ? saved.bgPrefs.enabled : bgPrefs.enabled }
  myContributorColor = typeof saved.myContributorColor === 'string' ? saved.myContributorColor : null
  matchingPrefs = {
    allowNearMiss:
      typeof saved.matchingPrefs?.allowNearMiss === 'boolean'
        ? saved.matchingPrefs.allowNearMiss
        : matchingPrefs.allowNearMiss,
    allowGhidra:
      typeof saved.matchingPrefs?.allowGhidra === 'boolean'
        ? saved.matchingPrefs.allowGhidra
        : matchingPrefs.allowGhidra
  }
  setReportsEnabled(state.reportsEnabled)
  ensureTips()
  ensureTour()
  if (saved.lastRepo && looksLikeRepo(saved.lastRepo)) setRepo(saved.lastRepo)
  // The MCP server was on when the app last closed (including an update's restart) - bring it
  // back up so connected agents' endpoint comes back without the human re-clicking Start.
  if (saved.mcpRunning && state.descriptor && state.validationErrors.length === 0) {
    void startMcpServer().catch(() => {
      /* port taken or repo moved - the user can start it by hand as before */
    })
  }
  createWindow()
  initAutoUpdate() // check the public releases feed for a newer build
  // Debug hotkeys: Ctrl+Shift+D writes a snapshot (screenshot + state + dom) to the debug folder;
  // Ctrl+Shift+I toggles DevTools. Available in every build so bugs can be captured anywhere.
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    void dumpDebug(mainWindow, fullState(), activityBus.snapshot())
  })
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    mainWindow?.webContents.toggleDevTools()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await mcp.stop()
  if (process.platform !== 'darwin') app.quit()
})

export { DESCRIPTOR_FILENAME }

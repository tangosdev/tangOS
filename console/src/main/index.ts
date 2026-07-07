import { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } from 'electron'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, watch, existsSync, unlinkSync, mkdirSync, type FSWatcher } from 'node:fs'
import { activityBus } from './activityBus'
import { McpManager } from './mcpServer'
import { loadDescriptor, DESCRIPTOR_FILENAME } from './descriptor'
import { detectRepo, writeDescriptor, looksLikeRepo } from './generate'
import { registerAll, cliCommand } from './connect'
import { runTool } from './runTool'
import { preflight } from './preflight'
import { readAtlas } from './atlas'
import { listClaims, tryLock, releaseClaim, hasKey, handle as claimsHandle } from './claims'
import { githubCredits } from './github'
import { startDeviceFlow, pollForToken } from './githubAuth'
import { encryptionAvailable, listSecrets, setSecret, deleteSecret, secretsEnv } from './secrets'
import { aiStats, outputIsMatch } from './aiStats'
import { record as report, setReportsEnabled, reportsDir } from './reports'
import { ensureTips, readTips, openTips } from './tips'
import {
  isGitRepo, ensureWorkBranch, statusMap, changedSince, diffForFile, commitFiles,
  mergeWorkBranch, discardWorkBranch, WORK_BRANCH
} from './gitsafe'
import type {
  TangosDescriptor, TangosRuntime, TangosTool, RepoState, McpState, Batch, BatchDraft, BatchItem,
  Review, RunResult, AtlasDb, SecretsInfo, AiAgent, ConnectedClient
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
  useAgents: boolean // run drivers with parallel workers (and allow concurrent drives)
  autoLand: boolean // after a drive, bank + verify (crackloop land) the matches into the repo
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
  useAgents: false,
  autoLand: true
}

// AIs set to run continuously (the "infinite" batch size): when their batch finishes we
// generate + assign (and, for API AIs, drive) the next one.
const agentLoop = new Set<string>()
// Kill switches for in-flight API drivers, keyed by agent name, so the red Stop button can
// end a drive early. Whatever the driver already landed is kept (matches are recorded live).
const driveKills = new Map<string, () => void>()

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

/** Mutating run under safe mode: isolate on the work branch, commit what changed, record a review. */
async function runSafeMode(base: Parameters<typeof runTool>[0]): Promise<RunResult> {
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
  aiStats.recordMatch(client?.name, ok, parseHexish(values.size))
  if (ok && typeof values.func === 'string') markItemDone(values.func)
}

/** Flag a target done across any batch that lists it (drives batch % complete). */
function markItemDone(func: string): void {
  let changed = false
  for (const b of state.batches)
    for (const it of b.items)
      if (it.ref === func && !it.done) {
        it.done = true
        changed = true
      }
  if (!changed) return
  pushState()
  // Continuous mode (MCP agents): when a targeted batch is fully matched, queue the next.
  for (const b of state.batches) {
    if (
      b.targetAgent &&
      b.status !== 'done' &&
      b.items.length &&
      b.items.every((i) => i.done) &&
      agentLoop.has(b.targetAgent)
    ) {
      b.status = 'done'
      const role = agentRoles[b.targetAgent]?.[0]
      void assignToAgent(b.targetAgent, role ?? 'Unassigned', roleBatchSize(role), true).catch(() => {})
    }
  }
}

/** Pull the next queued batch addressed to this agent (or unaddressed): mark it active,
 *  retire this agent's previous active batch, and record it as the agent's current task. */
function pullNextBatch(agentName?: string): Batch | null {
  const mine = (b: Batch): boolean => !b.targetAgent || b.targetAgent === agentName
  const idx = state.batches.findIndex((b) => b.status === 'queued' && mine(b))
  if (idx === -1) return null
  for (const b of state.batches) if (b.status === 'active' && mine(b)) b.status = 'done'
  const batch = state.batches[idx]
  batch.status = 'active'
  if (agentName) {
    const done = batch.items.filter((i) => i.done).length
    aiStats.setCurrent(agentName, {
      task: batch.title || 'batch',
      batchId: batch.id,
      progress: { done, total: batch.items.length }
    })
  }
  pushState()
  return batch
}

function currentRuntime(): TangosRuntime {
  return state.descriptor?.runtime ?? { cwd: '.', python: 'python', shell: false }
}

// Remember the last-opened repo + each agent's assigned role across sessions.
let agentRoles: Record<string, string[]> = {}
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
        agentStats: aiStats.serialize(),
        reportsEnabled: state.reportsEnabled,
        tourSeen: state.tourSeen,
        useAgents: state.useAgents,
        autoLand: state.autoLand
      })
    )
  } catch {
    /* ignore */
  }
}
function loadSettings(): {
  lastRepo?: string
  agentRoles?: Record<string, string | string[]> // string = legacy single-role format
  agentStats?: Record<string, { totalMatches: number; matchAttempts: number }>
  reportsEnabled?: boolean
  tourSeen?: boolean
  useAgents?: boolean
  autoLand?: boolean
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
  batchApi: { next: pullNextBatch, list: () => state.batches },
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
// Per-AI stats changed: refresh the UI now, persist (debounced) so lifetime totals survive.
let statsTimer: NodeJS.Timeout | null = null
aiStats.onChange = () => {
  pushState()
  if (statsTimer) return
  statsTimer = setTimeout(() => {
    statsTimer = null
    saveSettings()
  }, 3000)
}

let mainWindow: BrowserWindow | null = null

// Cache the loaded Atlas data so popouts + view-switches reuse it instantly
// instead of re-reading/re-fetching the ~2MB data every time.
let atlasCache: { repo: string | null; local?: AtlasDb | null; live?: AtlasDb | null } = { repo: null }

function repoState(): RepoState {
  return {
    path: state.repoPath,
    descriptor: state.descriptor,
    descriptorPath: state.descriptorPath,
    hasDescriptor: !!state.descriptor,
    validationErrors: state.validationErrors
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
    `You are connecting to tangOS Console — a local bridge that exposes the ${title} toolchain to you as MCP tools, with a live viewer the human is watching in real time.`,
    proj?.tagline ? `Project: ${proj.tagline}` : null,
    '',
    'CONNECT — the endpoint is the same for everyone; only the way you register it differs by client. Add it as a Streamable HTTP MCP server:',
    `  URL (Streamable HTTP):  ${url}`,
    `  - Claude Code:                       ${cliCommand(url)}`,
    `  - Cursor / Cline / Windsurf / Roo:   add to your mcp.json -> "mcpServers": { "tangos": { "url": "${url}" } }`,
    `  - Claude Desktop:                    "tangos": { "command": "npx", "args": ["-y", "mcp-remote", "${url}"] }`,
    '  - No native MCP (a browser chatbot like grok.com / chatgpt.com, or any client that cannot reach a local HTTP MCP): you CANNOT connect directly. Have the human run your calls, or from the tangOS console dir run:',
    '        npx tsx scripts/mcp-run.mts <calls.json> <your-name>',
    '      where calls.json is e.g. [{"tool":"next_batch","args":{}}] — pass your name (grok, glm, ...) so the live viewer tags your runs.',
    '  VERIFY you actually connected: call list_tools (or next_batch) and confirm a real tool result comes back. If nothing round-trips, you are NOT connected — do not report "connected" without a tool response, and check that the console shows your session under Connected agents.',
    '',
    'THEN:',
    '  1. Your first and ONLY action is to call next_batch, then WAIT. Until it returns an actual batch you are idle: if it comes back empty, wait ~30-60s and call next_batch again, and do NOTHING else — do not call any other tool, do not read files or notes, do not "set up" or pick your own targets. Just wait and re-poll. Self-assigning work on an empty queue is the #1 way to waste tokens here; do not do it.',
    `  2. ONLY once next_batch hands you a real batch do you start using tools. It gives your role (if any), each target WITH a ready-to-run match call, this repo's KNOWN WALLS, and how to work them. Then drive the toolchain: ${shown}.`,
    '  3. Respect required args: each tool lists its REQUIRED args (see list_tools or tangos.json tools[]) — e.g. match needs c, func, addr, size. Use the ready call next_batch gives you; never omit `c`.',
    '  4. On any tool error (-32602 / compile fail): read that tool\'s args in tangos.json, fix the call, and RETRY. Never end your turn on the first failed call.',
    '  5. Every call streams into the human\'s live viewer tagged with your name — skip the narration and just work. If you hit a known wall, say so plainly and move on rather than grinding.',
    '  6. Stay in your lane: edit source only for your assigned targets, and if an edit makes a function worse, revert it — never leave a tracked file regressed. Keep scratch files, notes, and reports in a temp dir, not in the repo or next to source.',
    proj?.readFirst ? `\nREAD FIRST: ${proj.readFirst}` : null
  ]
  return lines.filter((l) => l !== null).join('\n').trim()
}

// Stored API keys that surface a provider as an AI in the controller, mapped to its name.
// Claude + GLM are console-drivable (glm_refine driver); the rest appear as available AIs.
const LLM_KEYS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'Claude',
  GLM_API_KEY: 'GLM',
  DEEPSEEK_API_KEY: 'DeepSeek',
  GROK_API_KEY: 'Grok',
  OPENAI_API_KEY: 'ChatGPT'
}
// Providers currently being driven by the console (Phase D populates this).
const apiDriving = new Set<string>()

/** The controller roster: one AiAgent per name, merging live MCP sessions, keyed API
 *  providers, and previously-seen names (whose boxes persist grayed-out). */
function agentsSnapshot(): AiAgent[] {
  const byName = new Map<string, AiAgent>()

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
      connected: true,
      sessions: list.length,
      currentBatchId: aiStats.currentBatchId(name),
      stats: aiStats.statsFor(name)
    })
  }

  // 2. keyed API providers (drivable). If already live via MCP, just tag the provider.
  for (const s of listSecrets()) {
    const provider = LLM_KEYS[s.name]
    if (!provider) continue
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
      connected: apiDriving.has(provider),
      currentBatchId: aiStats.currentBatchId(provider),
      stats: aiStats.statsFor(provider)
    })
  }

  // 3. previously-seen names with lifetime stats but no live session -> grayed box.
  for (const name of aiStats.names()) {
    if (byName.has(name)) continue
    byName.set(name, {
      name,
      kind: 'mcp',
      roles: agentRoles[name] ?? [],
      connected: false,
      stats: aiStats.statsFor(name)
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
    useAgents: state.useAgents,
    autoLand: state.autoLand,
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
  // Batches + pending reviews are repo-specific; reset for the new repo.
  state.batches = []
  state.reviews = []
  state.baseBranch = null
  atlasCache = { repo: state.repoPath }
  // Changing the repo invalidates any AI sessions' tool lists.
  mcp.resetSessions()
  // Watch the new repo's tangos.json so on-disk edits hot-reload.
  watchDescriptor(state.repoPath)
  if (state.repoPath) saveSettings()
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
  // Whatever's already loaded (live preferred), else local — never fetches. For popouts.
  if (atlasCache.repo === state.repoPath) {
    if (atlasCache.live) return atlasCache.live
    if (atlasCache.local) return atlasCache.local
  }
  if (!state.descriptor || !state.repoPath) return null
  const db = readAtlas(state.repoPath, state.descriptor)
  atlasCache = { ...atlasCache, repo: state.repoPath, local: db }
  return db
})

ipcMain.handle('atlas:loadLive', async (_e, force?: boolean) => {
  const url = state.descriptor?.data?.committedDbUrl
  if (!url) throw new Error('this repo has no committedDbUrl in tangos.json')
  // Use the session cache only for the initial passive load. A user-initiated Live
  // toggle/refresh passes force=true, which re-fetches AND cache-busts the CDN (raw
  // GitHub caches ~5 min) so freshly-published progress actually shows up.
  if (!force && atlasCache.repo === state.repoPath && atlasCache.live !== undefined) return atlasCache.live
  const bust = force ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15000)
  try {
    const r = await fetch(bust, { signal: ac.signal })
    if (!r.ok) throw new Error(`live fetch failed: HTTP ${r.status}`)
    const db = (await r.json()) as AtlasDb
    atlasCache = { ...atlasCache, repo: state.repoPath, live: db }
    return db
  } finally {
    clearTimeout(timer)
  }
})

ipcMain.handle('claims:list', async () => {
  const base = state.descriptor?.data?.claimsApi
  if (!base || !state.repoPath) return { claims: [], whoami: { hasKey: false, handle: '' } }
  const claims = await listClaims(base)
  return { claims, whoami: { hasKey: hasKey(state.repoPath), handle: claimsHandle(state.repoPath) } }
})

ipcMain.handle('claims:lock', async (_e, p: { module: string; start: string; end: string; note?: string }) => {
  const base = state.descriptor?.data?.claimsApi
  if (!base || !state.repoPath) throw new Error('this repo has no claimsApi configured')
  return tryLock(base, state.repoPath, p)
})

ipcMain.handle('claims:release', async (_e, id: string) => {
  const base = state.descriptor?.data?.claimsApi
  if (!base || !state.repoPath) throw new Error('this repo has no claimsApi configured')
  return releaseClaim(base, state.repoPath, id)
})

ipcMain.handle('claims:check', async (_e, p: { module: string; start: string; end: string }) => {
  const base = state.descriptor?.data?.claimsApi
  if (!base) return null
  const u = `${base.replace(/\/$/, '')}/check?module=${encodeURIComponent(p.module)}&start=${encodeURIComponent(p.start)}&end=${encodeURIComponent(p.end)}`
  try {
    const r = await fetch(u)
    if (!r.ok) return { ok: false, error: r.status }
    return await r.json()
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('atlas:generate', async () => {
  if (!state.repoPath || !state.descriptor?.data?.generate) {
    throw new Error('this repo has no data.generate command in tangos.json')
  }
  const dbRel = state.descriptor.data.dbPath || 'chaos-db.json'
  const tool: TangosTool = {
    id: 'generate_atlas_data',
    label: 'Generate Atlas data',
    category: 'reporting',
    readOnly: true,
    command: state.descriptor.data.generate
  }
  await runTool({
    tool,
    values: { out: dbRel },
    runtime: currentRuntime(),
    repoPath: state.repoPath,
    source: 'user',
    allowMutations: true,
    extraEnv: secretsEnv()
  })
  const db = readAtlas(state.repoPath, state.descriptor)
  atlasCache = { ...atlasCache, repo: state.repoPath, local: db }
  return db
})

// A role shapes BOTH what the scheduler picks and the default batch size:
//  - Long sweep      -> large functions, fewer per batch
//  - Explorer        -> spread across modules/address space, more per batch
//  - Draft checker   -> the near-miss refine pile
//  - Main matcher/etc-> plain similarity scheduler
function genPlanFor(role: string | undefined, count: number): { schedId: string; values: Record<string, unknown> } {
  switch (role) {
    case 'Long sweep':
      return { schedId: 'coddog', values: { limit: count, min: '0x200' } }
    case 'Explorer':
      return { schedId: 'coddog', values: { limit: count, spread: true } }
    case 'Draft checker':
      return { schedId: 'refine_wl', values: { limit: count } }
    default:
      return { schedId: 'coddog', values: { limit: count } }
  }
}
/** Sensible default batch size per role (Long sweep is heavy -> fewer; Explorer -> more). */
export const roleBatchSize = (role?: string): number =>
  role === 'Long sweep' ? 8 : role === 'Explorer' ? 24 : 16

// Generate a batch scheduled for this AI's role (similarity, large-function sweep, spread
// survey, or near-miss refine). Each target carries scaffolding metadata for the agent.
async function genDraft(role: string | undefined, count: number): Promise<BatchDraft> {
  if (!state.repoPath || !state.descriptor) throw new Error('no repo loaded')
  // Functions already handed out (in a still-open batch) — never generate these again so
  // two AIs don't grind the same target and repeated Assigns don't return the same list.
  const taken = new Set(
    state.batches.filter((b) => b.status !== 'done').flatMap((b) => b.items.map((i) => i.ref))
  )
  // Ask the scheduler for extra so we still have `count` after dropping the taken ones.
  const plan = genPlanFor(role, count + taken.size)
  // The planned scheduler, falling back to coddog, then any read-only limit+out tool.
  const sched =
    state.descriptor.tools.find((t) => t.id === plan.schedId) ??
    state.descriptor.tools.find((t) => t.id === 'coddog') ??
    state.descriptor.tools.find(
      (t) => t.readOnly && t.args?.some((a) => a.name === 'out') && t.args?.some((a) => a.name === 'limit')
    )
  if (!sched) throw new Error('this repo has no similarity scheduler (coddog) in tangos.json')

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
  try {
    await runTool({
      tool: sched,
      values: { ...plan.values, out: outPath },
      runtime: currentRuntime(),
      source: 'user',
      repoPath: state.repoPath,
      allowMutations: false,
      extraEnv: secretsEnv(),
      onSpawn: ({ kill }) => {
        schedKill = kill
      }
    })
  } finally {
    clearTimeout(timer)
  }
  if (timedOut) {
    throw new Error(
      `the similarity scheduler (${sched.id}) ran longer than 5 minutes and was stopped. ` +
        `It ranks the whole corpus each time; try a smaller batch, a specific module, or check that the repo is set up.`
    )
  }

  let lines: string[] = []
  try {
    lines = readFileSync(outPath, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    throw new Error('scheduler produced no worklist (see the live viewer for its output)')
  }
  const items: BatchItem[] = []
  for (const line of lines) {
    if (items.length >= count) break
    try {
      const r = JSON.parse(line) as {
        name: string; module?: string; addr?: string; size?: string; target_hex?: string
        coddog_sim?: number; siblings?: { name: string; sim: number }[]
      }
      if (taken.has(r.name)) continue // already assigned elsewhere
      const sib = r.siblings?.[0]
      const sim = Math.round((r.coddog_sim ?? sib?.sim ?? 0) * 100)
      items.push({
        id: `gen-${r.name}`,
        ref: r.name,
        module: r.module,
        addr: r.addr ? parseInt(r.addr, 16) : undefined,
        size: r.size ? parseInt(r.size, 16) : undefined,
        targetHex: r.target_hex,
        label: sib ? `${sim}% like ${sib.name}` : undefined
      })
    } catch {
      /* skip malformed rows */
    }
  }
  try {
    unlinkSync(outPath)
  } catch {
    /* ignore */
  }
  if (!items.length) throw new Error('scheduler returned no functions')
  const prompt =
    'Match these targets. Each was picked by opcode similarity to an already-matched sibling ' +
    '(shown per target) — lean on that sibling as scaffolding. Run `match` on each; use `fdiff` on near-misses.'
  const label = role && role !== 'Unassigned' ? role : 'Similarity'
  return { title: `${label} batch (${items.length})`, prompt, items } satisfies BatchDraft
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

ipcMain.handle('mcp:start', async () => {
  if (!state.descriptor || state.validationErrors.length > 0) {
    throw new Error('cannot start: descriptor missing or invalid')
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
  return mcpState()
})

ipcMain.handle('mcp:stop', async () => {
  await mcp.stop()
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
    targetAgent: targetAgent || undefined
  }
  state.batches.push(b)
  report('batch', {
    event: 'created',
    batchId: b.id,
    title: b.title,
    targetAgent: b.targetAgent ?? null,
    targets: b.items.length,
    items: b.items.map((i) => i.ref)
  })
  pushState()
  return state.batches
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
  return { ok: true }
})
// Stop an AI's continuous loop (it finishes its current batch, then no more are queued).
ipcMain.handle('ai:stop', (_e, agentName: string) => {
  agentLoop.delete(agentName) // stop any continuous loop from re-assigning
  driveKills.get(agentName)?.() // kill an in-flight driver early; matches found so far are kept
  pushState()
  return true
})

// Console-drive a keyed API provider on its assigned batch: write a worklist and run the
// model driver (glm_refine, Anthropic-dialect) tagged as that AI, then fold the reported
// landed matches + token usage into its stats.
async function driveBatch(agentName: string): Promise<void> {
  if (!state.repoPath) throw new Error('no repo selected')
  const env = secretsEnv()
  const driverEnv: Record<string, string> = {}
  if (agentName === 'GLM') {
    if (!env.GLM_API_KEY) throw new Error('no GLM_API_KEY stored — add it in Settings')
  } else if (agentName === 'Claude') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('no ANTHROPIC_API_KEY stored — add it in Settings')
    driverEnv.GLM_API_KEY = env.ANTHROPIC_API_KEY // the driver reads GLM_API_KEY; point it at Anthropic
    driverEnv.GLM_BASE_URL = 'https://api.anthropic.com'
    driverEnv.GLM_MODEL = 'claude-sonnet-4-5'
  } else {
    throw new Error(`${agentName} has no console driver yet (idle-only)`)
  }
  const batch = state.batches.find((b) => b.targetAgent === agentName && b.status !== 'done')
  if (!batch) throw new Error(`no batch assigned to ${agentName} — assign one first`)
  const rows = batch.items
    .filter((i) => i.addr != null && i.size != null && i.module && i.targetHex)
    .map((i) =>
      JSON.stringify({
        name: i.ref,
        addr: '0x' + i.addr!.toString(16).padStart(8, '0'),
        size: '0x' + i.size!.toString(16),
        module: i.module,
        target_hex: i.targetHex
      })
    )
  if (!rows.length) throw new Error('this batch has no drivable targets (need addr/size/module/target bytes)')

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
  const jobs = state.useAgents ? 6 : 1 // "Use agents" -> parallel workers
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
      aiStats.recordMatch(agentName, ok, item?.size)
      if (ok && item) item.done = true
      aiStats.setCurrent(agentName, {
        task: batch.title,
        batchId: batch.id,
        progress: { done: batch.items.filter((i) => i.done).length, total: batch.items.length }
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
        aiStats.recordMatch(agentName, !!r.matched, item?.size)
        if (r.matched && item) item.done = true
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
    // linkcheck-gates everything banked. We deliberately stop BEFORE git commit/push — that
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

ipcMain.handle('ai:drive', async (_e, agentName: string) => {
  try {
    // Loop while this AI is in continuous mode: drive, then generate + assign the next.
    do {
      await driveBatch(agentName)
      if (!agentLoop.has(agentName)) break
      const primary = agentRoles[agentName]?.[0]
      await assignToAgent(agentName, primary ?? 'Unassigned', roleBatchSize(primary), true)
    } while (agentLoop.has(agentName))
  } catch (e) {
    agentLoop.delete(agentName) // stop the loop on any error
    throw e
  }
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
ipcMain.handle('policy:setAutoLand', (_e, on: boolean) => {
  state.autoLand = !!on
  saveSettings()
  pushState()
  return state.autoLand
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

// ---- lifecycle ------------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(null) // no native File/Edit/View menu — we use our own chrome
  const saved = loadSettings()
  // migrate legacy single-role (string) entries to the multi-role (string[]) format
  agentRoles = Object.fromEntries(
    Object.entries(saved.agentRoles ?? {}).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).filter((r) => r && r !== 'Unassigned')])
  )
  aiStats.hydrate(saved.agentStats)
  state.reportsEnabled = saved.reportsEnabled ?? false
  state.tourSeen = saved.tourSeen ?? false
  state.useAgents = saved.useAgents ?? false
  state.autoLand = saved.autoLand ?? true
  setReportsEnabled(state.reportsEnabled)
  ensureTips()
  if (saved.lastRepo && looksLikeRepo(saved.lastRepo)) setRepo(saved.lastRepo)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await mcp.stop()
  if (process.platform !== 'darwin') app.quit()
})

export { DESCRIPTOR_FILENAME }

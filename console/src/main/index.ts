import { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } from 'electron'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, watch, type FSWatcher } from 'node:fs'
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
import { encryptionAvailable, listSecrets, setSecret, deleteSecret, secretsEnv } from './secrets'
import {
  isGitRepo, ensureWorkBranch, statusMap, changedSince, diffForFile, commitFiles,
  mergeWorkBranch, discardWorkBranch, WORK_BRANCH
} from './gitsafe'
import type {
  TangosDescriptor, TangosRuntime, TangosTool, RepoState, McpState, Batch, BatchDraft, BatchItem,
  Review, RunResult, AtlasDb, SecretsInfo
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
}

const state: AppState = {
  repoPath: null,
  descriptor: null,
  descriptorPath: null,
  validationErrors: [],
  allowMutations: true,
  enabledToolIds: [],
  batches: [],
  safeMode: false,
  baseBranch: null,
  reviews: []
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
  if (!mutating || !state.safeMode) return runTool(base)
  if (!(await isGitRepo(state.repoPath))) return runTool(base) // no git -> run normally

  try {
    const { base: from } = await ensureWorkBranch(state.repoPath)
    if (from !== WORK_BRANCH) state.baseBranch = from
  } catch {
    return runTool(base) // couldn't isolate (e.g. dirty conflict) -> run normally
  }

  const before = await statusMap(state.repoPath)
  const res = await runTool(base)
  const after = await statusMap(state.repoPath)
  const changed = changedSince(before, after)
  if (changed.length) {
    try {
      const files = []
      for (const f of changed) files.push({ path: f.path, status: f.status, diff: await diffForFile(state.repoPath, f) })
      await commitFiles(state.repoPath, changed, `tangos: ${tool.id}`)
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

/** Pull the next queued batch for an AI: mark it active, retire the previous active one. */
function pullNextBatch(): Batch | null {
  const idx = state.batches.findIndex((b) => b.status === 'queued')
  if (idx === -1) return null
  for (const b of state.batches) if (b.status === 'active') b.status = 'done'
  state.batches[idx].status = 'active'
  pushState()
  return state.batches[idx]
}

function currentRuntime(): TangosRuntime {
  return state.descriptor?.runtime ?? { cwd: '.', python: 'python', shell: false }
}

// Remember the last-opened repo so tangOS reopens it on launch.
function settingsFile(): string {
  return join(app.getPath('userData'), 'tangos-settings.json')
}
function saveSettings(): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify({ lastRepo: state.repoPath }))
  } catch {
    /* ignore */
  }
}
function loadSettings(): { lastRepo?: string } {
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
    connectedClients: mcp.connectedClients
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
    'CONNECT (MCP over Streamable HTTP):',
    `  URL:          ${url}`,
    `  Claude Code:  ${cliCommand(url)}`,
    '',
    'THEN:',
    '  1. Call next_batch to pull the next queued unit of work. It returns your assigned role (if any), the target functions, and this repo\'s KNOWN WALLS — patterns proven unmatchable; heed them and do not grind them. Loop next_batch to drain the queue; stop when it reports empty.',
    `  2. Drive the toolchain to do the work: ${shown}.`,
    '  3. Every call streams into the human\'s live viewer tagged with your name — skip the narration and just work. If you hit a known wall, say so plainly and move on rather than grinding.',
    proj?.readFirst ? `\nREAD FIRST: ${proj.readFirst}` : null
  ]
  return lines.filter((l) => l !== null).join('\n').trim()
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
    clients: mcp.getClients()
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'tangOS',
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

ipcMain.handle('batch:enqueue', (_e, draft: BatchDraft) => {
  const b: Batch = {
    id: randomUUID(),
    title: (draft.title ?? '').trim() || `Batch ${state.batches.length + 1}`,
    prompt: draft.prompt ?? '',
    items: draft.items ?? [],
    status: 'queued',
    createdAt: Date.now()
  }
  state.batches.push(b)
  pushState()
  return state.batches
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

ipcMain.handle('clients:setRole', (_e, p: { id: string; role: string }) => {
  mcp.setRole(p.id, p.role)
  return mcp.getClients()
})

ipcMain.handle('policy:setSafeMode', (_e, on: boolean) => {
  state.safeMode = !!on
  pushState()
  return state.safeMode
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
ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(text)
  return true
})

// ---- lifecycle ------------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(null) // no native File/Edit/View menu — we use our own chrome
  const saved = loadSettings()
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

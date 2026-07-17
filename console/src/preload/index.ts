import { contextBridge, ipcRenderer } from 'electron'
import type {
  RepoState, McpState, TangosDescriptor, GenerateReport, ActivityEvent, ActivityRun, RunResult, PreflightItem,
  Batch, BatchDraft, BatchItem, AtlasDb, AtlasSource, Review, GithubCredits, ConnectedClient, SecretsInfo,
  AiAgent, RepoUpdateStatus, SyncPreview, AppUpdateInfo, ViewerPrefs, BackgroundPrefs
} from '../shared/types'

type FullState = {
  repo: RepoState
  mcp: McpState
  allowMutations: boolean
  enabledToolIds: string[]
  batches: Batch[]
  safeMode: boolean
  baseBranch: string | null
  reviews: Review[]
  clients: ConnectedClient[]
  agents: AiAgent[]
  reportsEnabled: boolean
  tourSeen: boolean
  updateNoteSeen: string
  useAgents: boolean
  agentFanout: number
  autoLand: boolean
  autoPush: { enabled: boolean; on: boolean; state: 'idle' | 'pushing' | 'ok' | 'error' | 'skipped'; message?: string; prUrl?: string; at?: number }
  looping: string[]
}

const api = {
  getState: (): Promise<FullState> => ipcRenderer.invoke('app:getState'),
  activitySnapshot: (): Promise<ActivityRun[]> => ipcRenderer.invoke('activity:snapshot'),
  preflight: (): Promise<PreflightItem[]> => ipcRenderer.invoke('repo:preflight'),
  atlasLoad: (): Promise<AtlasDb | null> => ipcRenderer.invoke('atlas:load'),
  atlasLoadLive: (force?: boolean): Promise<AtlasDb | null> => ipcRenderer.invoke('atlas:loadLive', force),
  atlasCurrent: (): Promise<AtlasDb | null> => ipcRenderer.invoke('atlas:current'),
  atlasGenerate: (): Promise<AtlasDb | null> => ipcRenderer.invoke('atlas:generate'),
  recentAdds: (sinceHours?: number): Promise<string[]> => ipcRenderer.invoke('atlas:recentAdds', sinceHours),
  atlasSource: (req: { id: string; srcPath?: string }): Promise<AtlasSource | null> =>
    ipcRenderer.invoke('atlas:source', req),
  functionHistory: (req: {
    functionId?: string
    module: string
    addr: number
    name: string
  }): Promise<import('../shared/types').FunctionHistory | null> =>
    ipcRenderer.invoke('atlas:functionHistory', req),
  viewerPrefsGet: (): Promise<ViewerPrefs> => ipcRenderer.invoke('viewer:getPrefs'),
  viewerPrefsSet: (p: Partial<ViewerPrefs>): Promise<ViewerPrefs> => ipcRenderer.invoke('viewer:setPrefs', p),
  bgPrefsGet: (): Promise<BackgroundPrefs> => ipcRenderer.invoke('bg:getPrefs'),
  bgPrefsSet: (p: Partial<BackgroundPrefs>): Promise<BackgroundPrefs> => ipcRenderer.invoke('bg:setPrefs', p),
  matchingPrefsGet: (): Promise<import('../shared/types').MatchingPrefs> =>
    ipcRenderer.invoke('matching:getPrefs'),
  matchingPrefsSet: (
    p: Partial<import('../shared/types').MatchingPrefs>
  ): Promise<import('../shared/types').MatchingPrefs> => ipcRenderer.invoke('matching:setPrefs', p),
  openModulePopout: (module: string): Promise<void> => ipcRenderer.invoke('atlas:popout', module),
  addDraftItem: (item: BatchItem): Promise<void> => ipcRenderer.invoke('draft:addItem', item),
  onDraftAdd: (cb: (item: BatchItem) => void): (() => void) => {
    const l = (_e: unknown, item: BatchItem): void => cb(item)
    ipcRenderer.on('draft:add', l)
    return () => ipcRenderer.removeListener('draft:add', l)
  },
  githubCredits: (): Promise<GithubCredits> => ipcRenderer.invoke('github:credits'),
  // Shared contributor colors (repo-committed login->hex, applied on everyone's Atlas legend/map).
  contributorColors: (): Promise<{ colors: Record<string, string>; you: string | null }> =>
    ipcRenderer.invoke('colors:get'),
  proposeContributorColor: (color: string): Promise<{ ok: boolean; error?: string; prUrl?: string }> =>
    ipcRenderer.invoke('colors:propose', color),

  pickRepo: (): Promise<RepoState> => ipcRenderer.invoke('repo:pick'),
  setRepo: (path: string): Promise<RepoState> => ipcRenderer.invoke('repo:set', path),

  generatePreview: (path?: string): Promise<GenerateReport> =>
    ipcRenderer.invoke('descriptor:generatePreview', path),
  writeDescriptor: (descriptor: TangosDescriptor): Promise<RepoState> =>
    ipcRenderer.invoke('descriptor:write', descriptor),
  reloadDescriptor: (): Promise<RepoState> => ipcRenderer.invoke('descriptor:reload'),
  onDescriptorReloaded: (cb: (info: { toolCount: number; errors: number; reason: string }) => void): (() => void) => {
    const l = (_e: unknown, info: { toolCount: number; errors: number; reason: string }): void => cb(info)
    ipcRenderer.on('descriptor:reloaded', l)
    return () => ipcRenderer.removeListener('descriptor:reloaded', l)
  },
  onDebugDumped: (cb: (dir: string) => void): (() => void) => {
    const l = (_e: unknown, dir: string): void => cb(dir)
    ipcRenderer.on('debug:dumped', l)
    return () => ipcRenderer.removeListener('debug:dumped', l)
  },

  secretsInfo: (): Promise<SecretsInfo> => ipcRenderer.invoke('secrets:info'),
  setSecret: (name: string, value: string): Promise<SecretsInfo> =>
    ipcRenderer.invoke('secrets:set', { name, value }),
  deleteSecret: (name: string): Promise<SecretsInfo> => ipcRenderer.invoke('secrets:delete', name),

  githubSignin: (): Promise<{ userCode: string; verificationUri: string }> =>
    ipcRenderer.invoke('github:signin'),
  onGithubSignedin: (cb: (r: { ok: boolean; error?: string }) => void): (() => void) => {
    const l = (_e: unknown, r: { ok: boolean; error?: string }): void => cb(r)
    ipcRenderer.on('github:signedin', l)
    return () => ipcRenderer.removeListener('github:signedin', l)
  },

  startMcp: (): Promise<McpState> => ipcRenderer.invoke('mcp:start'),
  stopMcp: (): Promise<McpState> => ipcRenderer.invoke('mcp:stop'),
  connect: (): Promise<{ outcomes: unknown[]; cli: string }> => ipcRenderer.invoke('mcp:connect'),
  agentPrompt: (): Promise<string> => ipcRenderer.invoke('mcp:agentPrompt'),

  setMutations: (allow: boolean): Promise<boolean> => ipcRenderer.invoke('policy:setMutations', allow),
  setEnabledTools: (ids: string[]): Promise<string[]> => ipcRenderer.invoke('policy:setEnabledTools', ids),
  setSafeMode: (on: boolean): Promise<boolean> => ipcRenderer.invoke('policy:setSafeMode', on),
  setReports: (on: boolean): Promise<boolean> => ipcRenderer.invoke('policy:setReports', on),
  openReports: (): Promise<string> => ipcRenderer.invoke('reports:open'),
  getTips: (): Promise<{ title: string; body: string }[]> => ipcRenderer.invoke('tips:get'),
  openTips: (): Promise<boolean> => ipcRenderer.invoke('tips:open'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  clearAllStats: (): Promise<boolean> => ipcRenderer.invoke('stats:clearAll'),
  checkAppUpdate: (): Promise<AppUpdateInfo> => ipcRenderer.invoke('app:checkUpdate'),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke('app:quitAndInstall'),
  onAppUpdate: (cb: (info: AppUpdateInfo) => void): (() => void) => {
    const l = (_e: unknown, info: AppUpdateInfo): void => cb(info)
    ipcRenderer.on('app:update', l)
    return () => ipcRenderer.removeListener('app:update', l)
  },
  dumpDebug: (): Promise<string> => ipcRenderer.invoke('debug:dump'),
  openDebug: (): Promise<string> => ipcRenderer.invoke('debug:open'),
  getTour: (): Promise<{ target?: string; title: string; body: string; emotion: string }[]> =>
    ipcRenderer.invoke('tour:get'),
  openTour: (): Promise<boolean> => ipcRenderer.invoke('tour:open'),
  markTourSeen: (): Promise<boolean> => ipcRenderer.invoke('tour:seen'),
  markUpdateNoteSeen: (id: string): Promise<boolean> => ipcRenderer.invoke('tango:noteSeen', id),
  replayTour: (): Promise<boolean> => ipcRenderer.invoke('tour:replay'),
  mergeReview: (): Promise<boolean> => ipcRenderer.invoke('review:merge'),
  discardReview: (): Promise<boolean> => ipcRenderer.invoke('review:discard'),
  setClientRoles: (name: string, roles: string[]): Promise<AiAgent[]> =>
    ipcRenderer.invoke('clients:setRoles', { name, roles }),
  setClientEffort: (name: string, effort: string): Promise<AiAgent[]> =>
    ipcRenderer.invoke('clients:setEffort', { name, effort }),

  generateBatch: (count?: number): Promise<BatchDraft> => ipcRenderer.invoke('batch:generate', count),
  enqueueBatch: (draft: BatchDraft): Promise<Batch[]> => ipcRenderer.invoke('batch:enqueue', draft),
  assignBatch: (draft: BatchDraft, agentName: string): Promise<Batch[]> =>
    ipcRenderer.invoke('batch:assign', { draft, agentName }),
  driveAi: (agentName: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('ai:drive', agentName),
  assignAi: (p: { agent: string; role?: string; count: number; loop?: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ai:assign', p),
  stopAi: (agent: string): Promise<boolean> => ipcRenderer.invoke('ai:stop', agent),
  setUseAgents: (on: boolean): Promise<boolean> => ipcRenderer.invoke('policy:setUseAgents', on),
  setAgentFanout: (n: number): Promise<number> => ipcRenderer.invoke('policy:setAgentFanout', n),
  setAutoLand: (on: boolean): Promise<boolean> => ipcRenderer.invoke('policy:setAutoLand', on),
  setAutoPush: (on: boolean): Promise<boolean> => ipcRenderer.invoke('policy:setAutoPush', on),
  removeBatch: (id: string): Promise<Batch[]> => ipcRenderer.invoke('batch:remove', id),
  clearQueue: (agentName: string): Promise<Batch[]> => ipcRenderer.invoke('batch:clearQueue', agentName),
  cancelGen: (): Promise<boolean> => ipcRenderer.invoke('batch:cancelGen'),
  onGenOutput: (cb: (tail: string) => void): (() => void) => {
    const l = (_e: unknown, tail: string): void => cb(tail)
    ipcRenderer.on('gen:output', l)
    return () => ipcRenderer.removeListener('gen:output', l)
  },
  reorderBatch: (id: string, dir: 'up' | 'down'): Promise<Batch[]> =>
    ipcRenderer.invoke('batch:reorder', { id, dir }),
  clearDoneBatches: (): Promise<Batch[]> => ipcRenderer.invoke('batch:clearDone'),
  runTool: (toolId: string, values: Record<string, unknown>): Promise<RunResult> =>
    ipcRenderer.invoke('tool:run', { toolId, values }),

  cloneRepo: (url: string, dest: string): Promise<{ ok: boolean; output: string; code?: number }> =>
    ipcRenderer.invoke('repo:clone', { url, dest }),
  cloneAndOpen: (url: string): Promise<{ ok: boolean; error?: string; canceled?: boolean; repo?: RepoState }> =>
    ipcRenderer.invoke('repo:cloneAndOpen', url),
  repoUpdateStatus: (): Promise<RepoUpdateStatus> => ipcRenderer.invoke('repo:updateStatus'),
  repoPull: (): Promise<{ ok: boolean; err?: string; behind?: number; note?: string }> =>
    ipcRenderer.invoke('repo:pull'),
  onRepoPullProgress: (cb: (p: { label: string; pct: number }) => void): (() => void) => {
    const l = (_e: unknown, p: { label: string; pct: number }): void => cb(p)
    ipcRenderer.on('repo:pullProgress', l)
    return () => ipcRenderer.removeListener('repo:pullProgress', l)
  },
  repoPushWorkPr: (): Promise<{ ok: boolean; url?: string; error?: string }> => ipcRenderer.invoke('repo:pushWorkPr'),
  // Hard "Sync repo" (reset to origin + clean): preview, optional backup, then the destructive run.
  repoSyncPreview: (): Promise<SyncPreview> => ipcRenderer.invoke('repo:syncPreview'),
  repoBackup: (): Promise<{ ok: boolean; path?: string; files?: number; bundle?: boolean; error?: string }> =>
    ipcRenderer.invoke('repo:backup'),
  repoSync: (): Promise<{ ok: boolean; branch?: string; head?: string; error?: string }> =>
    ipcRenderer.invoke('repo:sync'),
  onRepoSyncProgress: (cb: (p: { label: string; pct: number }) => void): (() => void) => {
    const l = (_e: unknown, p: { label: string; pct: number }): void => cb(p)
    ipcRenderer.on('repo:syncProgress', l)
    return () => ipcRenderer.removeListener('repo:syncProgress', l)
  },

  minimizeWin: (): Promise<void> => ipcRenderer.invoke('win:minimize'),
  maximizeToggle: (): Promise<boolean> => ipcRenderer.invoke('win:maximizeToggle'),
  closeWin: (): Promise<void> => ipcRenderer.invoke('win:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:isMaximized'),
  onMaximizeChange: (cb: (v: boolean) => void): (() => void) => {
    const l = (_e: unknown, v: boolean): void => cb(v)
    ipcRenderer.on('win:maximized', l)
    return () => ipcRenderer.removeListener('win:maximized', l)
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:openPath', p),
  revealPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:revealPath', p),
  pickBugScreenshots: (): Promise<string[]> => ipcRenderer.invoke('bug:pickScreenshots'),
  saveBugImage: (bytes: number[], ext: string): Promise<string | null> =>
    ipcRenderer.invoke('bug:saveImage', bytes, ext),
  submitBug: (p: { description: string; screenshots: string[] }): Promise<{ folder: string }> =>
    ipcRenderer.invoke('bug:submit', p),
  copy: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text),

  onActivity: (cb: (ev: ActivityEvent) => void): (() => void) => {
    const listener = (_e: unknown, ev: ActivityEvent): void => cb(ev)
    ipcRenderer.on('activity', listener)
    return () => ipcRenderer.removeListener('activity', listener)
  },
  onState: (cb: (s: FullState) => void): (() => void) => {
    const listener = (_e: unknown, s: FullState): void => cb(s)
    ipcRenderer.on('state', listener)
    return () => ipcRenderer.removeListener('state', listener)
  }
}

contextBridge.exposeInMainWorld('tangos', api)

export type TangosApi = typeof api

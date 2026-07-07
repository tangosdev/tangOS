import { contextBridge, ipcRenderer } from 'electron'
import type {
  RepoState, McpState, TangosDescriptor, GenerateReport, ActivityEvent, ActivityRun, RunResult, PreflightItem,
  Batch, BatchDraft, BatchItem, AtlasDb, Review, ClaimsResult, ClaimsList, GithubCredits, ConnectedClient, SecretsInfo
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
}

const api = {
  getState: (): Promise<FullState> => ipcRenderer.invoke('app:getState'),
  activitySnapshot: (): Promise<ActivityRun[]> => ipcRenderer.invoke('activity:snapshot'),
  preflight: (): Promise<PreflightItem[]> => ipcRenderer.invoke('repo:preflight'),
  atlasLoad: (): Promise<AtlasDb | null> => ipcRenderer.invoke('atlas:load'),
  atlasLoadLive: (force?: boolean): Promise<AtlasDb | null> => ipcRenderer.invoke('atlas:loadLive', force),
  atlasCurrent: (): Promise<AtlasDb | null> => ipcRenderer.invoke('atlas:current'),
  atlasGenerate: (): Promise<AtlasDb | null> => ipcRenderer.invoke('atlas:generate'),
  claimsCheck: (module: string, start: string, end: string): Promise<ClaimsResult | null> =>
    ipcRenderer.invoke('claims:check', { module, start, end }),
  claimsList: (): Promise<ClaimsList> => ipcRenderer.invoke('claims:list'),
  claimsLock: (p: { module: string; start: string; end: string; note?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('claims:lock', p),
  claimsRelease: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('claims:release', id),
  openModulePopout: (module: string): Promise<void> => ipcRenderer.invoke('atlas:popout', module),
  addDraftItem: (item: BatchItem): Promise<void> => ipcRenderer.invoke('draft:addItem', item),
  onDraftAdd: (cb: (item: BatchItem) => void): (() => void) => {
    const l = (_e: unknown, item: BatchItem): void => cb(item)
    ipcRenderer.on('draft:add', l)
    return () => ipcRenderer.removeListener('draft:add', l)
  },
  githubCredits: (): Promise<GithubCredits> => ipcRenderer.invoke('github:credits'),

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

  secretsInfo: (): Promise<SecretsInfo> => ipcRenderer.invoke('secrets:info'),
  setSecret: (name: string, value: string): Promise<SecretsInfo> =>
    ipcRenderer.invoke('secrets:set', { name, value }),
  deleteSecret: (name: string): Promise<SecretsInfo> => ipcRenderer.invoke('secrets:delete', name),

  startMcp: (): Promise<McpState> => ipcRenderer.invoke('mcp:start'),
  stopMcp: (): Promise<McpState> => ipcRenderer.invoke('mcp:stop'),
  connect: (): Promise<{ outcomes: unknown[]; cli: string }> => ipcRenderer.invoke('mcp:connect'),
  agentPrompt: (): Promise<string> => ipcRenderer.invoke('mcp:agentPrompt'),

  setMutations: (allow: boolean): Promise<boolean> => ipcRenderer.invoke('policy:setMutations', allow),
  setEnabledTools: (ids: string[]): Promise<string[]> => ipcRenderer.invoke('policy:setEnabledTools', ids),
  setSafeMode: (on: boolean): Promise<boolean> => ipcRenderer.invoke('policy:setSafeMode', on),
  mergeReview: (): Promise<boolean> => ipcRenderer.invoke('review:merge'),
  discardReview: (): Promise<boolean> => ipcRenderer.invoke('review:discard'),
  setClientRole: (id: string, role: string): Promise<ConnectedClient[]> =>
    ipcRenderer.invoke('clients:setRole', { id, role }),

  generateBatch: (count?: number): Promise<BatchDraft> => ipcRenderer.invoke('batch:generate', count),
  enqueueBatch: (draft: BatchDraft): Promise<Batch[]> => ipcRenderer.invoke('batch:enqueue', draft),
  removeBatch: (id: string): Promise<Batch[]> => ipcRenderer.invoke('batch:remove', id),
  reorderBatch: (id: string, dir: 'up' | 'down'): Promise<Batch[]> =>
    ipcRenderer.invoke('batch:reorder', { id, dir }),
  clearDoneBatches: (): Promise<Batch[]> => ipcRenderer.invoke('batch:clearDone'),
  runTool: (toolId: string, values: Record<string, unknown>): Promise<RunResult> =>
    ipcRenderer.invoke('tool:run', { toolId, values }),

  cloneRepo: (url: string, dest: string): Promise<{ ok: boolean; output: string; code?: number }> =>
    ipcRenderer.invoke('repo:clone', { url, dest }),
  cloneAndOpen: (url: string): Promise<{ ok: boolean; error?: string; canceled?: boolean; repo?: RepoState }> =>
    ipcRenderer.invoke('repo:cloneAndOpen', url),

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

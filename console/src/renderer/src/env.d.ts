/// <reference types="vite/client" />
import type {
  RepoState, McpState, TangosDescriptor, GenerateReport, ActivityEvent, ActivityRun, RunResult, PreflightItem,
  Batch, BatchDraft, BatchItem, AtlasDb, AtlasSource, Review, GithubCredits, ConnectedClient, SecretsInfo,
  AiAgent, RepoUpdateStatus, SyncPreview, AppUpdateInfo, ViewerPrefs, BackgroundPrefs
} from '../../shared/types'

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

interface RegisterOutcome {
  target: string
  path: string
  action: 'added' | 'updated' | 'unchanged' | 'error'
  message?: string
}

export interface TangosApi {
  getState(): Promise<FullState>
  activitySnapshot(): Promise<ActivityRun[]>
  preflight(): Promise<PreflightItem[]>
  atlasLoad(): Promise<AtlasDb | null>
  atlasLoadLive(force?: boolean): Promise<AtlasDb | null>
  atlasCurrent(): Promise<AtlasDb | null>
  atlasGenerate(): Promise<AtlasDb | null>
  recentAdds(sinceHours?: number): Promise<string[]>
  atlasSource(req: { id: string; srcPath?: string }): Promise<AtlasSource | null>
  functionHistory(req: {
    functionId?: string
    module: string
    addr: number
    name: string
  }): Promise<import('../../shared/types').FunctionHistory | null>
  viewerPrefsGet(): Promise<ViewerPrefs>
  viewerPrefsSet(p: Partial<ViewerPrefs>): Promise<ViewerPrefs>
  bgPrefsGet(): Promise<BackgroundPrefs>
  bgPrefsSet(p: Partial<BackgroundPrefs>): Promise<BackgroundPrefs>
  matchingPrefsGet(): Promise<import('../../shared/types').MatchingPrefs>
  matchingPrefsSet(
    p: Partial<import('../../shared/types').MatchingPrefs>
  ): Promise<import('../../shared/types').MatchingPrefs>
  openModulePopout(module: string): Promise<void>
  addDraftItem(item: BatchItem): Promise<void>
  onDraftAdd(cb: (item: BatchItem) => void): () => void
  githubCredits(): Promise<GithubCredits>
  contributorColors(): Promise<{ colors: Record<string, string>; you: string | null }>
  proposeContributorColor(color: string): Promise<{ ok: boolean; error?: string; prUrl?: string }>
  githubSignin(): Promise<{ userCode: string; verificationUri: string }>
  onGithubSignedin(cb: (r: { ok: boolean; error?: string }) => void): () => void
  pickRepo(): Promise<RepoState>
  setRepo(path: string): Promise<RepoState>
  generatePreview(path?: string): Promise<GenerateReport>
  writeDescriptor(descriptor: TangosDescriptor): Promise<RepoState>
  reloadDescriptor(): Promise<RepoState>
  onDescriptorReloaded(cb: (info: { toolCount: number; errors: number; reason: string }) => void): () => void
  onDebugDumped(cb: (dir: string) => void): () => void
  secretsInfo(): Promise<SecretsInfo>
  setSecret(name: string, value: string): Promise<SecretsInfo>
  deleteSecret(name: string): Promise<SecretsInfo>
  startMcp(): Promise<McpState>
  stopMcp(): Promise<McpState>
  connect(): Promise<{ outcomes: RegisterOutcome[]; cli: string }>
  agentPrompt(): Promise<string>
  setMutations(allow: boolean): Promise<boolean>
  setEnabledTools(ids: string[]): Promise<string[]>
  setSafeMode(on: boolean): Promise<boolean>
  setReports(on: boolean): Promise<boolean>
  openReports(): Promise<string>
  getTips(): Promise<{ title: string; body: string }[]>
  openTips(): Promise<boolean>
  appVersion(): Promise<string>
  clearAllStats(): Promise<boolean>
  checkAppUpdate(): Promise<AppUpdateInfo>
  quitAndInstall(): Promise<void>
  onAppUpdate(cb: (info: AppUpdateInfo) => void): () => void
  dumpDebug(): Promise<string>
  openDebug(): Promise<string>
  getTour(): Promise<{ target?: string; title: string; body: string; emotion: string }[]>
  openTour(): Promise<boolean>
  markTourSeen(): Promise<boolean>
  markUpdateNoteSeen(id: string): Promise<boolean>
  replayTour(): Promise<boolean>
  mergeReview(): Promise<boolean>
  discardReview(): Promise<boolean>
  setClientRoles(name: string, roles: string[]): Promise<AiAgent[]>
  setClientEffort(name: string, effort: string): Promise<AiAgent[]>
  generateBatch(count?: number): Promise<BatchDraft>
  enqueueBatch(draft: BatchDraft): Promise<Batch[]>
  assignBatch(draft: BatchDraft, agentName: string): Promise<Batch[]>
  driveAi(agentName: string): Promise<{ ok: boolean }>
  assignAi(p: { agent: string; role?: string; count: number; loop?: boolean }): Promise<{ ok: boolean }>
  stopAi(agent: string): Promise<boolean>
  setUseAgents(on: boolean): Promise<boolean>
  setAgentFanout(n: number): Promise<number>
  setAutoLand(on: boolean): Promise<boolean>
  setAutoPush(on: boolean): Promise<boolean>
  removeBatch(id: string): Promise<Batch[]>
  clearQueue(agentName: string): Promise<Batch[]>
  cancelGen(): Promise<boolean>
  onGenOutput(cb: (tail: string) => void): () => void
  reorderBatch(id: string, dir: 'up' | 'down'): Promise<Batch[]>
  clearDoneBatches(): Promise<Batch[]>
  runTool(toolId: string, values: Record<string, unknown>): Promise<RunResult>
  cloneRepo(url: string, dest: string): Promise<{ ok: boolean; output: string; code?: number }>
  cloneAndOpen(url: string): Promise<{ ok: boolean; error?: string; canceled?: boolean; repo?: RepoState }>
  repoUpdateStatus(): Promise<RepoUpdateStatus>
  repoPull(): Promise<{ ok: boolean; err?: string; behind?: number; note?: string }>
  onRepoPullProgress(cb: (p: { label: string; pct: number }) => void): () => void
  repoPushWorkPr(): Promise<{ ok: boolean; url?: string; error?: string }>
  repoSyncPreview(): Promise<SyncPreview>
  repoBackup(): Promise<{ ok: boolean; path?: string; files?: number; bundle?: boolean; error?: string }>
  repoSync(): Promise<{ ok: boolean; branch?: string; head?: string; error?: string }>
  onRepoSyncProgress(cb: (p: { label: string; pct: number }) => void): () => void
  minimizeWin(): Promise<void>
  maximizeToggle(): Promise<boolean>
  closeWin(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizeChange(cb: (v: boolean) => void): () => void
  openExternal(url: string): Promise<void>
  openPath(p: string): Promise<string>
  revealPath(p: string): Promise<string>
  pickBugScreenshots(): Promise<string[]>
  saveBugImage(bytes: number[], ext: string): Promise<string | null>
  submitBug(p: { description: string; screenshots: string[] }): Promise<{ folder: string }>
  copy(text: string): Promise<boolean>
  onActivity(cb: (ev: ActivityEvent) => void): () => void
  onState(cb: (s: FullState) => void): () => void
}

declare global {
  interface Window {
    tangos: TangosApi
  }
}

/// <reference types="vite/client" />
import type {
  RepoState, McpState, TangosDescriptor, GenerateReport, ActivityEvent, ActivityRun, RunResult, PreflightItem,
  Batch, BatchDraft, BatchItem, AtlasDb, Review, ClaimsResult, ClaimsList, GithubCredits, ConnectedClient, SecretsInfo,
  AiAgent
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
  useAgents: boolean
  autoLand: boolean
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
  claimsCheck(module: string, start: string, end: string): Promise<ClaimsResult | null>
  claimsList(): Promise<ClaimsList>
  claimsLock(p: { module: string; start: string; end: string; note?: string }): Promise<{ ok: boolean; error?: string }>
  claimsRelease(id: string): Promise<{ ok: boolean; error?: string }>
  openModulePopout(module: string): Promise<void>
  addDraftItem(item: BatchItem): Promise<void>
  onDraftAdd(cb: (item: BatchItem) => void): () => void
  githubCredits(): Promise<GithubCredits>
  githubSignin(): Promise<{ userCode: string; verificationUri: string }>
  onGithubSignedin(cb: (r: { ok: boolean; error?: string }) => void): () => void
  pickRepo(): Promise<RepoState>
  setRepo(path: string): Promise<RepoState>
  generatePreview(path?: string): Promise<GenerateReport>
  writeDescriptor(descriptor: TangosDescriptor): Promise<RepoState>
  reloadDescriptor(): Promise<RepoState>
  onDescriptorReloaded(cb: (info: { toolCount: number; errors: number; reason: string }) => void): () => void
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
  markTourSeen(): Promise<boolean>
  replayTour(): Promise<boolean>
  mergeReview(): Promise<boolean>
  discardReview(): Promise<boolean>
  setClientRoles(name: string, roles: string[]): Promise<AiAgent[]>
  generateBatch(count?: number): Promise<BatchDraft>
  enqueueBatch(draft: BatchDraft): Promise<Batch[]>
  assignBatch(draft: BatchDraft, agentName: string): Promise<Batch[]>
  driveAi(agentName: string): Promise<{ ok: boolean }>
  assignAi(p: { agent: string; role?: string; count: number; loop?: boolean }): Promise<{ ok: boolean }>
  stopAi(agent: string): Promise<boolean>
  setUseAgents(on: boolean): Promise<boolean>
  setAutoLand(on: boolean): Promise<boolean>
  removeBatch(id: string): Promise<Batch[]>
  reorderBatch(id: string, dir: 'up' | 'down'): Promise<Batch[]>
  clearDoneBatches(): Promise<Batch[]>
  runTool(toolId: string, values: Record<string, unknown>): Promise<RunResult>
  cloneRepo(url: string, dest: string): Promise<{ ok: boolean; output: string; code?: number }>
  cloneAndOpen(url: string): Promise<{ ok: boolean; error?: string; canceled?: boolean; repo?: RepoState }>
  minimizeWin(): Promise<void>
  maximizeToggle(): Promise<boolean>
  closeWin(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizeChange(cb: (v: boolean) => void): () => void
  openExternal(url: string): Promise<void>
  openPath(p: string): Promise<string>
  revealPath(p: string): Promise<string>
  copy(text: string): Promise<boolean>
  onActivity(cb: (ev: ActivityEvent) => void): () => void
  onState(cb: (s: FullState) => void): () => void
}

declare global {
  interface Window {
    tangos: TangosApi
  }
}

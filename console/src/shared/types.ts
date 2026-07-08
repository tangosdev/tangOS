// Types shared between the Electron main process and the renderer.
// The descriptor types mirror schema/tangos.schema.json.

export interface TangosArg {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum'
  flag?: string
  positional?: boolean
  required?: boolean
  default?: unknown
  choices?: unknown[]
  description?: string
}

export interface TangosTool {
  id: string
  label?: string
  category?: string
  description?: string
  docs?: string
  readOnly: boolean
  command: string
  apply?: string
  longRunning?: boolean
  needs?: string[]
  args?: TangosArg[]
}

export interface TangosCategory {
  id: string
  label?: string
  order?: number
  description?: string
}

export interface TangosProject {
  name: string
  title: string
  tagline?: string
  github?: string
  githubClientId?: string // optional OAuth app client_id for the "Sign into GitHub" device flow
  language?: string
  platform?: string
  compiler?: string
  cppNote?: string
  discord?: string
  setup?: string
  verifyCommand?: string
  readFirst?: string
  rules?: string
  nearMissNote?: string
  knownWalls?: string // proven-unreachable shapes; surfaced to connected AIs via next_batch
}

export interface EnvKeyHelp {
  note?: string
  url?: string // where to create/obtain the key
}

export interface TangosRuntime {
  cwd?: string
  python?: string
  shell?: boolean
  envKeys?: string[]
  envKeyHelp?: Record<string, EnvKeyHelp>
}

export interface TangosRequirements {
  rom?: boolean
  compiler?: string
  pythonPackages?: string[]
  notes?: string
}

export interface TangosData {
  generate?: string
  dbPath?: string
  committedDbUrl?: string
  claimsApi?: string
}

export interface ClaimsResult {
  ok: boolean
  free?: boolean
  conflicts?: Array<{ handle?: string; note?: string; module?: string; start?: string; end?: string }>
  error?: string | number
}

export interface Claim {
  id: string
  module: string
  start: string
  end: string
  handle: string
  note?: string
  expiresAt?: string
}

export interface ClaimsList {
  claims: Claim[]
  whoami: { hasKey: boolean; handle: string }
}

export interface GithubCredits {
  logins: { login: string; contributions: number }[]
  keyToLogin: Record<string, string>
  prAuthors: string[]
}

export interface TangosDescriptor {
  tangosVersion: string
  project: TangosProject
  runtime?: TangosRuntime
  requirements?: TangosRequirements
  data?: TangosData
  categories?: TangosCategory[]
  tools: TangosTool[]
}

// ---- runtime state --------------------------------------------------------

export interface RepoState {
  path: string | null
  descriptor: TangosDescriptor | null
  descriptorPath: string | null
  hasDescriptor: boolean
  validationErrors: string[]
  isGit: boolean // false = not a git checkout (e.g. a "Download ZIP" snapshot): can't commit, tooling may be stale
}

export interface McpState {
  running: boolean
  port: number | null
  url: string | null
  connectedClients: number
  requestsSeen: number
  lastContactAt: number | null
}

// ---- live activity events -------------------------------------------------

export type RunStatus = 'running' | 'ok' | 'error' | 'blocked'

export interface ActivityRun {
  runId: string
  toolId: string
  label: string
  readOnly: boolean
  mutating: boolean
  args: Record<string, unknown>
  commandPreview: string
  source: 'ai' | 'user'
  client?: { name: string; role?: string } // which connected AI made this call
  batchId?: string // the batch this run belongs to, when driven from an assigned batch
  startedAt: number
  finishedAt?: number
  status: RunStatus
  exitCode?: number | null
  output: string // accumulated stdout+stderr (renderer keeps a capped tail)
  note?: string
}

// ---- connected AIs (multi-agent orchestration) ----------------------------

export interface ConnectedClient {
  id: string
  name: string
  roles: string[] // an AI can hold several roles at once (e.g. main matcher + verifier)
  connectedAt: number
  emptyPolls?: number // consecutive empty next_batch polls, for the idle stop signal
}

/** Built-in agent roles, each with standing instructions injected into next_batch. */
export const ROLE_PRESETS: Record<string, string> = {
  'Main matcher':
    'You are the MAIN MATCHER. Schedule with coddog/worklist, write C, verify with match/fdiff, and bank confirmed byte matches. Favor breadth and steady throughput.',
  'Long sweep':
    'You are the LONG SWEEP. Take on the large/hard functions others skip. Run the sweep/clone/paramclone tiers and grind near-misses patiently with the refine tools.',
  'Draft checker':
    'You are the DRAFT CHECKER. Pull near-misses, diagnose the exact divergences with diffcand/falign, and produce closer compiling drafts for the matchers to finish.',
  'Verifier':
    'You are the VERIFIER. Run linkcheck and reloc_audit over recently banked matches and flag anything WRONG/BLIND. Do not bank; only verify and report.',
  'Explorer':
    'You are the EXPLORER. Survey unmatched functions with triage/cluster/recurring/coloring and surface high-value targets and idioms worth templatizing.'
}
export const ROLE_NAMES = ['Unassigned', ...Object.keys(ROLE_PRESETS)]

export type ActivityEvent =
  | { kind: 'run-started'; run: ActivityRun }
  | { kind: 'run-output'; runId: string; chunk: string; stream: 'stdout' | 'stderr' }
  | { kind: 'run-finished'; runId: string; status: RunStatus; exitCode: number | null; finishedAt: number }

export interface RunResult {
  runId: string
  status: RunStatus
  exitCode: number | null
  output: string
}

export interface PreflightItem {
  id: string
  label: string
  ok: boolean
  detail: string
}

// ---- secure API-key vault (for tools that call an HTTP API, not MCP) --------

export interface SecretMeta {
  name: string
  hint: string // masked preview, e.g. "…a1b2"
  updatedAt: number
}

export interface SecretsInfo {
  available: boolean // OS secure storage present (else keys can't be stored)
  secrets: SecretMeta[]
  declared: string[] // env keys the descriptor's tools expect (runtime.envKeys)
  help: Record<string, EnvKeyHelp> // per-key guidance (what it's for, where to get it)
}

// ---- batches (the work an AI loop pulls via the next_batch MCP tool) --------

export interface BatchItem {
  id: string
  ref: string // function name, or "module:0xaddr"
  label?: string
  // Resolved metadata captured when added from the Atlas, so next_batch can hand the
  // agent a ready-to-run verify call instead of making it guess required args.
  module?: string
  addr?: number
  size?: number
  srcPath?: string
  targetHex?: string // ROM target bytes (from the scheduler) so a console-driven worklist is complete
  done?: boolean // set true once this target byte-matches (drives batch % complete)
}

export type BatchStatus = 'queued' | 'active' | 'done'

export interface Batch {
  id: string
  title: string
  prompt: string
  items: BatchItem[]
  status: BatchStatus
  createdAt: number
  targetAgent?: string // addressed to one AI by name; only that AI's next_batch/drive gets it
}

/** A batch draft composed in the UI before it is enqueued. */
export interface BatchDraft {
  title: string
  prompt: string
  items: BatchItem[]
}

/** Soft cap: past this many targets, one batch's prompt is likely too big for a turn. */
export const BATCH_SOFT_CAP = 16

// ---- AI controller (the per-AI boxes in the Chaos Controller) ---------------

export type AiKind = 'mcp' | 'api'

/** Operator-facing stats for one AI. Derived from tool activity (matches, hit rate)
 *  and, for console-driven API AIs, the driver's reported token usage. */
export interface AiStats {
  totalMatches: number
  matchAttempts: number
  nearMisses?: number // compiling non-matches that produced a real byte-diff (close attempts)
  hitRate: number // 0..1 = totalMatches / matchAttempts
  tokensIn?: number // API-driven AIs only; undefined for external MCP AIs
  tokensOut?: number
  tokensPerMatch?: number
  currentTask?: string // label of the current run / assigned batch
  progress?: { done: number; total: number } // completion on the current batch
  // size-bucket -> tallies, for the "good at" recommendation (e.g. "<=0x40", "0x40-0x200", ">0x800")
  bySize?: Record<string, { attempts: number; matches: number }>
}

/** A persistent AI in the controller: either an MCP client that connected, or a
 *  provider we hold an API key for. Boxes stay on screen (grayed) after disconnect. */
export interface AiAgent {
  name: string
  kind: AiKind
  provider?: string // api AIs: 'Claude' | 'GLM' | 'DeepSeek'
  roles: string[] // zero or more assigned roles
  effort?: string // reasoning-effort level; valid values depend on the model family (see efforts.ts)
  connected: boolean // mcp: a live session exists; api: currently driving a batch
  sessions?: number // mcp: number of live sessions collapsed under this name
  currentBatchId?: string
  lastSeen?: number
  stats: AiStats
}

// ---- Atlas (Chaos Viewer) data ---------------------------------------------

export interface AtlasFunction {
  id: string
  module: string
  name: string
  addr: number
  size: number
  matched: boolean
  srcPath?: string
  author?: string
  div?: number
  cat?: string
  floor?: string
  sim?: number
  sibling?: string
}

export interface AtlasStats {
  totalFunctions: number
  matchedFunctions: number
  totalBytes: number
  matchedBytes: number
  moduleCount: number
}

export interface AtlasDb {
  generatedAt?: string
  stats: AtlasStats
  functions: AtlasFunction[]
}

// ---- safe writes (dedicated work branch + diff review) ---------------------

export interface ReviewFile {
  path: string
  status: 'new' | 'modified'
  diff: string
}

export interface Review {
  id: string
  toolId: string
  label: string
  createdAt: number
  base: string
  files: ReviewFile[]
}

// ---- generate -------------------------------------------------------------

export interface GenerateReport {
  descriptor: TangosDescriptor
  detected: string[]   // human-readable notes about what was detected
  wrotePath: string | null
}

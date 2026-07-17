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

/**
 * Optional matching conventions a decomp can declare so Console / next_batch
 * surface attempt-tree logging, near-miss tips, and Ghidra scaffolds (the same
 * extras the experimental Chaos Viewer fork adds on top of classic prompts).
 * All fields optional; classic SM64DS-style repos work without this block.
 */
export interface TangosMatchConventions {
  /** Emit attempt-tree / MATCH_RESULT logging rules to connected AIs. */
  attemptTree?: boolean
  /** Append-only attempt log path (default config/match_attempts.jsonl). */
  attemptsPath?: string
  /** Final how-record path on bank (default config/match_provenance.jsonl). */
  provenancePath?: string
  /** Encourage Ghidra scaffolds under ghidra_out/ as draft hints only. */
  ghidraDrafts?: boolean
  /** Near-miss tip store (default nearmiss/db.jsonl). */
  nearMissDb?: string
  /**
   * Prefill matchProvenance on attempt-tree nodes (slugs, not display names).
   * Same idea as Chaos Viewer's model / reasoning / harness pickers.
   */
  defaultProvenance?: {
    model?: string
    reasoning?: string
    harness?: string
  }
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
  submitting?: string // how to open a PR (format, what may land in src/); surfaced at MCP startup + in next_batch
  nearMissNote?: string
  knownWalls?: string // proven-unreachable shapes; surfaced to connected AIs via next_batch
  /** Experimental / extended matching conventions (attempt tree, Ghidra, near-miss DB). */
  matchConventions?: TangosMatchConventions
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

/** Whether the local checkout is behind the remote - drives the "your local is out of date"
 *  banner and its one-click fast-forward Update. */
export interface RepoUpdateStatus {
  isGit: boolean
  branch?: string
  defaultBranch?: string
  ahead?: number // local commits not on origin by SHA (a squash-merged commit still counts here)
  unmergedAhead?: number // local commits whose CHANGES aren't upstream yet - the real "unpublished" count
  behind?: number
  dirty?: boolean // uncommitted/untracked work present (informational; ff-pull never clobbers it)
  fetched?: boolean // false = couldn't reach origin (offline / no remote), so behind may be stale
  error?: string
}

/** What a hard "Sync repo" (reset to origin + clean) would throw away, so the confirm is concrete. */
export interface SyncPreview {
  branch: string
  defaultBranch: string
  behind: number // new upstream commits you'd gain
  ahead: number // local commits on this branch that a reset would discard
  localChanges: number // tracked files modified/staged that a hard reset would revert
  untracked: number // untracked non-ignored files that clean -fd would remove (setup files are kept)
  error?: string
}

/** App auto-update state, surfaced in the top banner so a running install can tell a newer
 *  release is out. 'dev' = unpackaged (the updater is a no-op there); 'none' = up to date;
 *  'error' = the check failed (offline, rate-limited, or no releases yet). */
export type AppUpdateInfo =
  | { state: 'available' | 'downloaded'; version: string }
  | { state: 'none' | 'dev' | 'error' }

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

/** Built-in agent roles, each with standing instructions injected into next_batch. A two-stage
 *  matching pipeline (Drafter -> Refiner) plus a hard-function role and a random-breadth one. */
export const ROLE_PRESETS: Record<string, string> = {
  'Hard matcher':
    'You are the HARD MATCHER. Take the large, hard functions others skip and drive each all the way to a byte match, end to end. Write C from the disasm, callees, pool slots, and signatures; run the heavy tiers (sweep/clone/paramclone) and the refine tools; verify with match/fdiff; bank confirmed byte matches. This is the deep-water role - work each one patiently. If MATCH LOGGING is on for this repo, log every try as a MATCH_RESULT node (SHARED DEFAULTS from next_batch).',
  'Drafter':
    'You are the DRAFTER (stage 1 of the pipeline). Your batch is unmatched functions that have a similar MATCHED sibling to lean on. Adapt that sibling into a close, COMPILING draft for each target - get it as near as you can. You do NOT have to land byte-exact: bank each near-miss draft to the near-miss tip store (nearmiss/db.jsonl via nearmiss tools or tools/nearmiss_db.py) so the Refiner can finish it. Favor volume of good drafts over grinding any single function. Log tries when MATCH LOGGING is on; usedNearMissDraft when you lean on a tip.',
  'Refiner':
    'You are the REFINER (stage 2 of the pipeline). Pull near-misses that already carry a draft, diagnose the exact divergences with fdiff (and falign if available), and refine each draft to a byte-exact match. You have the most to work with - a compiling draft plus the verifier diff - so nudge codegen SHAPE (declaration/statement order, types, register coloring) rather than rewriting. Bank confirmed byte matches. Keep the attempt tree linked (parentAttemptId = the tip you forked).',
  'Random':
    'You are the RANDOM MATCHER. Your batch is unmatched functions drawn uniformly at random from across the whole ROM - any size, any module, no similarity hint. For each, study the disasm, callees, pool slots, and signatures, write C, and verify with match/fdiff. Give each about 5 attempts with DIFFERENT levers; if it has not matched by then, move on rather than grinding. Bank confirmed byte matches. Log every try when MATCH LOGGING is on. This role samples the whole unmatched pool for breadth - on an infinite loop you get a fresh random draw each batch.'
}
/** Rough model-strength each role wants, shown in the assign-role dropdown so the operator parks the
 *  right model: your strongest on the hardest role, a cheap/local model where there's the most
 *  scaffolding. Each tier names a reference model so "low/high" reads as reasoning/skill, not a guess.
 *  Display-only - never injected into the agent's instructions; edit the reference models freely. */
export const ROLE_STRENGTH: Record<string, string> = {
  'Hard matcher': 'very high, Fable 5+',
  'Random': 'high, Sonnet 5 / Grok',
  'Drafter': 'medium, DeepSeek',
  'Refiner': 'low, GLM / Nemotron'
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
  fix?: string // when !ok: one plain sentence saying how to fix it
  fixCmd?: string // when !ok: a ready-to-copy command that does the fix (if one exists)
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
  worked?: boolean // set true once an agent has ATTEMPTED this target (match run, hit or miss); drives
  // the "N in queue" count down as targets are worked, distinct from `done` (verified match only)
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
  note?: string // operator-facing warning shown on the box (e.g. landed short - clone behind)
  activatedAt?: number // when it went active (guards the stuck-batch retire against churn)
  pulledBy?: string // which agent pulled it active (guards retire against cross-agent clobber)
}

/** A batch draft composed in the UI before it is enqueued. */
export interface BatchDraft {
  title: string
  prompt: string
  items: BatchItem[]
  note?: string // set by genDraft when the batch came up short of the requested count
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
 *  provider we hold an API key for. Boxes stay on screen after disconnect; the presence
 *  dot decays green -> yellow -> red by time since the last signal (see lastSeen). */
export interface AiAgent {
  name: string
  kind: AiKind
  provider?: string // api AIs: 'Claude' | 'GLM' | 'DeepSeek'
  roles: string[] // zero or more assigned roles
  effort?: string // reasoning-effort level; valid values depend on the model family (see efforts.ts)
  connected: boolean // mcp: a live session exists; api: currently driving a batch
  sessions?: number // mcp: number of live sessions collapsed under this name
  currentBatchId?: string
  lastSeen?: number // ms of this agent's last MCP request (any tool call OR next_batch poll). Persists
  // across disconnect so the dot can show yellow for up to an hour, then red. undefined = never seen.
  stats: AiStats // all-time tallies
  run?: AiStats // current-run-only tallies (zeroed each app launch)
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

/** Source lines for one function, shown inside the selected tile at dive zoom.
 *  kind 'src' = the matched/draft .c/.cpp read from the repo; 'disasm' = a
 *  disassembly text field the chaos-db generator may attach to unmatched rows. */
export interface AtlasSource {
  lines: string[]
  truncated: boolean
  kind: 'src' | 'disasm'
  path?: string
}

/** Prior tries for one Atlas function (from match_attempts + nearmiss tip). No C bodies. */
export interface AttemptNodeSummary {
  attemptId: string
  parentAttemptId: string | null
  status: string
  divergences: number | null
  improvedNearMiss: boolean
  loggedAt: string | null
  model: string | null
  harness: string | null
  reasoning: string | null
  note: string | null
  baseKind: string | null
  usedNearMissDraft: boolean | null
  usedGhidraDraft: boolean | null
  depth: number
}

export interface NearMissTipSummary {
  divergences: number | null
  source: string | null
  srcPath: string | null
  hasCSource: boolean
}

export interface FunctionHistory {
  functionId: string
  name: string
  attempts: AttemptNodeSummary[]
  tip: NearMissTipSummary | null
  attemptsPath: string
  nearMissPath: string
  note: string | null
}

/** Chaos Viewer preferences persisted in tangos-settings.json. The renderer's
 *  theme registry sanitizes unknown theme ids back to classic. */
export interface ViewerPrefs {
  theme: string
  contributorColors: boolean
}

/**
 * Session/app toggles for draft sources (like Chaos Viewer prompt checkboxes).
 * Do NOT paste disasm/near-miss/Ghidra C into next_batch — agents call tools / open
 * files when allowed. These flags only change the policy text + which tip tools are exposed.
 */
export interface MatchingPrefs {
  /** Allow near-miss tip store / nearmiss_* tools. Default true. */
  allowNearMiss: boolean
  /** Allow ghidra_out scaffolds as structure hints. Default false unless descriptor says on. */
  allowGhidra: boolean
}

/** Animated gradient-background preference persisted in tangos-settings.json. Whether the
 *  theme background drifts (mesh-gradient + bubbles) vs. renders flat; the palette itself
 *  follows the active theme (see paletteForTheme). */
export interface BackgroundPrefs {
  enabled: boolean
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

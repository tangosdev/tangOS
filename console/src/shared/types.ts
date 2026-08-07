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
   * Where a matched source file belongs, e.g. "src/arm9/<symbol>.c|.cpp and
   * src/arm7/<symbol>.c|.cpp, one matched function each".
   *
   * Emitted to the agent as its own directive in every batch. A repo that splits
   * src/ by CPU or segment does not build a file dropped at the top of src/ - it
   * compiles for nobody and counts toward nothing - and the byte gate does not
   * catch it, because it resolves each file from that file's own decomp marker
   * rather than from where the file sits.
   */
  srcLayout?: string
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
  // This project's live stream on the tangos backend, e.g.
  // https://tangos.dev/api/projects/pictochat. Publish events only: it says when this
  // project's own CI has landed a fresh chaos-db, so the Atlas reloads then instead of
  // waiting out its poll. Separate from claimsApi on purpose - that one brings claims,
  // cosmetics and counts, which belong only to the project the backend serves.
  liveApi?: string
  // Raw URL of the live CLAIMS.md. Optional: if absent the console derives it from
  // committedDbUrl (same owner/repo, main branch, /CLAIMS.md).
  claimsMdUrl?: string
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

/**
 * Which of this repo's tools fill the jobs Console drives.
 *
 * Console needs a handful of specific capabilities to run its Controller: something to pick the
 * next targets, something to enrich one, something to drive an agent over them, something to land
 * the result. It used to find them by assuming sm64ds's tool ids and file paths, which meant a
 * project could declare a complete, correct toolchain and still not work.
 *
 * Every field is a tool id from this descriptor's own `tools[]`. Nothing here is required: a repo
 * that fills none still gets the Viewer, the tool catalog and MCP; it just doesn't offer the parts
 * it has no tool for. Repos predating this block keep working - Console falls back to the old id
 * convention (coddog / refine_wl / worklist / match / log_attempt) when a role is unset.
 */
export interface TangosConsoleRoles {
  /** Ranks unmatched functions and writes a worklist. Drives batch generation. */
  scheduler?: string
  /** Scheduler for the Refiner role: near-misses that already carry a draft. */
  refineScheduler?: string
  /** Scheduler for the Random role: any unmatched function, no similarity bias. */
  randomScheduler?: string
  /** Expands one target (by module + address) into a full worklist row. */
  enrich?: string
  /** Runs an agent over a worklist via an API key. */
  driver?: string
  /** Banks a finished drive: matched sources in, near-misses ingested. */
  land?: string
  /** Appends to the attempt log. */
  logAttempt?: string
  /** Verifies one candidate against the ROM. The merge gate. */
  verify?: string
}

export interface TangosDescriptor {
  tangosVersion: string
  project: TangosProject
  runtime?: TangosRuntime
  requirements?: TangosRequirements
  data?: TangosData
  categories?: TangosCategory[]
  console?: TangosConsoleRoles
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
  projectId: string | null // which registry project this is; the key its agent stats live under
  projectTitle: string // display name, from the descriptor when loaded else the registry
  // 'remote' = no clone here, so the descriptor came off the repo's published copy: the Viewer
  // works from the atlas URL, nothing is runnable, and `path` is null.
  mode: 'local' | 'remote'
}

/** One row in the project switcher. */
export interface ProjectSummary {
  id: string
  title: string
  glyph: string
  github: string
  path: string | null // remembered clone, verified to still exist
  cloned: boolean
  active: boolean
  custom?: boolean // a hand-picked folder rather than a built-in registry entry
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
    'You are the HARD MATCHER. Take the large, hard functions others skip and drive each all the way to a byte match, end to end. Write C from the disasm, callees, pool slots, and signatures; run the heavy tiers (sweep/clone/paramclone) and the refine tools; verify with match/fdiff; bank confirmed byte matches. This is the deep-water role - work each one patiently. If MATCH LOGGING is on: every try is a MATCH_RESULT (SHARED DEFAULTS from next_batch); matched only after verify; near_miss only when the tip improves; else no_progress; no wall-clock times; bank is not a new try.',
  'Drafter':
    'You are the DRAFTER (stage 1 of the pipeline). Your batch is unmatched functions that have a similar MATCHED sibling to lean on. Adapt that sibling into a close, COMPILING draft for each target - get it as near as you can. You do NOT have to land byte-exact: store each near-miss draft in the near-miss tip store (nearmiss/db.jsonl via nearmiss tools or tools/nearmiss_db.py) so the Refiner can finish it. Favor volume of good drafts over grinding any single function. Log tries when MATCH LOGGING is on (near_miss when tip improves, no_progress otherwise; usedNearMissDraft when you lean on a tip; no timestamps).',
  'Refiner':
    'You are the REFINER (stage 2 of the pipeline). Pull near-misses that already carry a draft, diagnose the exact divergences with fdiff (and falign if available), and refine each draft to a byte-exact match. You have the most to work with - a compiling draft plus the verifier diff - so nudge codegen SHAPE (declaration/statement order, types, register coloring) rather than rewriting. Bank confirmed byte matches. Keep the attempt tree linked (parentAttemptId = the tip you forked); no_progress when a refine does not beat the tip; bank is not a new try.',
  'Random':
    'You are the RANDOM MATCHER. Your batch is unmatched functions drawn uniformly at random from across the whole ROM - any size, any module, no similarity hint. For each, study the disasm, callees, pool slots, and signatures, write C, and verify with match/fdiff. Give each about 5 attempts with DIFFERENT levers; if it has not matched by then, move on rather than grinding. Bank confirmed byte matches. Log every try when MATCH LOGGING is on (matched only after verify; near_miss only when tip improves; else no_progress; no wall-clock times). This role samples the whole unmatched pool for breadth - on an infinite loop you get a fresh random draw each batch.'
}
/** Which models each role wants. `strength` is the operator-facing label in the assign-role dropdown:
 *  your strongest on the hardest role, a cheap/local model where there's the most scaffolding. Each
 *  tier names a reference model so "low/high" reads as reasoning/skill, not a guess. `names` and
 *  `families` are the machine-readable half of that same claim - Simple mode picks a role from the
 *  connected model with them, so the label an operator reads and the role the app picks can't drift
 *  apart. `names` is tried first against the agent name (a Claude box can be Fable or Haiku; the
 *  family alone can't tell them apart); `families` is the coarse fallback, keyed by efforts.ts
 *  `familyOf`. Never injected into an agent's instructions - edit the reference models freely. */
export const ROLE_FIT: Record<string, { strength: string; names?: RegExp; families?: string[] }> = {
  'Hard matcher': { strength: 'very high, Fable 5+', names: /fable|opus|gpt-?5|\bo[34]\b/ },
  'Random': { strength: 'high, Sonnet 5 / Grok', names: /sonnet|grok/, families: ['Claude', 'Grok', 'GPT'] },
  'Drafter': { strength: 'medium, DeepSeek', names: /deepseek|kimi|moonshot/, families: ['DeepSeek', 'Kimi'] },
  'Refiner': {
    strength: 'low, GLM / Nemotron',
    names: /glm|zhipu|nemotron|nemo|gemma|mistral/,
    families: ['GLM', 'Nemotron', 'Requesty']
  }
}
/** Display-only view of ROLE_FIT, for the assign-role dropdown. */
export const ROLE_STRENGTH: Record<string, string> = Object.fromEntries(
  Object.entries(ROLE_FIT).map(([role, fit]) => [role, fit.strength])
)
export const ROLE_NAMES = ['Unassigned', ...Object.keys(ROLE_PRESETS)]

/** Sensible default batch size per role (Hard matcher is heavy -> fewer targets per batch). Shared
 *  so the count the controller shows and the count the scheduler uses are the same number. */
export const roleBatchSize = (role?: string): number => (role === 'Hard matcher' ? 8 : 16)

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

/** A failing requirement Console can repair itself, rather than printing a command to copy. */
export type PreflightFixId = 'python' | 'pypkgs' | 'rom' | 'chaosdb'

export interface PreflightItem {
  id: string
  label: string
  ok: boolean
  detail: string
  fix?: string // when !ok: one plain sentence saying how to fix it
  fixCmd?: string // when !ok: a ready-to-copy command that does the fix (if one exists)
  /** When set, the panel shows a button that performs the fix instead of only naming it. */
  fixAction?: PreflightFixId
  /** Button text for fixAction, e.g. "Install packages". */
  fixLabel?: string
  /** fixAction needs a file chosen first (the ROM picker) - the button opens a dialog. */
  fixNeedsFile?: { title: string; extensions: string[] }
  /** fixAction installs software or otherwise changes the machine: confirm before running. */
  fixConfirm?: string
  /** Console may run this fix unprompted (no user input, nothing installed, repo-local only).
   *  Pressing Go applies these silently rather than failing with a dialog. */
  autoFixable?: boolean
  /** A missing requirement that makes batch generation impossible. Go refuses rather than
   *  spending minutes in a scheduler that cannot succeed. */
  blocksScheduling?: boolean
}

export interface PreflightFixResult {
  ok: boolean
  message: string
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
  attempts?: number // console-driven agents: max match attempts per function (glm_refine --attempts)
  stopping?: boolean // Stop was pressed mid-drive; the post-run pipeline (land/paramclone/push) is finishing
  exhausted?: string // api AIs: auto-stopped because the key ran out of usage. The reason, shown on the box.
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
  // Overlaid on the LIVE atlas only: an active/partial CLAIMS.md hold by another
  // contributor. Present => someone is grinding this; the batcher must not basket it.
  claim?: { handle: string; status: string }
  // Set when the src file's banner tags it NONMATCHING (ASM-PRIMITIVE) or
  // NONMATCHING (NOT-C-EXPRESSIBLE): it already reproduces the ROM and there is no match
  // left to chase, so it is not pending work. `reason` is the hover explanation.
  noMatch?: { bucket: 'asm-primitive' | 'not-c-expressible'; reason: string }
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

/** How much of the controller to show, persisted in tangos-settings.json.
 *  simple   - each agent box is a status line and one Go/Stop button, with a count field. The role
 *             is picked for the agent from its measured strengths, then the model behind it (see
 *             ROLE_FIT), and never shown.
 *  advanced - every control: assign/remove roles by hand, effort, attempts, batch size, the loop
 *             toggle, queue up without starting, clear the queue, drive the queue separately. */
export type UiMode = 'simple' | 'advanced'
export interface UiPrefs {
  mode: UiMode
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

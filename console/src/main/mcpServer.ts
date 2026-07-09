import { createServer, type Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import { z, type ZodTypeAny } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { TangosDescriptor, TangosRuntime, TangosTool, Batch, BatchItem, RunResult, ConnectedClient } from '../shared/types'
import { ROLE_PRESETS } from '../shared/types'

// Re-export so consumers can observe the exact bus instance runTool publishes to.
export { activityBus } from './activityBus'

export interface BatchApi {
  next: (agentName?: string) => Batch | null
  // Long-poll: resolves the moment a matching batch is enqueued, or null after timeoutMs. Lets
  // next_batch block server-side instead of the agent owning a token-burning re-poll loop.
  wait: (agentName: string | undefined, timeoutMs: number) => Promise<Batch | null>
  list: () => Batch[]
}

export interface McpContext {
  descriptor: TangosDescriptor
  repoPath: string
  runtime: TangosRuntime
  allowMutations: boolean
  enabledToolIds?: string[]
  batchApi?: BatchApi
  // main supplies the runner so it can wrap mutating runs in safe-mode git handling
  run: (
    tool: TangosTool,
    values: Record<string, unknown>,
    source: 'ai' | 'user',
    client?: { name: string; role?: string }
  ) => Promise<RunResult>
}

/** Normalize an MCP client name to a friendly AI label. */
// Collapse a client's reported name down to its MODEL FAMILY, so every session of the same
// model lands in ONE box (and its stats accumulate under one key) instead of a new box per
// session name. Model names (opus/sonnet/haiku, o1/o3, ...) map to their family, not a literal
// "Opus" box separate from "Claude".
export function normalizeName(raw?: string): string {
  if (!raw) return 'AI'
  const n = raw.toLowerCase()
  // Claude models get their OWN boxes (Opus/Fable/Sonnet run + score independently), so resolve the
  // specific model before the generic 'Claude' fallback. Order matters: "claude-opus-4-8" -> Opus.
  if (n.includes('opus')) return 'Opus'
  if (n.includes('fable')) return 'Fable'
  if (n.includes('sonnet')) return 'Sonnet'
  if (n.includes('haiku')) return 'Haiku'
  if (n.includes('claude')) return 'Claude'
  if (n.includes('grok')) return 'Grok'
  if (n.includes('deepseek')) return 'DeepSeek'
  if (n.includes('glm') || n.includes('zhipu') || n.includes('z.ai')) return 'GLM'
  if (n.includes('gemini')) return 'Gemini'
  if (n.includes('gpt') || n.includes('openai') || n.includes('codex') || n.includes('chatgpt') || /\bo[1345]\b/.test(n))
    return 'GPT'
  if (n.includes('cursor')) return 'Cursor'
  if (n.includes('cline')) return 'Cline'
  return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

function zodForArg(tool: TangosTool): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {}
  for (const a of tool.args ?? []) {
    let base: ZodTypeAny
    switch (a.type) {
      case 'integer':
        base = z.number().int()
        break
      case 'number':
        base = z.number()
        break
      case 'boolean':
        base = z.boolean()
        break
      case 'enum':
        base =
          Array.isArray(a.choices) && a.choices.every((c) => typeof c === 'string')
            ? z.enum(a.choices as [string, ...string[]])
            : z.string()
        break
      default:
        base = z.string()
    }
    if (a.description) base = base.describe(a.description)
    shape[a.name] = a.required ? base : base.optional()
  }
  if (tool.apply) {
    shape.apply = z
      .boolean()
      .optional()
      .describe(`Pass ${tool.apply} to actually mutate repo state. Default false = dry run (safe preview).`)
  }
  return shape
}

function describeTool(tool: TangosTool): string {
  const parts: string[] = []
  parts.push(tool.description || tool.label || tool.id)
  parts.push(tool.readOnly ? '[read-only]' : '[MUTATES repo state]')
  if (tool.apply) parts.push(`Defaults to a dry run; set apply=true to write changes (${tool.apply}).`)
  if (tool.needs?.length) parts.push(`Requires: ${tool.needs.join(', ')}.`)
  const req = (tool.args ?? []).filter((a) => a.required).map((a) => a.name)
  if (req.length) parts.push(`REQUIRED args: ${req.join(', ')}.`)
  return parts.join(' ')
}

/** Build a ready-to-run `match` call for a batch target so the agent never has to guess
 *  (and never omits the required `c` arg - the failure that stalled the first batch). */
function verifyCallFor(item: BatchItem, descriptor: TangosDescriptor): string | null {
  const match = descriptor.tools?.find((t) => t.id === 'match')
  if (!match) return null
  const name = item.ref
  const ext = name.startsWith('_Z') ? 'cpp' : 'c'
  const c = item.srcPath || `src/${name}.${ext}`
  let addr = item.addr != null ? '0x' + item.addr.toString(16).padStart(8, '0') : null
  if (!addr) {
    const m = /_([0-9a-f]{8})$/i.exec(name)
    if (m) addr = '0x' + m[1].toLowerCase()
  }
  const size = item.size != null ? '0x' + item.size.toString(16) : null
  const ver = match.args?.find((a) => a.name === 'version')?.default
  // overlay module: from the item, else derived from a func_ovNNN_ name
  let mod = item.module
  if (!mod || mod === '') {
    const mo = /_ov(\d+)_/.exec(name)
    if (mo) mod = 'ov' + mo[1]
  }
  const args: Record<string, string | boolean> = { c, func: name }
  if (addr) args.addr = addr
  if (size) args.size = size
  if (typeof ver === 'string') args.version = ver
  if (mod && mod.startsWith('ov')) args.module = mod // overlays need it or the target reads empty
  if (item.size != null && item.size > 0x800) args.brief = true // big function -> keep output small
  const missing = [!addr ? 'addr' : '', !size ? 'size' : ''].filter(Boolean)
  const note = missing.length ? `   (fill ${missing.join(' + ')}: worklist --addr ${addr ?? '0x...'} --pretty)` : ''
  return JSON.stringify(args) + note
}

// Cap the text handed back to the AI so a single verbose tool (falign/fdiff on a
// multi-KB function can dump 50-70 KB) can't flood its context. The human still sees
// the FULL output in the live viewer - this only trims the MCP response. Head + tail
// keep the summary and the final verdict; the middle (the long aligned diff) is cut.
const MAX_TOOL_OUTPUT = 9000
function capOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s
  const head = s.slice(0, 6400)
  const tail = s.slice(-1800)
  const cut = s.length - head.length - tail.length
  return `${head}\n\n...[${cut} chars trimmed to save context - full output is in the human's live viewer. Narrow addr/size, or use --brief/--quiet.]...\n\n${tail}`
}

function buildMcpServer(getCtx: () => McpContext, getClient: () => ConnectedClient | undefined): McpServer {
  const ctx = getCtx()
  // Surface the repo's contribution rules to every connecting AI on `initialize` (MCP
  // startup). `submitting` is the PR/how-to-post directive (points at AGENTS.md); `rules`
  // is the legal/ROM line. Repo-agnostic: whatever the descriptor declares is what shows.
  const proj = ctx.descriptor.project
  const instructions =
    [proj.submitting, proj.rules && `Legal: ${proj.rules}`].filter(Boolean).join('\n\n') || undefined
  const server = new McpServer(
    { name: 'tangos', version: '0.1.0' },
    instructions ? { instructions } : undefined
  )
  const enabled = new Set(ctx.enabledToolIds ?? ctx.descriptor.tools.map((t) => t.id))

  for (const tool of ctx.descriptor.tools) {
    if (!enabled.has(tool.id)) continue
    server.tool(tool.id, describeTool(tool), zodForArg(tool), async (input: Record<string, unknown>) => {
      const c = getClient()
      const res = await getCtx().run(tool, input ?? {}, 'ai', c ? { name: c.name, role: c.roles[0] } : undefined)
      const header = `[tangos] ${tool.id} -> ${res.status}${res.exitCode != null ? ` (exit ${res.exitCode})` : ''}`
      const text = `${header}\n\n${capOutput(res.output || '(no output)')}`
      return { content: [{ type: 'text' as const, text }], isError: res.status !== 'ok' }
    })
  }

  if (ctx.batchApi) {
    const api = ctx.batchApi
    server.tool(
      'next_batch',
      'Pull the next batch of work from the tangOS Console. Returns your role instructions (if designated) plus the batch prompt and its target functions, and marks it active. This call BLOCKS server-side until a batch is ready (or ~45s), so just call it once and it parks until there is work - no polling loop, no waiting on your side.',
      {},
      async () => {
        const idle = getClient()
        // Long-poll: block here until a batch is enqueued for this agent, or ~45s elapses. The
        // wait is server-side and free, so the agent parks on ONE call instead of spinning an
        // expensive re-poll loop (waking, re-reading context, deciding "still empty", sleeping).
        const b = await api.wait(idle?.name, 45_000)
        if (!b) {
          // Timed out with no work. NOT a spin: the wait already happened server-side, so the
          // agent simply re-issues next_batch once and blocks again. Cap it so a truly idle agent
          // eventually hands back rather than holding the session forever.
          const n = idle ? (idle.emptyPolls = (idle.emptyPolls ?? 0) + 1) : 1
          const IDLE_CAP = 8
          const text =
            n >= IDLE_CAP
              ? `[tangos] still no work after ${n} waits (~${Math.round((n * 45) / 60)} min idle). STOP - hand back to the human with one short line, e.g. "queue empty, standing by - re-engage me when there's work."`
              : `[tangos] no work yet (waited 45s, empty ${n}/${IDLE_CAP}). Call next_batch again - it BLOCKS until a batch arrives, so it costs no thinking. Your ENTIRE next response is a single next_batch call: no heartbeat, no analysis, no other tools, no self-assigned targets.`
          return { content: [{ type: 'text' as const, text }] }
        }
        if (idle) idle.emptyPolls = 0
        const c = getClient()
        const desc = getCtx().descriptor
        const roles = (c?.roles ?? []).filter((r) => r && r !== 'Unassigned' && ROLE_PRESETS[r])
        const prefix = roles.length
          ? `[You are the ${roles.map((r) => `"${r}"`).join(' + ')} agent.] ${roles.map((r) => ROLE_PRESETS[r]).join(' ')}\n\n`
          : ''
        const hasMatch = !!desc.tools?.find((t) => t.id === 'match')

        const targets = b.items.length
          ? '\n\nTargets:\n' +
            b.items
              .map((i) => {
                const head = `- ${i.ref}${i.label ? ` (${i.label})` : ''}`
                const call = hasMatch ? verifyCallFor(i, desc) : null
                return call ? `${head}\n    match -> ${call}` : head
              })
              .join('\n')
          : ''

        // How to actually run the work without stalling on the first tool error.
        const guide = hasMatch
          ? '\n\nHOW TO WORK EACH TARGET (never end a turn on a failed call):\n' +
            '1. Every target has a ready `match` call above (required args: c, func, addr, size). Use it verbatim - never omit `c`.\n' +
            '2. BEFORE any match/fdiff/falign on a target, make sure its `c` candidate file EXISTS. If it does not, CREATE the draft first from `worklist --addr <addr> --pretty` (or disasm / chaos-db.json). Never diff a file you have not created - that is the #1 avoidable error (FileNotFoundError).\n' +
            '3. On ANY tool error - validation (-32602), compile failure, OR missing-file/FileNotFoundError - diagnose and RETRY in the SAME turn (check tangos.json tools[] for required args if unsure). A turn may only end on a successful call or an explicit "blocked because X" hand-off sentence - never right after a failed call.\n' +
            '4. For first-pass triage use `fdiff` with `"quiet": true` (returns just `mismatches=N/total`) - do NOT lean on match\'s full byte dump or `brief` to triage. Pull the full diff only once you are fixing a specific block. `falign` handles size-mismatched candidates but is EXPENSIVE on large functions - pass `"quiet": true` or `"limit": 1` and fix the earliest diverging block first.\n' +
            '5. Overlay (ov*) targets: keep the `module` in the ready call - it auto-loads the overlay binary, so you do NOT need bin/base. (If overlay bytes read back empty/0, your repo is a stale ZIP snapshot - use a fresh `git clone`.) Run heavy tools one at a time; pass `"brief": true` for large functions.\n' +
            '6. End EVERY working turn with a one-line status: what you just did, the current best divergence, and the single next action. Never end a turn silently after a tool result.\n' +
            '7. When these targets are done, call `next_batch` for more. It BLOCKS until there is work (or ~45s), so just call it - no waiting, sleeping, or heartbeat loop on your side. If it returns empty (a timeout), your entire response is one more next_batch call to keep parking - no worklist, coddog, notes, or self-assigned targets. After several empty waits it tells you to hand back.\n' +
            '8. Coordination is automatic - do NOT claim or push anything yourself. Your batch is already yours (the console hands each agent a distinct set), and when the operator is signed into GitHub the console auto-collects your matched files and opens a per-agent PR. Just match the targets; landing + PRs are handled for you.\n' +
            '9. Stay in your lane: edit source ONLY for the targets above. If an edit regresses a function (worse diff or bigger size), REVERT it - never leave a tracked source file worse than you found it. Keep scratch files, notes, and session reports in a temp/scratch dir, NEVER inside the repo or beside source files.\n' +
            'Fallback if native MCP tools are unavailable in your client: run `npx tsx scripts/mcp-run.mts <calls.json> <your-name>` (e.g. grok) from the tangOS console dir, where calls.json is [{"tool":"match","args":{...}}]. Pass your name so the live viewer tags your runs correctly (omitting it shows "agent").'
          : ''

        const walls = desc.project?.knownWalls
        const wallsNote = walls
          ? `\n\n[known walls - verify your near-miss IS one, then say so and move on; do not grind or give up blanket]\n${walls}`
          : ''
        const submitting = desc.project?.submitting
        const submitNote = submitting
          ? `\n\n[what may land in src/ - AGENTS.md has the full format]\n${submitting}`
          : ''
        return {
          content: [
            {
              type: 'text' as const,
              text: `${prefix}[tangos batch] "${b.title}" (${b.items.length} targets)\n\n${b.prompt}${targets}${guide}${wallsNote}${submitNote}`
            }
          ]
        }
      }
    )
    server.tool(
      'list_batches',
      'List the tangOS Console batch queue (status, title, target count) without consuming anything.',
      {},
      async () => {
        const q = api.list()
        const text = q.length
          ? q.map((b) => `${b.status.toUpperCase().padEnd(6)} "${b.title}" (${b.items.length} targets)`).join('\n')
          : '(no batches queued)'
        return { content: [{ type: 'text' as const, text }] }
      }
    )
  }
  return server
}

export class McpManager {
  private httpServer: HttpServer | null = null
  private transports = new Map<string, StreamableHTTPServerTransport>()
  private clients = new Map<string, ConnectedClient>()
  private lastSeen = new Map<string, number>() // sessionId -> last request time, for evicting ghosts
  private staleTimer: ReturnType<typeof setInterval> | null = null
  private _port: number | null = null
  // Raw endpoint traffic - lets the human tell "nothing ever hit us" (client never
  // reached the server) from "reached but the MCP handshake failed" (requests > 0,
  // clients still 0). The exact situation when an agent claims it connected but the
  // roster stays empty.
  private _requestsSeen = 0
  private _lastContactAt = 0
  private getCtx: () => McpContext
  onClientsChange?: () => void
  // Fired on raw endpoint traffic (throttled by the consumer) so the UI can show
  // "N requests seen" even when no MCP session ever forms.
  onTraffic?: () => void
  // Persistent per-agent roles: look up remembered roles by agent name on connect,
  // and report assignments so main can save them across sessions.
  roleForName?: (name: string) => string[] | undefined
  onRolesAssigned?: (name: string, roles: string[]) => void

  constructor(getCtx: () => McpContext) {
    this.getCtx = getCtx
  }

  get running(): boolean {
    return this.httpServer !== null
  }
  get port(): number | null {
    return this._port
  }
  get url(): string | null {
    return this._port ? `http://127.0.0.1:${this._port}/mcp` : null
  }
  get connectedClients(): number {
    return this.clients.size
  }
  get requestsSeen(): number {
    return this._requestsSeen
  }
  get lastContactAt(): number | null {
    return this._lastContactAt || null
  }
  getClients(): ConnectedClient[] {
    return [...this.clients.values()]
  }
  setRoles(id: string, roles: string[]): void {
    const c = this.clients.get(id)
    if (!c) return
    c.roles = roles
    // apply to any other live sessions of the same agent, and remember it for next time
    for (const other of this.clients.values()) if (other.name === c.name) other.roles = roles
    this.onRolesAssigned?.(c.name, roles)
    this.onClientsChange?.()
  }

  private touch(id?: string): void {
    if (id) this.lastSeen.set(id, Date.now())
  }

  // Evict sessions that have gone silent - an agent that dropped without a clean
  // DELETE (script process.exit, editor session drop) leaves a ghost otherwise.
  private evictStale(): void {
    const STALE_MS = 90_000
    const now = Date.now()
    let changed = false
    for (const id of [...this.clients.keys()]) {
      if (now - (this.lastSeen.get(id) ?? 0) > STALE_MS) {
        try {
          this.transports.get(id)?.close()
        } catch {
          /* ignore */
        }
        this.transports.delete(id)
        this.clients.delete(id)
        this.lastSeen.delete(id)
        changed = true
      }
    }
    if (changed) this.onClientsChange?.()
  }

  start(port = 4808): Promise<{ port: number; url: string }> {
    if (this.httpServer) return Promise.resolve({ port: this._port!, url: this.url! })

    const app = express()
    app.use(express.json({ limit: '8mb' }))

    app.post('/mcp', async (req: Request, res: Response) => {
      this._requestsSeen++
      this._lastContactAt = Date.now()
      this.onTraffic?.()
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let transport: StreamableHTTPServerTransport | undefined
      if (sessionId && this.transports.has(sessionId)) {
        transport = this.transports.get(sessionId)
        this.touch(sessionId)
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Name the client from the initialize request itself - a client that completes
        // `initialize` but never sends the `notifications/initialized` follow-up would
        // otherwise stay stuck on "connecting…". oninitialized still refines it later.
        const initName = normalizeName(
          (req.body as { params?: { clientInfo?: { name?: string } } })?.params?.clientInfo?.name
        )
        let sid: string | undefined
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sid = id
            this.transports.set(id, transport!)
            const remembered = this.roleForName?.(initName)
            this.clients.set(id, {
              id,
              name: initName,
              roles: remembered ?? [],
              connectedAt: Date.now()
            })
            this.lastSeen.set(id, Date.now())
            this.onClientsChange?.()
          }
        })
        transport.onclose = () => {
          const id = transport!.sessionId
          if (id) {
            this.transports.delete(id)
            this.clients.delete(id)
            this.onClientsChange?.()
          }
        }
        const server = buildMcpServer(this.getCtx, () => (sid ? this.clients.get(sid) : undefined))
        server.server.oninitialized = () => {
          const info = server.server.getClientVersion()
          if (sid) {
            const c = this.clients.get(sid)
            if (c) {
              c.name = normalizeName(info?.name)
              const remembered = this.roleForName?.(c.name)
              if (remembered) c.roles = remembered // restore the roles this agent had before
              this.onClientsChange?.()
            }
          }
        }
        await server.connect(transport)
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID' }, id: null })
        return
      }
      await transport!.handleRequest(req, res, req.body)
    })

    const sessionRequest = async (req: Request, res: Response) => {
      this._requestsSeen++
      this._lastContactAt = Date.now()
      this.onTraffic?.()
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !this.transports.has(sessionId)) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      this.touch(sessionId)
      await this.transports.get(sessionId)!.handleRequest(req, res)
    }
    app.get('/mcp', sessionRequest)
    app.delete('/mcp', sessionRequest)

    app.get('/health', (_req, res) => {
      res.json({
        ok: true,
        name: 'tangos',
        clients: this.clients.size,
        requestsSeen: this._requestsSeen,
        lastContactAt: this._lastContactAt || null
      })
    })

    return new Promise((resolve, reject) => {
      const http = createServer(app)
      http.on('error', reject)
      http.listen(port, '127.0.0.1', () => {
        this.httpServer = http
        this._port = port
        this.staleTimer = setInterval(() => this.evictStale(), 30_000)
        resolve({ port, url: this.url! })
      })
    })
  }

  async stop(): Promise<void> {
    if (this.staleTimer) {
      clearInterval(this.staleTimer)
      this.staleTimer = null
    }
    for (const t of this.transports.values()) {
      try {
        await t.close()
      } catch {
        /* ignore */
      }
    }
    this.transports.clear()
    this.clients.clear()
    this.lastSeen.clear()
    this.onClientsChange?.()
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve()
      this.httpServer.close(() => resolve())
    })
    this.httpServer = null
    this._port = null
  }

  resetSessions(): void {
    for (const t of this.transports.values()) {
      try {
        void t.close()
      } catch {
        /* ignore */
      }
    }
    this.transports.clear()
    this.clients.clear()
    this.onClientsChange?.()
  }
}

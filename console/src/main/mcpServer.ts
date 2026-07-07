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
function normalizeName(raw?: string): string {
  if (!raw) return 'AI'
  const n = raw.toLowerCase()
  if (n.includes('claude')) return 'Claude'
  if (n.includes('grok')) return 'Grok'
  if (n.includes('deepseek')) return 'DeepSeek'
  if (n.includes('glm') || n.includes('zhipu') || n.includes('z.ai')) return 'GLM'
  if (n.includes('gemini')) return 'Gemini'
  if (n.includes('gpt') || n.includes('openai') || n.includes('codex')) return 'GPT'
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
 *  (and never omits the required `c` arg — the failure that stalled the first batch). */
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
// the FULL output in the live viewer — this only trims the MCP response. Head + tail
// keep the summary and the final verdict; the middle (the long aligned diff) is cut.
const MAX_TOOL_OUTPUT = 9000
function capOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s
  const head = s.slice(0, 6400)
  const tail = s.slice(-1800)
  const cut = s.length - head.length - tail.length
  return `${head}\n\n...[${cut} chars trimmed to save context — full output is in the human's live viewer. Narrow addr/size, or use --brief/--quiet.]...\n\n${tail}`
}

function buildMcpServer(getCtx: () => McpContext, getClient: () => ConnectedClient | undefined): McpServer {
  const ctx = getCtx()
  const server = new McpServer({ name: 'tangos', version: '0.1.0' })
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
      'Pull the next queued batch of work from the tangOS Console. Returns your role instructions (if designated) plus the batch prompt and its target functions, and marks it active. Call repeatedly in a loop to drain the queue; stop when it reports the queue is empty.',
      {},
      async () => {
        const idle = getClient()
        const b = api.next(idle?.name) // only batches addressed to this agent (or unaddressed)
        if (!b) {
          // No batch assigned: WAIT. The only allowed action while idle is to re-poll
          // next_batch. This is deliberately the whole message — do not let an idle agent
          // self-assign work (the repeated token-burn: reading long notes, dumping the
          // worklist, starting coddog on an empty queue). Tools come out only once a real
          // batch is returned below.
          const n = idle ? (idle.emptyPolls = (idle.emptyPolls ?? 0) + 1) : 1
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `[tangos] queue empty — no batch assigned (idle poll ${n}). WAIT for work. Your ONLY action right now is to call next_batch again in ~30-60s. Do NOT call any other tool (not worklist, coddog, progress, triage, or anything else), do NOT read notes or files, do NOT pick your own targets. Begin using tools ONLY when next_batch returns an actual batch. Sitting idle and re-polling is cheap and correct; exploring or self-assigning work while the queue is empty is what wastes tokens. (If you would rather not idle, it is fine to stop and let the human re-engage you.)`
              }
            ]
          }
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
          ? '\n\nHOW TO WORK EACH TARGET (do NOT stop on the first error):\n' +
            '1. Every target has a ready `match` call above (required args: c, func, addr, size). Use it verbatim — never omit `c`.\n' +
            '2. `c` is the candidate source path; create the file if it does not exist. Fill any placeholder from `worklist --addr <addr> --pretty` or chaos-db.json.\n' +
            '3. If a tool returns a validation error (-32602) or fails: read tangos.json tools[] for that tool\'s required args, fix the call, and RETRY. Do not end your turn on one failed call.\n' +
            '4. Use `fdiff` (required: c, name; plus module/addr/size or target-hex) on the worst divergences, edit the source, then `match` again. `falign` handles size-mismatched candidates but is EXPENSIVE on large functions — pass `"quiet": true` or `"limit": 1` and fix the earliest diverging block first.\n' +
            '5. Overlay (ov*) targets already include `module` in the ready call — keep it, or the ROM target reads back empty. Run heavy tools one at a time (do not bundle several `match` calls in one shell); pass `"brief": true` for large functions to keep output small.\n' +
            '6. When these targets are done, call `next_batch` again for more. If it returns empty, WAIT: re-poll next_batch every ~30-60s and do nothing else. While the queue is empty, next_batch is the ONLY tool you may call — no worklist, coddog, progress, triage, or reading notes to find your own targets. Idle means wait, not explore; only start pulling tools again when next_batch hands you a real batch.\n' +
            '7. Coordinate: `claims_check` a target\'s span before working it; `claims_lock` (module/start/end) to reserve it and `claims_release` when it is banked. The console posts under your handle with its own key — you never need a key.\n' +
            '8. Stay in your lane: edit source ONLY for the targets above. If an edit regresses a function (worse diff or bigger size), REVERT it — never leave a tracked source file worse than you found it. Keep scratch files, notes, and session reports in a temp/scratch dir, NEVER inside the repo or beside source files.\n' +
            'Fallback if native MCP tools are unavailable in your client: run `npx tsx scripts/mcp-run.mts <calls.json> <your-name>` (e.g. grok) from the tangOS console dir, where calls.json is [{"tool":"match","args":{...}}]. Pass your name so the live viewer tags your runs correctly (omitting it shows "agent").'
          : ''

        const walls = desc.project?.knownWalls
        const wallsNote = walls
          ? `\n\n[known walls — verify your near-miss IS one, then say so and move on; do not grind or give up blanket]\n${walls}`
          : ''
        return {
          content: [
            {
              type: 'text' as const,
              text: `${prefix}[tangos batch] "${b.title}" (${b.items.length} targets)\n\n${b.prompt}${targets}${guide}${wallsNote}`
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
  // Raw endpoint traffic — lets the human tell "nothing ever hit us" (client never
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

  // Evict sessions that have gone silent — an agent that dropped without a clean
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
        // Name the client from the initialize request itself — a client that completes
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

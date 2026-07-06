import { createServer, type Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import { z, type ZodTypeAny } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { TangosDescriptor, TangosRuntime, TangosTool, Batch, RunResult, ConnectedClient } from '../shared/types'
import { ROLE_PRESETS } from '../shared/types'

// Re-export so consumers can observe the exact bus instance runTool publishes to.
export { activityBus } from './activityBus'

export interface BatchApi {
  next: () => Batch | null
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
  return parts.join(' ')
}

function buildMcpServer(getCtx: () => McpContext, getClient: () => ConnectedClient | undefined): McpServer {
  const ctx = getCtx()
  const server = new McpServer({ name: 'tangos', version: '0.1.0' })
  const enabled = new Set(ctx.enabledToolIds ?? ctx.descriptor.tools.map((t) => t.id))

  for (const tool of ctx.descriptor.tools) {
    if (!enabled.has(tool.id)) continue
    server.tool(tool.id, describeTool(tool), zodForArg(tool), async (input: Record<string, unknown>) => {
      const c = getClient()
      const res = await getCtx().run(tool, input ?? {}, 'ai', c ? { name: c.name, role: c.role } : undefined)
      const header = `[tangos] ${tool.id} -> ${res.status}${res.exitCode != null ? ` (exit ${res.exitCode})` : ''}`
      const text = `${header}\n\n${res.output || '(no output)'}`
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
        const b = api.next()
        if (!b) return { content: [{ type: 'text' as const, text: '[tangos] batch queue is empty.' }] }
        const c = getClient()
        const rolePrompt = c && c.role && c.role !== 'Unassigned' ? ROLE_PRESETS[c.role] : undefined
        const prefix = rolePrompt ? `[You are the "${c!.role}" agent.] ${rolePrompt}\n\n` : ''
        const targets = b.items.length
          ? '\n\nTargets:\n' + b.items.map((i) => `- ${i.ref}${i.label ? ` (${i.label})` : ''}`).join('\n')
          : ''
        // Surface the repo's known walls so a connected AI doesn't rediscover a proven-unreachable
        // shape (and tells the user when it hits one) rather than grinding it silently.
        const walls = getCtx().descriptor?.project?.knownWalls
        const wallsNote = walls ? `\n\n[known walls — verify your near-miss IS one, then say so and move on; do not grind or give up blanket]\n${walls}` : ''
        return {
          content: [
            { type: 'text' as const, text: `${prefix}[tangos batch] "${b.title}" (${b.items.length} targets)\n\n${b.prompt}${targets}${wallsNote}` }
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
  private _port: number | null = null
  private getCtx: () => McpContext
  onClientsChange?: () => void

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
  getClients(): ConnectedClient[] {
    return [...this.clients.values()]
  }
  setRole(id: string, role: string): void {
    const c = this.clients.get(id)
    if (c) {
      c.role = role
      this.onClientsChange?.()
    }
  }

  start(port = 4808): Promise<{ port: number; url: string }> {
    if (this.httpServer) return Promise.resolve({ port: this._port!, url: this.url! })

    const app = express()
    app.use(express.json({ limit: '8mb' }))

    app.post('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let transport: StreamableHTTPServerTransport | undefined
      if (sessionId && this.transports.has(sessionId)) {
        transport = this.transports.get(sessionId)
      } else if (!sessionId && isInitializeRequest(req.body)) {
        let sid: string | undefined
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sid = id
            this.transports.set(id, transport!)
            this.clients.set(id, { id, name: 'connecting…', role: 'Unassigned', connectedAt: Date.now() })
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
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !this.transports.has(sessionId)) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      await this.transports.get(sessionId)!.handleRequest(req, res)
    }
    app.get('/mcp', sessionRequest)
    app.delete('/mcp', sessionRequest)

    app.get('/health', (_req, res) => {
      res.json({ ok: true, name: 'tangos', clients: this.clients.size })
    })

    return new Promise((resolve, reject) => {
      const http = createServer(app)
      http.on('error', reject)
      http.listen(port, '127.0.0.1', () => {
        this.httpServer = http
        this._port = port
        resolve({ port, url: this.url! })
      })
    })
  }

  async stop(): Promise<void> {
    for (const t of this.transports.values()) {
      try {
        await t.close()
      } catch {
        /* ignore */
      }
    }
    this.transports.clear()
    this.clients.clear()
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

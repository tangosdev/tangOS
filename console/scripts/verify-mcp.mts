// End-to-end check of the tangOS MCP server against the real sm64ds repo.
// Covers: descriptor load -> McpManager (HTTP) -> client -> tool run -> activity
// events -> mutation gate -> tool selection filtering -> batch inbox (next_batch).
// Run: npx tsx scripts/verify-mcp.mts
import { loadDescriptor } from '../src/main/descriptor'
import { McpManager, activityBus, type McpContext } from '../src/main/mcpServer'
import { runTool } from '../src/main/runTool'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Batch } from '../src/shared/types'

const REPO = 'C:/Users/bmanu/Documents/sm64ds-decomp'
const PORT = 4899
const BUILTIN = 2 // next_batch + list_batches

function log(...a: unknown[]): void {
  console.log('[verify]', ...a)
}

async function main(): Promise<void> {
  const { descriptor, errors } = loadDescriptor(REPO)
  if (!descriptor || errors.length) throw new Error('descriptor load failed: ' + errors.join('; '))
  log(`descriptor OK: ${descriptor.project.title}, ${descriptor.tools.length} tools`)

  const queue: Batch[] = [
    { id: 'b1', title: 'Test batch', prompt: 'Match these please.', items: [{ id: 'i1', ref: 'func_x' }], status: 'queued', createdAt: 0 }
  ]
  const ctx: McpContext = {
    descriptor,
    repoPath: REPO,
    runtime: descriptor.runtime ?? { cwd: '.', python: 'python' },
    allowMutations: true,
    batchApi: {
      next: () => {
        const b = queue.find((x) => x.status === 'queued')
        if (!b) return null
        queue.forEach((x) => { if (x.status === 'active') x.status = 'done' })
        b.status = 'active'
        return b
      },
      list: () => queue
    },
    run: (tool, values, source) =>
      runTool({ tool, values, runtime: ctx.runtime, repoPath: REPO, source, allowMutations: ctx.allowMutations })
  }

  const events: string[] = []
  activityBus.on('activity', (ev: any) => {
    if (ev.kind === 'run-started') events.push(`start:${ev.run.toolId}:${ev.run.source}`)
    if (ev.kind === 'run-finished') events.push(`finish:${ev.status}`)
  })

  const mgr = new McpManager(() => ctx)
  const { url } = await mgr.start(PORT)
  log(`server listening at ${url}`)

  const client = new Client({ name: 'verify', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  log('client connected')

  const tools = await client.listTools()
  log(`listTools -> ${tools.tools.length} (expected ${descriptor.tools.length + BUILTIN})`)
  if (tools.tools.length !== descriptor.tools.length + BUILTIN) throw new Error('tool count mismatch')
  if (!tools.tools.some((t) => t.name === 'next_batch')) throw new Error('next_batch not exposed')

  // read-only tool that works without a ROM (committed data only)
  const res: any = await client.callTool({ name: 'progress', arguments: { bar: true } })
  const text = res.content?.[0]?.text ?? ''
  if (!/Functions|%/.test(text)) throw new Error('progress output did not look right')
  log('progress ran OK:', text.split('\n').find((l: string) => /Functions/.test(l))?.trim())

  // batch inbox: next_batch pulls the queued batch and marks it active
  const nb: any = await client.callTool({ name: 'next_batch', arguments: {} })
  const nbText = nb.content?.[0]?.text ?? ''
  log('next_batch ->', nbText.split('\n')[0])
  if (!/Test batch/.test(nbText) || !/func_x/.test(nbText)) throw new Error('next_batch did not return the queued batch')
  if (queue[0].status !== 'active') throw new Error('batch was not marked active')
  const nb2: any = await client.callTool({ name: 'next_batch', arguments: {} })
  if (!/empty/.test(nb2.content?.[0]?.text ?? '')) throw new Error('second next_batch should be empty')
  log('next_batch (2nd) -> queue empty (correct)')

  // mutation gate
  ctx.allowMutations = false
  const blocked: any = await client.callTool({ name: 'import_symbols', arguments: {} })
  if (!/Blocked/i.test(blocked.content?.[0]?.text ?? '')) throw new Error('mutating tool not blocked')
  log('mutation gate: import_symbols blocked when writes off')
  await client.close()

  // tool selection controls exposure (batch tools always remain)
  ctx.enabledToolIds = ['progress', 'treemap']
  mgr.resetSessions()
  const client2 = new Client({ name: 'verify2', version: '0.0.0' })
  await client2.connect(new StreamableHTTPClientTransport(new URL(url)))
  const t2 = await client2.listTools()
  log(`after selecting 2 tools -> ${t2.tools.length} (expected ${2 + BUILTIN})`)
  if (t2.tools.length !== 2 + BUILTIN) throw new Error('tool selection did not filter exposure')
  await client2.close()

  await mgr.stop()
  log('activity events:', events.join(' | '))
  if (!events.some((e) => e.startsWith('start:progress:ai'))) throw new Error('no ai activity captured')

  log('ALL CHECKS PASSED ✓')
  process.exit(0)
}

main().catch((e) => {
  console.error('[verify] FAILED:', e)
  process.exit(1)
})

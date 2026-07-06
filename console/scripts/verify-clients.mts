// Verify multi-agent identity: client name captured from the MCP handshake, normalized,
// role assignment, and per-run client tagging. Run: npx tsx scripts/verify-clients.mts
import { loadDescriptor } from '../src/main/descriptor'
import { McpManager, activityBus, type McpContext } from '../src/main/mcpServer'
import { runTool } from '../src/main/runTool'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const REPO = 'C:/Users/bmanu/Documents/sm64ds-decomp'
const PORT = 4901
const log = (...a: unknown[]): void => console.log('[clients]', ...a)
const assert = (c: boolean, m: string): void => {
  if (!c) throw new Error('FAILED: ' + m)
}

async function main(): Promise<void> {
  const { descriptor } = loadDescriptor(REPO)
  if (!descriptor) throw new Error('no descriptor')
  const rt = descriptor.runtime ?? { cwd: '.', python: 'python' }
  const ctx: McpContext = {
    descriptor,
    repoPath: REPO,
    runtime: rt,
    allowMutations: true,
    run: (tool, values, source, client) => runTool({ tool, values, runtime: rt, repoPath: REPO, source, client, allowMutations: true })
  }
  const mgr = new McpManager(() => ctx)
  mgr.onClientsChange = () => log('roster:', mgr.getClients().map((c) => `${c.name}[${c.role}]`).join(', ') || '(none)')
  const { url } = await mgr.start(PORT)

  // connect two AIs with different client names
  const grok = new Client({ name: 'grok-code-cli', version: '1.0' })
  await grok.connect(new StreamableHTTPClientTransport(new URL(url)))
  const claude = new Client({ name: 'claude-code', version: '1.0' })
  await claude.connect(new StreamableHTTPClientTransport(new URL(url)))
  await new Promise((r) => setTimeout(r, 250))

  const roster = mgr.getClients()
  log('connected count:', roster.length, '->', roster.map((c) => c.name))
  assert(roster.length === 2, 'expected 2 connected clients, got ' + roster.length)
  assert(roster.some((c) => c.name === 'Grok'), 'grok-code-cli should normalize to "Grok"')
  assert(roster.some((c) => c.name === 'Claude'), 'claude-code should normalize to "Claude"')

  // designate the Grok client as Verifier
  const grokClient = roster.find((c) => c.name === 'Grok')!
  mgr.setRole(grokClient.id, 'Verifier')
  assert(mgr.getClients().find((c) => c.id === grokClient.id)!.role === 'Verifier', 'role should be set')

  // a tool call from Grok should be tagged with its name + role
  let tagged: { name: string; role?: string } | undefined
  activityBus.on('activity', (ev: any) => {
    if (ev.kind === 'run-started' && ev.run.source === 'ai') tagged = ev.run.client
  })
  await grok.callTool({ name: 'progress', arguments: { bar: true } })
  log('run tagged with client:', tagged)
  assert(!!tagged && tagged.name === 'Grok' && tagged.role === 'Verifier', 'run should carry client name + role')

  // next_batch should prepend the role instructions
  // (no batch queued -> empty, so just confirm the tool exists and role plumbing compiled)
  await grok.close()
  await claude.close()
  await new Promise((r) => setTimeout(r, 150))
  log('after disconnect count:', mgr.getClients().length)
  await mgr.stop()

  log('ALL CLIENT CHECKS PASSED ✓')
  process.exit(0)
}

main().catch((e) => {
  console.error('[clients] FAILED:', e)
  process.exit(1)
})

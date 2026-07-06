// Connect, drain the batch queue (pull everything queued), report each, disconnect.
// Run: npx tsx scripts/check-batches.mts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const SERVER = 'http://127.0.0.1:4808/mcp'
const text = (r: unknown): string => (r as { content?: { text?: string }[] }).content?.[0]?.text ?? ''

async function main(): Promise<void> {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER)))
  console.log('[check] connected as Claude')

  console.log('[check] list_batches:')
  console.log(text(await client.callTool({ name: 'list_batches', arguments: {} })))

  let n = 0
  for (;;) {
    const t = text(await client.callTool({ name: 'next_batch', arguments: {} }))
    if (/queue is empty/.test(t)) break
    n++
    console.log(`\n[check] ===== pulled batch #${n} =====`)
    console.log(t)
  }
  console.log(`\n[check] drained ${n} batch(es)`)

  await client.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('[check] error:', e)
  process.exit(1)
})

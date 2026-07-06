// Connect to the RUNNING tangOS MCP server (the one you started in the app) and drive
// a read-only tool so it shows up in the live viewer. Run: npx tsx scripts/connect-live.mts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const SERVER = 'http://127.0.0.1:4808/mcp'

async function main(): Promise<void> {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER)))
  console.log('[connect] connected to', SERVER)

  const tools = await client.listTools()
  console.log(`[connect] server exposes ${tools.tools.length} tools:`)
  console.log('  ' + tools.tools.map((t) => t.name).join(', '))

  console.log('\n[connect] calling progress(bar=true) — watch the live viewer...')
  const res = (await client.callTool({ name: 'progress', arguments: { bar: true } })) as {
    content: { type: string; text: string }[]
  }
  console.log(res.content?.[0]?.text ?? '(no output)')

  console.log('[connect] calling list_batches...')
  const lb = (await client.callTool({ name: 'list_batches', arguments: {} })) as {
    content: { type: string; text: string }[]
  }
  console.log(lb.content?.[0]?.text ?? '(no output)')

  await client.close()
  console.log('\n[connect] done — disconnected cleanly')
  process.exit(0)
}

main().catch((e) => {
  console.error('[connect] FAILED:', e)
  process.exit(1)
})

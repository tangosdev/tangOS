// A live agent session against the running tangOS MCP server. Connects as "Claude",
// shows a run in the viewer, then stays connected ~2 min polling next_batch so you can
// designate a role and Send a batch. Run: npx tsx scripts/agent-session.mts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const SERVER = 'http://127.0.0.1:4808/mcp'
const log = (...a: unknown[]): void => console.log('[claude]', ...a)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER)))
  log('connected as "Claude" — check the Connected agents list + client count')

  const res = (await client.callTool({ name: 'progress', arguments: { bar: true } })) as { content: { text: string }[] }
  log('ran progress (visible in your live viewer):')
  console.log(res.content?.[0]?.text?.split('\n').slice(0, 6).join('\n'))

  log('polling next_batch for ~5 min — designate me a role and Send a batch...')
  const deadline = Date.now() + 300_000
  let pulled = 0
  while (Date.now() < deadline) {
    const nb = (await client.callTool({ name: 'next_batch', arguments: {} })) as { content: { text: string }[] }
    const text = nb.content?.[0]?.text ?? ''
    if (!/queue is empty/.test(text)) {
      pulled++
      log(`>>> PULLED A BATCH (#${pulled}) — note the role instructions if you designated me:`)
      console.log(text)
    }
    await sleep(6000)
  }

  await client.close()
  log(`session ended (pulled ${pulled} batch(es)); disconnected`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[claude] error:', e)
  process.exit(1)
})

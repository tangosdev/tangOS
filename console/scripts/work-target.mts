// Drive the real matching toolchain over the MCP connection: pull ONE genuinely
// unmatched target with full context (disasm + few-shot sibling) — the exact
// payload a looping agent uses to write a match. Run: npx tsx scripts/work-target.mts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const SERVER = 'http://127.0.0.1:4808/mcp'
const text = (r: unknown): string => (r as { content?: { text?: string }[] }).content?.[0]?.text ?? ''

async function main(): Promise<void> {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER)))
  console.log('[work] connected as Claude\n')

  console.log('===== worklist --spread --easy --limit 1 --pretty --examples 1 =====')
  console.log(text(await client.callTool({
    name: 'worklist',
    arguments: { spread: true, easy: true, limit: '1', pretty: true, examples: '1' }
  })))

  await client.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('[work] error:', e)
  process.exit(1)
})

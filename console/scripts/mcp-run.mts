// Drive a sequence of tangOS tools over the live MCP connection so every call
// streams into the app's live viewer, tagged with YOUR agent name. Usage:
//   npx tsx scripts/mcp-run.mts <calls.json> <your-name>
// e.g. npx tsx scripts/mcp-run.mts calls.json grok   (or set TANGOS_AGENT=grok)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readFileSync } from 'node:fs'

const SERVER = 'http://127.0.0.1:4808/mcp'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const text = (r: unknown): string => (r as { content?: { text?: string }[] }).content?.[0]?.text ?? ''

// argv[2] = path to a JSON file [{ "tool": "...", "args": {...} }, ...]
// argv[3] (or TANGOS_AGENT) = which AI you are, so the viewer tags runs correctly.
const calls: { tool: string; args?: Record<string, unknown> }[] = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const AGENT = process.argv[3] || process.env.TANGOS_AGENT || 'agent'

async function main(): Promise<void> {
  const client = new Client({ name: AGENT, version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER)))
  console.log(`[${AGENT}] connected - watch the live viewer`)
  for (const c of calls) {
    console.log(`\n===== ${c.tool} ${JSON.stringify(c.args ?? {})} =====`)
    console.log(text(await client.callTool({ name: c.tool, arguments: c.args ?? {} })))
    await sleep(900) // brief gap so each run is visible landing in the viewer
  }
  await sleep(1500)
  await client.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(`[${AGENT}] error:`, e)
  process.exit(1)
})

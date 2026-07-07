// Tango's messages live in an editable text file (userData/tango-tips.txt) so the human
// can reword them without touching code. First line of each blank-line-separated block is
// the title, the rest is the body; lines starting with # are ignored.
import { app, shell } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface Tip {
  title: string
  body: string
  emotion?: string // frame name; e.g. smile, thinking, shy, tongue, handsup, idle
}

const DEFAULTS = `# Tango's messages - edit this file, then reopen tangOS (or reload) to see changes.
# One message per block: the FIRST line is the title, the rest is the body.
# Start the title with an emotion in brackets to set his face: [smile] [thinking] [shy] [tongue] [handsup] [idle]
# Separate messages with a blank line. Lines starting with # are ignored.

[smile] Hi, I'm Tango!
This is the Chaos Controller. Every AI you connect shows up as a box here - assign it work and watch it match functions live.

[handsup] Connect an AI
Flip the MCP switch on (top-right of the controller), then paste the prompt into your AI so it can connect.

[tongue] Hand out work
Click "Assign 16" on an AI's box to give it 16 functions to match, ranked by how close they are to code already solved.

[thinking] Use API keys
Add an LLM key in Settings (the gear) and that provider shows up as its own box - hit "Drive" to run it on its batch.

[smile] Pick a role
Give each AI a role from its dropdown. The one tagged "(recommended)" is what it is currently best at.

[thinking] Dig into an AI
Click any box to pop out its stats - matches, hit rate, tokens, and the function sizes it handles best.

[handsup] Two apps, one toggle
Use the slider up top to flip between the Controller and the Chaos Viewer map of the whole game.
`

const FALLBACK: Tip[] = [{ title: "Hi, I'm Tango!", body: 'Welcome to the Chaos Controller.' }]

function tipsFile(): string {
  return join(app.getPath('userData'), 'tango-tips.txt')
}

/** Seed the editable file on first run. */
export function ensureTips(): void {
  try {
    if (!existsSync(tipsFile())) writeFileSync(tipsFile(), DEFAULTS)
  } catch {
    /* ignore */
  }
}
export function tipsPath(): string {
  return tipsFile()
}
export function openTips(): void {
  void shell.openPath(tipsFile())
}

function parse(text: string): Tip[] {
  const tips: Tip[] = []
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => !l.trim().startsWith('#'))
    let title = (lines.shift() ?? '').trim()
    const body = lines.join(' ').trim()
    let emotion: string | undefined
    const m = /^\[(\w[\w-]*)\]\s*(.*)$/.exec(title)
    if (m) {
      emotion = m[1]
      title = m[2].trim()
    }
    if (title) tips.push({ title, body, emotion })
  }
  return tips
}

export function readTips(): Tip[] {
  try {
    const text = existsSync(tipsFile()) ? readFileSync(tipsFile(), 'utf8') : DEFAULTS
    const tips = parse(text)
    return tips.length ? tips : parse(DEFAULTS)
  } catch {
    return FALLBACK
  }
}

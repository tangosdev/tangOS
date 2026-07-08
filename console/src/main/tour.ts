// The first-run intro tour lives in an editable text file (userData/tango-tour.txt) so the human
// can reword the walkthrough without touching code. Each blank-line-separated block is one step:
//   line 1: options - an [emotion] and an optional @spot to highlight (either may be omitted)
//   line 2: the step title
//   rest:   the body
// Lines starting with # are ignored. Mirrors tips.ts so both are edited the same way.
import { app, shell } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface TourStep {
  target?: string // CSS selector to spotlight; centered if absent
  title: string
  body: string
  emotion: string // frame name; e.g. smile, thinking, shy, tongue, handsup, idle
}

const DEFAULTS = `# Tango's intro tour - the first-run walkthrough. Reword the titles and bodies freely.
# One step per block, blank line between blocks. In each block:
#   line 1  = options: an [emotion] and an optional @spot to highlight (either can be left off)
#   line 2  = the step title
#   rest    = the body text
# Emotions: [smile] [thinking] [shy] [tongue] [handsup] [idle]
# Spots (what to spotlight; omit the @spot to center the step): @toggle @mcp @settings @controller @policies
# Highlight: wrap words in :joke[ ... ] to paint them as a shimmering gradient of Tango's colors.
# Lines starting with # are ignored.

[smile]
Hi, I'm Tango!
New here? I'll get you matching in just a few seconds. Also, thank you for the download!

[handsup] @toggle
Installed apps
These buttons let you swap between applications in the tangOS. :joke[Every download gives me fifty (50) food-pellets!]

[smile] @mcp
Turn on MCP
Switch this ON so AIs can connect, then copy and send the prompt to your AI. :joke[My daily caloric intake is one hundred (100) fp.]

[thinking] @settings
Keys and GitHub login
You can also add API keys here, all keys are stored locally and never fully shown. :joke[My current food-pellet inventory is: four hundred and thirty (430) food-pellets.]

[smile] @controller
Your AI crew
This is where you control all of your AIs and track their stats. :joke[One food pellet is equal to one one hundredth (.01) of a(n) fp (pronounced ef-pee).]

[tongue] @controller
First batch
Hit "Assign 16" on a box to hand it 16 similar functions, after a bit of loading, hit drive. :joke[If I do not meet my daily caloric intake, the star will grow 350 sp stronger.]

[smile] @policies
Safety toggles
By default keep these on as it drives the entire pipeline and have many internal safety checks still. :joke[The star is currently at three hundred and eighty seven thousand five hundred and fifty (387550) sp (pronounced the same as fp (ef-pee)).]

[handsup]
You're ready to go!
I'll hang out in the corner. Click me any time for tips, and I may have messages for you later!
`

const FALLBACK: TourStep[] = [
  { title: "Hi, I'm Tango!", body: 'Welcome to the Chaos Controller.', emotion: 'smile' }
]

function tourFile(): string {
  return join(app.getPath('userData'), 'tango-tour.txt')
}

/** Seed the editable file on first run. */
export function ensureTour(): void {
  try {
    if (!existsSync(tourFile())) writeFileSync(tourFile(), DEFAULTS)
  } catch {
    /* ignore */
  }
}
export function tourPath(): string {
  return tourFile()
}
export function openTour(): void {
  void shell.openPath(tourFile())
}

function parse(text: string): TourStep[] {
  const steps: TourStep[] = []
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => !l.trim().startsWith('#') && l.trim() !== '')
    if (!lines.length) continue
    let emotion = 'smile'
    let target: string | undefined
    // First line is an options line only if, after removing an [emotion] and/or @spot, nothing
    // else remains; otherwise there's no options line and the first line is the title.
    const first = lines[0].trim()
    const em = /\[(\w[\w-]*)\]/.exec(first)
    const tg = /@([\w-]+)/.exec(first)
    const leftover = first.replace(/\[\w[\w-]*\]/g, '').replace(/@[\w-]+/g, '').trim()
    if ((em || tg) && leftover === '') {
      if (em) emotion = em[1]
      if (tg) target = `[data-tour="${tg[1]}"]`
      lines.shift()
    }
    const title = (lines.shift() ?? '').trim()
    const body = lines.join(' ').trim()
    if (title) steps.push({ target, title, body, emotion })
  }
  return steps
}

export function readTour(): TourStep[] {
  try {
    const text = existsSync(tourFile()) ? readFileSync(tourFile(), 'utf8') : DEFAULTS
    const steps = parse(text)
    return steps.length ? steps : parse(DEFAULTS)
  } catch {
    return FALLBACK
  }
}

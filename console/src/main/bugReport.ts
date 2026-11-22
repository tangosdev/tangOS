// Assemble a bug report: write a folder with the user's description, their screenshots, and a
// debug bundle, and return a paste-ready markdown blob (copied to the clipboard for the user to
// file wherever they report bugs). Never includes secret VALUES, only which keys are present.
import { app } from 'electron'
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'

export interface BugBundle {
  folder: string
  markdown: string
}

function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```'
}

export function writeBugReport(opts: {
  description: string
  screenshots: string[]
  debug: Record<string, unknown>
  appVersion: string
}): BugBundle {
  const folder = join(app.getPath('temp'), `tangos-bugreport-${Date.now()}`)
  mkdirSync(folder, { recursive: true })

  const shotNames: string[] = []
  for (const s of opts.screenshots) {
    try {
      const name = basename(s)
      copyFileSync(s, join(folder, name))
      shotNames.push(name)
    } catch {
      /* skip a screenshot we can't copy */
    }
  }

  const md =
    `## Bug report - tangOS Console ${opts.appVersion}\n\n` +
    `${opts.description.trim() || '_(no description)_'}\n\n` +
    (shotNames.length
      ? `### Screenshots\n${shotNames.map((n) => `- ${n} (attach from the opened folder)`).join('\n')}\n\n`
      : '') +
    `<details><summary>Debug info (auto-collected, no API keys)</summary>\n\n${fence(opts.debug)}\n\n</details>\n`

  writeFileSync(join(folder, 'bug-report.md'), md, 'utf8')
  writeFileSync(join(folder, 'debug.json'), JSON.stringify(opts.debug, null, 2), 'utf8')
  return { folder, markdown: md }
}

// Optional debug reporting: when enabled (off by default), every run + batch event is
// appended to a JSONL file under userData/tangos-reports. Files auto-expire after 48h.
// The human hands these to us to tune prompts, drivers, and stats.
import { app } from 'electron'
import { mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const MAX_AGE_MS = 48 * 60 * 60 * 1000
let enabled = false

export function reportsDir(): string {
  return join(app.getPath('userData'), 'tangos-reports')
}
export function reportsEnabled(): boolean {
  return enabled
}
export function setReportsEnabled(on: boolean): void {
  enabled = on
  if (on) prune()
}

function ensure(): void {
  mkdirSync(reportsDir(), { recursive: true })
}
function today(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}
/** Delete report files older than 48h. */
function prune(): void {
  try {
    ensure()
    const now = Date.now()
    for (const f of readdirSync(reportsDir())) {
      const p = join(reportsDir(), f)
      try {
        if (now - statSync(p).mtimeMs > MAX_AGE_MS) unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Append one entry (a run, a batch event, a driver result) to today's report. */
export function record(kind: string, data: Record<string, unknown>): void {
  if (!enabled) return
  try {
    ensure()
    appendFileSync(join(reportsDir(), `report-${today()}.jsonl`), JSON.stringify({ ts: Date.now(), kind, ...data }) + '\n')
    if (Math.random() < 0.04) prune() // occasional cleanup
  } catch {
    /* ignore */
  }
}

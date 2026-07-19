// Durable, crash-proof record of verified matches the console has rescued but not yet landed
// upstream. Written under userData (NOT the repo, NOT the 48h-expiring tangos-reports) so a crash,
// an app close, or a Push-off session can never lose knowledge of finished work.
//
// Pairs with the local recovery branch (tangos/harvest-<session>): the branch holds the matched
// BYTES, this file makes them discoverable and lets the console surface them to the operator on the
// next launch ("N verified matches from a previous session are not yet upstream"). This is the gap
// that stranded 13 finished matches on 2026-07-18 - the agent cracked them off the MCP bridge, the
// in-memory push queue never saw them, and nothing on disk remembered they existed.
import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface HarvestMatch {
  func: string
  path: string
  ts: number
}
export interface HarvestRecord {
  session: string
  repo: string
  branch: string
  commit?: string
  updatedAt: number
  landed?: boolean // set once every match is confirmed on origin/<base>, so it stops nagging
  matches: HarvestMatch[]
}

const KEEP_LANDED_MS = 14 * 24 * 60 * 60 * 1000 // drop resolved records after two weeks

export function harvestDir(): string {
  return join(app.getPath('userData'), 'tangos-harvest')
}
function ensure(): void {
  mkdirSync(harvestDir(), { recursive: true })
}
// Key by session AND repo: one process can open several repos, and each keeps its own recovery
// branch - a session-only filename would let a repo switch clobber the previous repo's record.
function fileFor(session: string, repo: string): string {
  const sid = session.replace(/[^a-zA-Z0-9_-]/g, '')
  const rid = createHash('sha1').update(repo).digest('hex').slice(0, 8)
  return join(harvestDir(), `harvest-${sid}-${rid}.json`)
}

export function saveHarvest(rec: HarvestRecord): void {
  try {
    ensure()
    writeFileSync(fileFor(rec.session, rec.repo), JSON.stringify(rec, null, 2))
  } catch {
    /* durability is best-effort here; the recovery branch is the real backstop */
  }
}

/** All harvest records for a repo (newest first), for startup recovery + the UI. Prunes records
 *  that are fully landed and older than KEEP_LANDED_MS so the dir doesn't grow without bound. */
export function listHarvests(repo?: string): HarvestRecord[] {
  try {
    ensure()
    const now = Date.now()
    const out: HarvestRecord[] = []
    for (const f of readdirSync(harvestDir())) {
      if (!f.endsWith('.json')) continue
      const full = join(harvestDir(), f)
      try {
        const rec = JSON.parse(readFileSync(full, 'utf8')) as HarvestRecord
        if (rec.landed && now - (rec.updatedAt || 0) > KEEP_LANDED_MS) continue // let it be overwritten later; skip surfacing
        if (!repo || rec.repo === repo) out.push(rec)
      } catch {
        /* skip a corrupt record */
      }
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  } catch {
    return []
  }
}

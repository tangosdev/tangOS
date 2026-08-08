// Live claims overlay for the Atlas.
//
// A claim is a reservation on a module/address range so two workers do not grind the
// same function. The AUTHORITATIVE register is the claims service (agents try-lock
// through it, the website writes to it); CLAIMS.md rows are the fallback register for
// repos with no service, and are still merged in during migration so a hand-written
// row keeps protecting its range. Reading only the file was finding 03 in the decomp
// data-flow trace: a function an agent held through the API could still be handed to
// a human here, because the lock never reached this overlay.
//
// CLAIMS.md parsing mirrors tools/claims_md.py: only **active**/**partial** rows are
// held; rows are hand-written so match by ADDRESS (reliable) with the symbol name as
// a fallback. API claims are proper [start, end) ranges scoped to a module.
import type { AtlasDb, TangosData } from '../shared/types'

export interface ClaimTag {
  handle: string
  status: string
}
export interface HeldRange {
  module: string
  start: number
  end: number
  tag: ClaimTag
}
export interface HeldClaims {
  addrs: Map<number, ClaimTag>
  names: Map<string, ClaimTag>
  ranges: HeldRange[]
  rows: number
}

const HELD_STATUS = /\*\*(active|partial)\*\*/i
const ADDR = /0x([0-9a-fA-F]{6,8})/g
// Mangled (_Z...), __sinit_..., func_<addr> (optionally func_ovNN_...), or Class::Method.
const SYM = /(_Z[A-Za-z0-9_]+|__sinit_[A-Za-z0-9_]+|func_(?:ov\d+_)?[0-9a-fA-F]{6,8}|[A-Za-z_]\w*::[A-Za-z_]\w*)/g

/** Derive the raw CLAIMS.md URL from committedDbUrl when the descriptor omits claimsMdUrl.
 *  committedDbUrl points at the chaos-data branch's db; claims live on main. */
export function deriveClaimsUrl(committedDbUrl?: string, override?: string): string | null {
  if (override) return override
  if (!committedDbUrl) return null
  // https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path...>
  const m = committedDbUrl.match(/^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+)\/[^/]+\/.+$/)
  if (!m) return null
  return `${m[1]}/main/CLAIMS.md`
}

/** Parse CLAIMS.md text into address/name -> holder maps (active/partial rows only). */
export function parseClaims(md: string): HeldClaims {
  const addrs = new Map<number, ClaimTag>()
  const names = new Map<string, ClaimTag>()
  const ranges: HeldRange[] = []
  let rows = 0
  for (const line of md.split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('|') || s.includes('---')) continue
    const held = HELD_STATUS.exec(s)
    if (!held) continue
    rows++
    // The "Who" column is the 2nd table cell: `| range | who | claimed | status |`.
    const cells = s.split('|').map((c) => c.trim())
    const handle = cells[2] || 'someone'
    const tag: ClaimTag = { handle, status: held[1].toLowerCase() }
    for (const m of s.matchAll(ADDR)) {
      const a = parseInt(m[1], 16)
      if (!addrs.has(a)) addrs.set(a, tag) // first (top-most) claim wins
    }
    for (const m of s.matchAll(SYM)) {
      if (!names.has(m[1])) names.set(m[1], tag)
    }
  }
  return { addrs, names, ranges, rows }
}

/** Fetch active locks from the claims service, scoped to this project's board.
 *  Null on any failure - advisory, never blocks the atlas. An OK response with zero
 *  claims is a real answer (empty board), not a failure. */
export async function fetchApiClaims(
  claimsApi: string,
  projectId?: string,
  timeoutMs = 10000
): Promise<HeldClaims | null> {
  const sep = claimsApi.includes('?') ? '&' : '?'
  const url = projectId ? `${claimsApi}${sep}project=${encodeURIComponent(projectId)}` : claimsApi
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ac.signal })
    if (!r.ok) return null
    const j = (await r.json()) as {
      claims?: Array<{ module?: string; start?: string; end?: string; handle?: string }>
    }
    if (!Array.isArray(j.claims)) return null
    const ranges: HeldRange[] = []
    for (const c of j.claims) {
      const start = Number(c.start)
      const end = Number(c.end)
      if (!c.module || !Number.isFinite(start) || !Number.isFinite(end)) continue
      ranges.push({
        module: c.module.toLowerCase(),
        start,
        end,
        tag: { handle: c.handle || 'someone', status: 'active' }
      })
    }
    return { addrs: new Map(), names: new Map(), ranges, rows: ranges.length }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** All live holds for a project: the claims service's board (authoritative when the
 *  descriptor declares one) MERGED with CLAIMS.md rows (the no-service fallback, kept
 *  during migration so a hand-written row still protects its range). Null when neither
 *  register answered. */
export async function fetchLiveHolds(
  data: Pick<TangosData, 'claimsApi' | 'projectId' | 'claimsMdUrl'> | undefined,
  committedDbUrl?: string
): Promise<HeldClaims | null> {
  const [api, file] = await Promise.all([
    data?.claimsApi ? fetchApiClaims(data.claimsApi, data.projectId) : Promise.resolve(null),
    (async () => {
      const url = deriveClaimsUrl(committedDbUrl, data?.claimsMdUrl)
      return url ? fetchHeldClaims(url) : null
    })()
  ])
  if (!api) return file
  if (!file) return api
  return {
    addrs: file.addrs,
    names: file.names,
    ranges: [...api.ranges, ...file.ranges],
    rows: api.rows + file.rows
  }
}

/** Fetch + parse the live CLAIMS.md. Returns null on any failure - claims are advisory and
 *  must never block the atlas from loading. */
export async function fetchHeldClaims(url: string, timeoutMs = 10000): Promise<HeldClaims | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ac.signal })
    if (!r.ok) return null
    return parseClaims(await r.text())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Tag each unmatched function that a live claim covers. Matched functions are done, so a
 *  stale claim on one is ignored. Mutates db.functions in place and returns the tagged count. */
export function overlayClaims(db: AtlasDb, held: HeldClaims): number {
  // API ranges bucketed per module: ranges are per-module address spaces (overlays
  // reuse addresses), and a flat scan of every range for 11k functions is wasted work.
  const byModule = new Map<string, HeldRange[]>()
  for (const r of held.ranges) {
    const list = byModule.get(r.module)
    if (list) list.push(r)
    else byModule.set(r.module, [r])
  }
  let tagged = 0
  for (const f of db.functions) {
    if (f.matched) {
      if (f.claim) delete f.claim
      continue
    }
    let tag = held.addrs.get(f.addr) ?? held.names.get(f.name)
    if (!tag) {
      const ranges = byModule.get(f.module.toLowerCase())
      if (ranges) {
        // Half-open [start, end) against [addr, addr+size): touching does not overlap.
        const hit = ranges.find((r) => f.addr < r.end && f.addr + f.size > r.start)
        if (hit) tag = hit.tag
      }
    }
    if (tag) {
      f.claim = tag
      tagged++
    } else if (f.claim) {
      delete f.claim // a released row since last fetch
    }
  }
  return tagged
}

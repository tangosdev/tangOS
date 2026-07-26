// Live CLAIMS.md overlay for the Atlas.
//
// CLAIMS.md is where contributors (and API-locking agents) reserve a module or address
// range before matching, so two workers do not grind the same function. The server-side
// schedulers already skip active/partial rows, but the Chaos Viewer's hand-pick cart did
// not - so a human could marquee-select a function someone else is actively working. This
// module fetches the live CLAIMS.md and tags each AtlasFunction with the holder, so the UI
// can dim it and the batcher can refuse to basket it.
//
// Parsing mirrors tools/claims_md.py: only **active**/**partial** rows are held; rows are
// hand-written so match by ADDRESS (reliable) with the symbol name as a fallback.
import type { AtlasDb } from '../shared/types'

export interface ClaimTag {
  handle: string
  status: string
}
export interface HeldClaims {
  addrs: Map<number, ClaimTag>
  names: Map<string, ClaimTag>
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
  return { addrs, names, rows }
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
  let tagged = 0
  for (const f of db.functions) {
    if (f.matched) {
      if (f.claim) delete f.claim
      continue
    }
    const tag = held.addrs.get(f.addr) ?? held.names.get(f.name)
    if (tag) {
      f.claim = tag
      tagged++
    } else if (f.claim) {
      delete f.claim // a released row since last fetch
    }
  }
  return tagged
}

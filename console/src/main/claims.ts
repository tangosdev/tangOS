import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import type { Claim } from '../shared/types'

// Credentials, resolved the same way tools/claims.py does: env, else the
// gitignored sibling file, else (handle only) the OS user. The key is only ever
// sent to the claims service as X-Api-Key; it is never surfaced to the renderer.
function apiKey(repo: string): string | null {
  const env = process.env.CLAIMS_API_KEY?.trim()
  if (env) return env
  const p = join(repo, 'tools', 'claims_key.txt')
  if (existsSync(p)) {
    try {
      return readFileSync(p, 'utf8').trim()
    } catch {
      /* ignore */
    }
  }
  return null
}

export function handle(repo: string): string {
  const env = process.env.CLAIMS_HANDLE?.trim()
  if (env) return env
  const p = join(repo, 'tools', 'claims_handle.txt')
  if (existsSync(p)) {
    try {
      const h = readFileSync(p, 'utf8').trim()
      if (h) return h
    } catch {
      /* ignore */
    }
  }
  try {
    return userInfo().username
  } catch {
    return 'anonymous'
  }
}

export function hasKey(repo: string): boolean {
  return !!apiKey(repo)
}

export async function listClaims(base: string, timeoutMs = 8000): Promise<Claim[]> {
  // Bounded: a hung board must not stall the caller (the claims panel, or batch generation).
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(base, { signal: ac.signal })
    if (!r.ok) return []
    const j = (await r.json()) as { claims?: Claim[] } | Claim[]
    if (Array.isArray(j)) return j
    return Array.isArray(j.claims) ? j.claims : []
  } catch {
    return []
  } finally {
    clearTimeout(t)
  }
}

export interface LockResult {
  ok: boolean
  error?: string
  claim?: Claim
  conflicts?: Claim[]
}

export async function tryLock(
  base: string,
  repo: string,
  p: { module: string; start: string; end: string; note?: string }
): Promise<LockResult> {
  const key = apiKey(repo)
  if (!key) return { ok: false, error: 'No claims API key (set CLAIMS_API_KEY or tools/claims_key.txt)' }
  try {
    const r = await fetch(`${base}/try-lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({ module: p.module, start: p.start, end: p.end, handle: handle(repo), note: p.note ?? 'tangOS' })
    })
    const j = (await r.json().catch(() => ({}))) as { claim?: Claim; conflicts?: Claim[] }
    if (r.status === 200 || r.status === 201) return { ok: true, claim: j.claim }
    if (r.status === 409) return { ok: false, error: 'already claimed', conflicts: j.conflicts }
    return { ok: false, error: `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// ---- board reconciliation -------------------------------------------------
// The batcher only de-dupes against locally-open batches; without this it happily hands out
// spans another machine already claimed on the belongto.us board (the duplicate-work bug from
// CLAIMS_COORDINATION_REPORT). claimGuard turns the live board into an overlap test so batch
// generation can drop targets someone else is already working.

function parseAddr(s: string | undefined): number | null {
  if (!s) return null
  const t = s.trim().toLowerCase()
  if (!t) return null
  // Always hex: these are ROM addresses, and the batch-item side parses them as base-16 too
  // (parseInt handles a leading 0x). Reading a bare-hex claim as decimal would silently never
  // overlap an item, defeating the whole guard.
  const n = parseInt(t, 16)
  return Number.isNaN(n) ? null : n
}

// Collapse the main binary's aliases so a claim on "arm9" matches a target with no module (or
// "main"/"base"). Overlays keep their own id (ov123) since they can share address ranges.
function normModule(m?: string): string {
  const t = (m ?? '').trim().toLowerCase()
  return !t || t === 'arm9' || t === 'main' || t === 'base' ? 'main' : t
}

export type ClaimGuard = (module: string | undefined, addr?: number, size?: number) => Claim | null

/** Build an overlap tester from the live board. Claims held by `me`, and expired claims, are
 *  ignored (mine are fine to work; expired ones are free). Returns the conflicting claim, or null
 *  if the span is clear. A target with no address can't be tested, so it is treated as clear. */
export function claimGuard(claims: Claim[], me: string): ClaimGuard {
  const now = Date.now()
  const mine = me.trim().toLowerCase()
  const spans: { module: string; start: number; end: number; claim: Claim }[] = []
  for (const c of claims) {
    if (mine && c.handle && c.handle.trim().toLowerCase() === mine) continue // my own claim
    if (c.expiresAt) {
      const t = Date.parse(c.expiresAt)
      if (!Number.isNaN(t) && t < now) continue // expired -> free
    }
    const a = parseAddr(c.start)
    const b = parseAddr(c.end)
    if (a == null || b == null) continue
    spans.push({ module: normModule(c.module), start: Math.min(a, b), end: Math.max(a, b), claim: c })
  }
  return (module, addr, size) => {
    if (addr == null) return null
    const m = normModule(module)
    const aStart = addr
    const aEnd = addr + (size && size > 1 ? size - 1 : 0) // inclusive; point span if size unknown
    for (const sp of spans) {
      if (sp.module !== m) continue
      if (aStart <= sp.end && sp.start <= aEnd) return sp.claim // inclusive-interval overlap
    }
    return null
  }
}

export async function releaseClaim(base: string, repo: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const key = apiKey(repo)
  if (!key) return { ok: false, error: 'No claims API key' }
  try {
    const r = await fetch(`${base}/${id}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({ handle: handle(repo) })
    })
    return { ok: r.ok, error: r.ok ? undefined : `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

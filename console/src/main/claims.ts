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

export async function listClaims(base: string): Promise<Claim[]> {
  try {
    const r = await fetch(base)
    if (!r.ok) return []
    const j = (await r.json()) as { claims?: Claim[] } | Claim[]
    if (Array.isArray(j)) return j
    return Array.isArray(j.claims) ? j.claims : []
  } catch {
    return []
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

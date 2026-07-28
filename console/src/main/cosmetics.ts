// Atlas cosmetics, fetched from the tangos.dev shop backend (GET /api/cosmetics).
// This is the ONE source of contributor colors and function stars, shared by the
// website viewer and this Console so every atlas looks identical: a color bought in
// Hermit's shop shows the same everywhere. The old repo-committed contributor-colors.json
// + color-PR flow was retired when the shop became the color system.
const HEX = /^#[0-9a-fA-F]{6}$/

export interface FunctionStar {
  function: string
  by: string
  at: string
}
export interface Cosmetics {
  colors: Record<string, string>
  stars: FunctionStar[]
}

// Derive the cosmetics endpoint from the descriptor's claims API (…/claims -> …/cosmetics),
// falling back to the public shop when a repo has no claims URL configured.
export function cosmeticsUrl(claimsApi?: string | null): string {
  if (claimsApi && /\/claims\/?$/.test(claimsApi)) return claimsApi.replace(/\/claims\/?$/, '/cosmetics')
  return 'https://tangos.dev/api/cosmetics'
}

let cache: { url: string; at: number; value: Cosmetics } | null = null
const TTL_MS = 60_000

export function bustCosmeticsCache(): void {
  cache = null
}

function parse(raw: unknown): Cosmetics {
  const colors: Record<string, string> = {}
  const stars: FunctionStar[] = []
  const r = raw as { colors?: Record<string, unknown>; stars?: unknown[] } | null
  if (r?.colors) for (const [k, v] of Object.entries(r.colors)) if (typeof v === 'string' && HEX.test(v)) colors[k] = v
  if (Array.isArray(r?.stars))
    for (const s of r.stars) {
      const st = s as { function?: unknown; by?: unknown; at?: unknown }
      if (typeof st?.function === 'string' && typeof st?.by === 'string')
        stars.push({ function: st.function, by: st.by, at: typeof st.at === 'string' ? st.at : '' })
    }
  return { colors, stars }
}

/** Shop cosmetics, TTL-cached so the Atlas doesn't hammer the backend. A failed fetch
 *  returns the last-known copy (or empty), never throws - cosmetics are decoration. */
export async function fetchCosmetics(claimsApi?: string | null): Promise<Cosmetics> {
  const url = cosmeticsUrl(claimsApi)
  if (cache?.url === url && Date.now() - cache.at < TTL_MS) return cache.value
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8000)
    try {
      const res = await fetch(url, { signal: ac.signal })
      if (res.ok) {
        const value = parse(await res.json())
        cache = { url, at: Date.now(), value }
        return value
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* offline or slow - fall through */
  }
  return cache?.value ?? { colors: {}, stars: [] }
}

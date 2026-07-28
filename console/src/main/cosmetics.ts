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
export interface Counts {
  totals: Record<string, number>
  daily: Record<string, number>
}

// Derive the backend API base from the descriptor's claims API (…/claims -> …), falling
// back to the public shop when a repo has no claims URL configured.
function apiBase(claimsApi?: string | null): string {
  if (claimsApi && /\/claims\/?$/.test(claimsApi)) return claimsApi.replace(/\/claims\/?$/, '')
  return 'https://tangos.dev/api'
}
export function cosmeticsUrl(claimsApi?: string | null): string {
  return `${apiBase(claimsApi)}/cosmetics`
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

export interface LiveProgress {
  ready: boolean
  stats: { totalFunctions: number; matchedFunctions: number; totalBytes: number; matchedBytes: number }
  matched: string[]
}

/** Live decomp progress computed by the VPS from the repo itself: exact stats plus the
 *  matched function ids. Lets the atlas move seconds after a merge instead of waiting for
 *  the published data to refresh. Best-effort; `ready:false` means fall back to the file. */
export async function fetchProgress(claimsApi?: string | null): Promise<LiveProgress> {
  const empty: LiveProgress = {
    ready: false,
    stats: { totalFunctions: 0, matchedFunctions: 0, totalBytes: 0, matchedBytes: 0 },
    matched: []
  }
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15000)
    try {
      const res = await fetch(`${apiBase(claimsApi)}/progress`, { signal: ac.signal })
      if (res.ok) {
        const j = (await res.json()) as Partial<LiveProgress>
        if (j.ready && j.stats) return { ready: true, stats: j.stats, matched: j.matched ?? [] }
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* offline - fall through */
  }
  return empty
}

/** Contributor match numbers from the backend: career totals + matches today (the
 *  recent-activity badge). Best-effort; empty on failure. */
export async function fetchCounts(claimsApi?: string | null): Promise<Counts> {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8000)
    try {
      const res = await fetch(`${apiBase(claimsApi)}/counts`, { signal: ac.signal })
      if (res.ok) {
        const j = (await res.json()) as Partial<Counts>
        return { totals: j.totals ?? {}, daily: j.daily ?? {} }
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* offline - fall through */
  }
  return { totals: {}, daily: {} }
}

// Live atlas stream (Server-Sent Events). Run in the main process (no CORS), it parses
// frames and calls onEvent for each. Auto-reconnects with a short backoff so a dropped
// gateway or a redeploy re-establishes the push without the app noticing. Returns a stop
// function.
export function connectAtlasLive(
  getClaimsApi: () => string | null | undefined,
  onEvent: (event: string, data: unknown) => void
): () => void {
  let stopped = false
  let controller: AbortController | null = null

  async function loop(): Promise<void> {
    while (!stopped) {
      controller = new AbortController()
      try {
        const res = await fetch(`${apiBase(getClaimsApi())}/live`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal
        })
        if (!res.ok || !res.body) throw new Error(`live HTTP ${res.status}`)
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done || stopped) break
          buf += dec.decode(value, { stream: true })
          let sep: number
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            const parsed = parseFrame(frame)
            if (parsed) onEvent(parsed.event, parsed.data)
          }
        }
      } catch {
        /* connection dropped - reconnect below */
      }
      if (stopped) break
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  void loop()
  return () => {
    stopped = true
    controller?.abort()
  }
}

function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue // heartbeat comment
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return null
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return null
  }
}

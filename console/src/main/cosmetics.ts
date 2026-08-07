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

// Derive the backend API base from the descriptor's claims API (…/claims -> …).
//
// NO GUESSED FALLBACK. A claims backend serves exactly one project: tangos.dev/api answers
// /atlas, /counts, /progress and /live for sm64ds and nothing else. Defaulting a repo with
// no claimsApi to that base painted the wrong project's contributor colors, stars, career
// counts and live match feed onto its atlas.
function apiBase(claimsApi?: string | null): string | null {
  if (claimsApi && /\/claims\/?$/.test(claimsApi)) return claimsApi.replace(/\/claims\/?$/, '')
  return null
}

// Where to read this project's own atlas extras (colours, counts, its live stream): the backend
// that SERVES it if there is one, else its declared per-project base. Not the same as the guess
// above - liveApi names THIS project's routes, so the data comes back scoped to it rather than
// borrowed from sm64ds. Progress and the computed atlas deliberately do NOT use this: those exist
// only for the project the backend computes, and there is nothing honest to serve another one.
export function atlasBase(claimsApi?: string | null, liveApi?: string | null): string | null {
  return apiBase(claimsApi) ?? (liveApi ? liveApi.replace(/\/$/, '') : null)
}

export function cosmeticsUrl(claimsApi?: string | null, liveApi?: string | null): string | null {
  const base = atlasBase(claimsApi, liveApi)
  return base && `${base}/cosmetics`
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
export async function fetchCosmetics(claimsApi?: string | null, liveApi?: string | null): Promise<Cosmetics> {
  const url = cosmeticsUrl(claimsApi, liveApi)
  if (!url) return { colors: {}, stars: [] }
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

/** The whole atlas straight from the VPS - same shape the published chaos-db has, but
 *  current to within seconds. Null when the backend has no data yet (cold start), so the
 *  caller can fall back to the published file. */
export async function fetchAtlas(claimsApi?: string | null): Promise<unknown | null> {
  const base = apiBase(claimsApi)
  if (!base) return null
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20000)
    try {
      const res = await fetch(`${base}/atlas`, { signal: ac.signal })
      if (!res.ok) return null
      const j = (await res.json()) as { ready?: boolean; functions?: unknown[] }
      return j?.ready && Array.isArray(j.functions) && j.functions.length ? j : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
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
  const base = apiBase(claimsApi)
  if (!base) return empty
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15000)
    try {
      const res = await fetch(`${base}/progress`, { signal: ac.signal })
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
export async function fetchCounts(claimsApi?: string | null, liveApi?: string | null): Promise<Counts> {
  const base = atlasBase(claimsApi, liveApi)
  if (!base) return { totals: {}, daily: {} }
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8000)
    try {
      const res = await fetch(`${base}/counts`, { signal: ac.signal })
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
//
// Two possible streams, and the difference is what a project is entitled to. claimsApi means the
// backend serves THIS project, so its stream adds claims and computed progress. liveApi is the
// project's own stream: publish events plus its own colours and counts, all scoped to it. Neither
// is a fallback for the other - the URLs name different projects' data, and mixing them up is the
// old bug of painting sm64ds onto another atlas - so they stay separate and the claims one wins.
export function connectAtlasLive(
  getClaimsApi: () => string | null | undefined,
  getLiveApi: () => string | null | undefined,
  onEvent: (event: string, data: unknown) => void
): () => void {
  let stopped = false
  let controller: AbortController | null = null

  async function loop(): Promise<void> {
    while (!stopped) {
      const served = apiBase(getClaimsApi())
      const own = getLiveApi()?.replace(/\/$/, '')
      const base = served ?? own
      if (!base) {
        // This project has no stream at all. Park rather than streaming somebody else's
        // events, and re-check on the same cadence so a switch to a project that HAS one
        // picks the stream up without a restart.
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }
      controller = new AbortController()
      try {
        const res = await fetch(`${base}/live`, {
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

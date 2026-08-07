import { useEffect, useMemo, useRef, useState } from 'react'
import {
  RefreshCw,
  Search,
  Plus,
  Minus,
  X,
  Database,
  Cloud,
  HardDrive,
  Users,
  ExternalLink,
  Maximize2,
  Minimize2
} from 'lucide-react'
import type {
  AtlasDb,
  AtlasFunction,
  BatchItem,
  FunctionHistory,
  GithubCredits
} from '../../../shared/types'
import ChaosViewer from '../chaos/ChaosViewer'
import type { LayoutMode } from '../chaos/types'
import { sortFns, SORT_LABELS, type SortKey } from '../atlas/sort'

const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(1)}%` : '0%')
// Same palette + rank ordering as the website viewer (tangos-web CONTRIB_PALETTE), so a
// contributor gets the identical color on every atlas. Bought shop colors override it.
const PALETTE = [
  '#38bdf8', '#f472b6', '#a78bfa', '#fb923c', '#facc15', '#34d399',
  '#f87171', '#22d3ee', '#c084fc', '#fbbf24', '#4ade80', '#e879f9'
]

export default function AtlasView({
  onAdd,
  onRemove,
  onReplace,
  draftRefs,
  liveEnabled,
  localAvailable
}: {
  onAdd: (item: BatchItem) => void
  onRemove: (ref: string) => void
  onReplace: (items: BatchItem[]) => void
  draftRefs: Set<string>
  liveEnabled: boolean
  /** false = no checkout here, so there is no local chaos-db to read or generate. */
  localAvailable: boolean
}): JSX.Element {
  // The loaded atlas as fetched/generated. The VPS's live match state is overlaid onto it
  // below; `db` is what the rest of the view renders.
  const [rawDb, setDb] = useState<AtlasDb | null>(null)
  // Live progress from the VPS: exact stats + matched id set, arriving seconds after a
  // merge instead of waiting on the published atlas refresh.
  const [live, setLive] = useState<{
    stats: { totalFunctions: number; matchedFunctions: number; totalBytes: number; matchedBytes: number }
    matched: Set<string>
    // Whole records the VPS pushed (new match, new author, new near-miss), applied over the
    // loaded atlas so a tile gains its contributor colour the moment the work lands.
    records: Map<string, Partial<AtlasFunction>>
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [source, setSource] = useState<'local' | 'live'>('local')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'unmatched' | 'matched'>('all')
  const [moduleFilter, setModuleFilter] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('unmatched')
  const [colorBy, setColorBy] = useState<'status' | 'author'>('status')
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('ov')
  const [authorFilter, setAuthorFilter] = useState<string | null>(null)
  const [showNearMiss, setShowNearMiss] = useState(true)
  const [selectedFn, setSelectedFn] = useState<AtlasFunction | null>(null)
  const [fullAtlas, setFullAtlas] = useState(false) // hide head + right rail: map fills the window
  const [history, setHistory] = useState<FunctionHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [gh, setGh] = useState<GithubCredits | null>(null)
  // Atlas cosmetics from the backend: the RESOLVED contributor color map (custom + de-conflicted
  // defaults, so nobody shares a shade) and function stars. Backend is authoritative; kept live by
  // the SSE stream below, so a shop color buy shows within a second.
  const [sharedColors, setSharedColors] = useState<Record<string, string>>({})
  const [stars, setStars] = useState<{ function: string; by: string }[]>([])
  // Contributor match numbers from the backend: career totals + matches today (the ▲ badge).
  const [counts, setCounts] = useState<{ totals: Record<string, number>; daily: Record<string, number> }>({
    totals: {},
    daily: {}
  })

  // Merge the VPS's live match state onto the loaded atlas. The backend reproduces the exact
  // rule the published atlas is built with, so when it has data it is simply fresher: the
  // progress bars and the map tiles both follow it, while authors/near-miss keep coming from
  // the loaded copy. Only applied to LIVE data - local generated data is the operator's own
  // repo state and must not be overwritten by what's on main.
  const db = useMemo<AtlasDb | null>(() => {
    if (!rawDb || !live || source !== 'live') return rawDb
    const functions = rawDb.functions.map((f) => {
      const matched = live.matched.has(f.id)
      const rec = live.records.get(f.id)
      if (matched === f.matched && !rec) return f
      return { ...f, ...rec, matched }
    })
    return { ...rawDb, functions, stats: { ...rawDb.stats, ...live.stats } }
  }, [rawDb, live, source])

  // Clear everything the operator has picked or opened: empty the batch cart, close the open
  // function, and drop the module drill-in. Wired to the "Clear selection" button and a bare
  // right-click on the map.
  const clearSelection = (): void => {
    onReplace([])
    setSelectedFn(null)
    setModuleFilter(null)
  }

  // Prior tries for the selected function (attempt log + near-miss tip). Operator planning only.
  useEffect(() => {
    if (!selectedFn) {
      setHistory(null)
      return
    }
    let alive = true
    setHistoryLoading(true)
    window.tangos
      .functionHistory({
        functionId: selectedFn.id,
        module: selectedFn.module,
        addr: selectedFn.addr,
        name: selectedFn.name
      })
      .then((h) => {
        if (alive) setHistory(h)
      })
      .catch(() => {
        if (alive) setHistory(null)
      })
      .finally(() => {
        if (alive) setHistoryLoading(false)
      })
    return () => {
      alive = false
    }
  }, [selectedFn?.id, selectedFn?.module, selectedFn?.addr, selectedFn?.name])

  useEffect(() => {
    window.tangos.githubCredits().then(setGh).catch(() => {})
    let alive = true
    window.tangos
      .atlasCosmetics()
      .then((r) => {
        if (!alive) return
        setSharedColors(r.colors)
        setStars(r.stars)
      })
      .catch(() => {})
    window.tangos.atlasCounts().then((c) => alive && setCounts(c)).catch(() => {})
    window.tangos
      .atlasProgress()
      .then((p) => {
        if (alive && p.ready)
          setLive({ stats: p.stats, matched: new Set(p.matched), records: new Map() })
      })
      .catch(() => {})
    // Live push from the VPS: colors/stars, counts, and match progress the instant they change.
    const off = window.tangos.onAtlasLive((event, data) => {
      if (!alive) return
      if (event === 'cosmetics') {
        const d = data as { colors?: Record<string, string>; stars?: { function: string; by: string }[] }
        if (d.colors) setSharedColors(d.colors)
        if (Array.isArray(d.stars)) setStars(d.stars)
      } else if (event === 'counts') {
        const d = data as { totals?: Record<string, number>; daily?: Record<string, number> }
        setCounts({ totals: d.totals ?? {}, daily: d.daily ?? {} })
      } else if (event === 'progress') {
        // Full matched set on connect, added/removed deltas afterwards.
        const d = data as {
          ready?: boolean
          stats?: { totalFunctions: number; matchedFunctions: number; totalBytes: number; matchedBytes: number }
          matched?: string[]
          added?: string[]
          removed?: string[]
          changed?: Array<Partial<AtlasFunction> & { id: string }>
        }
        if (!d.ready || !d.stats) return
        const stats = d.stats
        setLive((prev) => {
          const next = new Set<string>(d.matched ?? (prev ? [...prev.matched] : []))
          for (const id of d.added ?? []) next.add(id)
          for (const id of d.removed ?? []) next.delete(id)
          const records = new Map(prev?.records ?? [])
          for (const r of d.changed ?? []) records.set(r.id, r)
          return { stats, matched: next, records }
        })
      } else if (event === 'published') {
        // This project's CI has landed a fresh chaos-db, so read it now instead of at the next
        // poll. For a project the backend does not compute progress for, this is the only thing
        // that makes a merge show up while the window is open.
        //
        // The updater is how we read the CURRENT source from inside this effect, whose closure
        // was made once on mount - same trick as the local-refresh listener below. Local data is
        // the operator's own repo state and must not be replaced by what is on main.
        setSource((s) => {
          if (s === 'live')
            void window.tangos
              .atlasLoadLive(true)
              .then((fresh) => {
                if (fresh) setDb(fresh)
              })
              .catch(() => {})
          return s
        })
      }
    })
    window.tangos
      .viewerPrefsGet()
      .then((p) => {
        if (!alive) return
        setColorBy(p.contributorColors ? 'author' : 'status')
      })
      .catch(() => {})
    return () => {
      alive = false
      off()
    }
  }, [])

  const pickColorBy = (c: 'status' | 'author'): void => {
    setColorBy(c)
    void window.tangos.viewerPrefsSet({ contributorColors: c === 'author' }).catch(() => {})
  }
  const pickLayout = (m: LayoutMode): void => {
    setLayoutMode(m)
    if (m !== 'ov') setModuleFilter(null) // group names are not ov names - keep the list unfiltered
  }

  // data-file author key -> canonical GitHub login (dedups an email-derived key vs the GitHub login, etc.)
  const keyToLogin = useMemo(() => new Map(Object.entries(gh?.keyToLogin ?? {})), [gh])
  const loginFor = (f: AtlasFunction): string => (f.author ? keyToLogin.get(f.author) ?? f.author : '')

  // matched-function count per canonical login. The backend's career totals are the live,
  // authoritative source (same numbers the website shows); the db-derived count is a fallback
  // for a first paint before the counts arrive or when offline.
  const loginCounts = useMemo(() => {
    const m = new Map<string, number>()
    if (Object.keys(counts.totals).length) {
      for (const [login, n] of Object.entries(counts.totals)) if (!/\[bot\]$/i.test(login)) m.set(login, n)
    } else if (db) {
      for (const f of db.functions) if (f.matched && f.author) {
        const login = keyToLogin.get(f.author) ?? f.author
        if (/\[bot\]$/i.test(login)) continue
        m.set(login, (m.get(login) ?? 0) + 1)
      }
    }
    for (const l of gh?.logins ?? []) if (!m.has(l.login)) m.set(l.login, 0)
    for (const p of gh?.prAuthors ?? []) if (!m.has(p)) m.set(p, 0)
    return m
  }, [db, gh, keyToLogin, counts])

  // matches-today per login (the green ▲ badge), straight from the backend's daily counter -
  // the same one that drives the milestone posts, so it counts real matches, not file touches.
  const recentByLogin = useMemo(() => {
    const m = new Map<string, number>()
    for (const [login, n] of Object.entries(counts.daily)) if (n > 0 && !/\[bot\]$/i.test(login)) m.set(login, n)
    return m
  }, [counts])

  const authorColors = useMemo(() => {
    const out = new Map<string, string>()
    // The backend resolves the authoritative color per contributor (custom + de-conflicted
    // defaults); use it directly so every atlas matches. Palette is only a fallback for a
    // contributor the backend hasn't ranked yet.
    const shared = new Map(Object.entries(sharedColors).map(([k, v]) => [k.toLowerCase(), v]))
    ;[...loginCounts.entries()]
      .filter(([, n]) => n >= 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([name], i) => out.set(name, shared.get(name.toLowerCase()) ?? PALETTE[i % PALETTE.length]))
    return out
  }, [loginCounts, sharedColors])

  // Bought stars (Hermit's shop) -> function ids for the map's gold marker.
  const starredIds = useMemo(() => {
    if (!db || !stars.length) return undefined
    const byName = new Map(db.functions.map((f) => [f.name, f.id]))
    const ids = new Set<string>()
    for (const s of stars) {
      const id = byName.get(s.function)
      if (id) ids.add(id)
    }
    return ids
  }, [db, stars])

  async function load(src: 'local' | 'live', force = false): Promise<void> {
    setLoading(true)
    try {
      setDb(src === 'live' ? await window.tangos.atlasLoadLive(force) : await window.tangos.atlasLoad())
      setSource(src)
    } catch (e) {
      alert(String((e as Error).message ?? e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    ;(async () => {
      if (liveEnabled) {
        setLoading(true)
        try {
          setDb(await window.tangos.atlasLoadLive())
          setSource('live')
          setLoading(false)
          return
        } catch {
          /* offline - fall through */
        }
        setLoading(false)
      }
      // Without a checkout there is no local file to fall back to; falling through would show
      // "no Atlas data yet" for what is really a failed live fetch.
      if (localAvailable) await load('local')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The main process regenerates the local chaos-db in the background when it is stale. When that
  // finishes, reload - but only if we are actually showing local data, so a manual Live view is not
  // yanked out from under the user.
  useEffect(() => {
    return window.tangos.onAtlasRefreshed(() => {
      setSource((s) => {
        if (s === 'local') void load('local')
        return s
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the Live view moving on its own. A project WITH a backend gets the SSE feed above,
  // which pushes matched state seconds after a merge. A project without one - no claimsApi in
  // its descriptor, so /progress and /live are not its to read - has nothing pushing to it at
  // all, and its atlas sat at whatever was fetched when this view opened: a match merged while
  // the window was up simply never appeared. Poll the published data there, and slowly even
  // with the feed, since a function the generator only just added arrives in the file rather
  // than in a delta.
  //
  // force, because the passive path serves its own 60s cache and then rides raw GitHub's CDN
  // copy, which can be minutes old - exactly the staleness this poll exists to close. The main
  // process throttles a forced fetch to one per 20s, so this cadence cannot hammer it.
  //
  // Deliberately not load(): that flips `loading`, which would swap the whole map for the
  // spinner once a minute. A failed poll leaves what is on screen alone.
  const hasLiveFeed = !!live
  useEffect(() => {
    if (source !== 'live') return
    const t = setInterval(
      () => {
        void window.tangos
          .atlasLoadLive(true)
          .then((fresh) => {
            if (fresh) setDb(fresh)
          })
          .catch(() => {})
      },
      hasLiveFeed ? 5 * 60_000 : 60_000
    )
    return () => clearInterval(t)
  }, [source, hasLiveFeed])

  async function generate(): Promise<void> {
    setGenerating(true)
    try {
      setDb(await window.tangos.atlasGenerate())
      setSource('local')
    } finally {
      setGenerating(false)
    }
  }

  // Only real contributors: at least one matched function attributed to them. This drops the
  // 0-count entries seeded from GitHub logins / PR authors (people with a commit but nothing
  // merged into matched code yet) - they were showing as noise with a lock icon.
  const contributors = useMemo(
    () => [...loginCounts.entries()].filter(([, n]) => n >= 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    [loginCounts]
  )

  const filtered = useMemo(() => {
    if (!db) return []
    const q = search.trim().toLowerCase()
    return db.functions.filter((f) => {
      if (filter === 'matched' && !f.matched) return false
      if (filter === 'unmatched' && f.matched) return false
      if (moduleFilter && f.module !== moduleFilter) return false
      if (authorFilter && loginFor(f) !== authorFilter) return false
      if (q && !f.name.toLowerCase().includes(q) && !f.module.toLowerCase().includes(q) && !f.id.includes(q)) return false
      return true
    })
  }, [db, search, filter, moduleFilter, authorFilter, keyToLogin])

  const shown = useMemo(() => sortFns(filtered, sort).slice(0, 500), [filtered, sort])

  // keep the selected function visible in the right-hand list
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selectedFn) return
    listRef.current
      ?.querySelector(`[data-fnid="${CSS.escape(selectedFn.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedFn, shown])

  if (loading) return <div className="atlas center"><p className="hint">Loading Atlas…</p></div>

  if (!db) {
    return (
      <div className="atlas center">
        <div className="landing aero-panel" style={{ width: 'min(560px,100%)' }}>
          <Database size={34} color="var(--aero-primary)" />
          <h1 style={{ fontSize: 22 }}>No Atlas data yet</h1>
          <p className="tagline">
            {localAvailable
              ? "Generate this repo's data locally, or pull the team's live published data."
              : "This project isn't cloned here, so there's nothing local to generate. Pull its published data instead."}
          </p>
          <div className="actions" style={{ justifyContent: 'center' }}>
            {localAvailable && (
              <button className="aero-button" onClick={generate} disabled={generating}>
                <HardDrive size={15} style={{ verticalAlign: -3, marginRight: 6 }} />
                {generating ? 'Generating…' : 'Generate local data'}
              </button>
            )}
            {liveEnabled && (
              <button className="aero-button ghost" onClick={() => load('live')}>
                <Cloud size={15} style={{ verticalAlign: -3, marginRight: 6 }} /> Pull live data
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  const s = db.stats
  return (
    <div className={`atlas${fullAtlas ? ' full' : ''}`}>
      <div className="atlas-head aero-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Atlas</h2>
          {liveEnabled && localAvailable && (
            <div className="seg" title="Live = the whole team's published progress (recommended). Local = your generated data.">
              <button className={source === 'live' ? 'on' : ''} onClick={() => load('live')} title="Show the team's published progress"><Cloud size={12} /> Live</button>
              <button className={source === 'local' ? 'on' : ''} onClick={() => load('local')} title="Show your locally generated data"><HardDrive size={12} /> Local</button>
            </div>
          )}
          <span className="hint" style={{ margin: 0 }}>
            {source === 'live' ? 'live · everyone’s progress' : 'local'}{db.generatedAt ? ` · ${db.generatedAt}` : ''}
          </span>
          <div style={{ flex: 1 }} />
          {source === 'live' && (
            // No refresh button: Live is a push feed from the backend, so the map, the bars
            // and the contributor legend are already current to within seconds of a merge.
            <span className="hint" style={{ margin: 0 }} title="the backend pushes matches, claims and colors as they land">
              live · updates automatically
            </span>
          )}
          {source === 'local' && (
            <button className="mini-btn" onClick={generate} disabled={generating}>
              <RefreshCw size={12} className={generating ? 'spin' : ''} style={{ verticalAlign: -2, marginRight: 4 }} />
              {generating ? 'Generating…' : 'Regenerate'}
            </button>
          )}
        </div>

        <div className="atlas-stats">
          <div className="stat-bar">
            <div className="stat-label">Functions <b>{pct(s.matchedFunctions, s.totalFunctions)}</b> · {s.matchedFunctions.toLocaleString()} / {s.totalFunctions.toLocaleString()}</div>
            <div className="bar"><div className="fill" style={{ width: pct(s.matchedFunctions, s.totalFunctions) }} /></div>
          </div>
          <div className="stat-bar">
            <div className="stat-label">Code <b>{pct(s.matchedBytes, s.totalBytes)}</b> · {s.matchedBytes.toLocaleString()} / {s.totalBytes.toLocaleString()} b</div>
            <div className="bar"><div className="fill" style={{ width: pct(s.matchedBytes, s.totalBytes) }} /></div>
          </div>
        </div>

        {contributors.length > 0 && (
          <div className="contributors aero-scroll">
            <Users size={13} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--aero-muted)', flex: 'none' }} />
            {contributors.map(([name, n]) => (
              <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flex: 'none' }}>
                <button
                  className={`contrib${authorFilter === name ? ' sel' : ''}`}
                  onClick={() => setAuthorFilter(authorFilter === name ? null : name)}
                  title={authorFilter === name ? 'show everyone' : `show only ${name}`}
                >
                  <span className="cdot" style={{ background: authorColors.get(name) ?? '#8896a5' }} />
                  {name} <b>{n.toLocaleString()}</b>
                  {(recentByLogin.get(name) ?? 0) > 0 && (
                    <span className="contrib-recent" title={`${recentByLogin.get(name)} matched in the last 24h`}>
                      ▲{recentByLogin.get(name)}
                    </span>
                  )}
                </button>
              </span>
            ))}
            {authorFilter && (
              <button className="mini-btn" style={{ flex: 'none' }} onClick={() => setAuthorFilter(null)}>clear</button>
            )}
          </div>
        )}
        {liveEnabled && localAvailable && source === 'local' && (
          <p className="notice" style={{ marginTop: 8 }}>Working with others? Switch to <b>Live</b> for everyone&apos;s latest progress and claims.</p>
        )}
      </div>

      <div className="atlas-body">
      <div className="atlas-left">
      <ChaosViewer
        db={db}
        moduleFilter={moduleFilter}
        onModule={setModuleFilter}
        onFunction={(f) => {
          if (selectedFn?.id === f.id) {
            setSelectedFn(null)
            setModuleFilter(null)
          } else {
            setSelectedFn(f)
            if (layoutMode === 'ov') setModuleFilter(f.module)
          }
        }}
        onDeselectAll={clearSelection}
        selectedId={selectedFn?.id}
        cartRefs={draftRefs}
        onToggleCart={(f) => {
          if (f.matched) return // matched functions are done - never basket them (mirrors the detail panel)
          if (f.noMatch) return // reproduces the ROM with no match to chase - not work, never basket it
          if (f.claim && !draftRefs.has(f.name)) return // held by someone else on Live - don't basket it
          if (draftRefs.has(f.name)) onRemove(f.name)
          else
            onAdd({
              id: `${Date.now()}-${f.name}`,
              ref: f.name,
              label: f.module,
              module: f.module,
              addr: f.addr,
              size: f.size,
              srcPath: f.srcPath
            })
        }}
        onMarqueeSelect={(fns, add) => {
          // Right-drag box: unmatched, unclaimed functions it touches become the cart; Ctrl adds to
          // what's there. Claimed (active/partial in CLAIMS.md on Live) are skipped so the box never
          // baskets work someone else holds, and so are the red no-match-needed tiles.
          const items = fns
            .filter((f) => !f.matched && !f.claim && !f.noMatch)
            .map((f) => ({
              id: `${Date.now()}-${f.name}`,
              ref: f.name,
              label: f.module,
              module: f.module,
              addr: f.addr,
              size: f.size,
              srcPath: f.srcPath
            }))
          if (!items.length) return
          if (add) items.forEach(onAdd)
          else onReplace(items)
        }}
        colorBy={colorBy}
        authorColors={authorColors}
        authorResolve={keyToLogin}
        authorFilter={authorFilter}
        showNearMiss={showNearMiss}
        layout={layoutMode}
        starredIds={starredIds}
      />
      {/* Bottom bar INSIDE the map column, so "centered" means centered on the atlas box and the
          popout/fullscreen buttons sit at the map's bottom-right corner. */}
      <div className="atlas-bottombar">
        <div className="bb-left">
          <div className="seg">
            <button className={colorBy === 'status' ? 'on' : ''} onClick={() => pickColorBy('status')}>Status</button>
            <button className={colorBy === 'author' ? 'on' : ''} onClick={() => pickColorBy('author')}>Contributor</button>
          </div>
        </div>
        <div className="bb-center">
          <div className="seg">
            {(
              [
                ['ov', 'By ov'],
                ['size', 'By size'],
                ['match', 'By match'],
                ['contributor', 'By contributor']
              ] as Array<[LayoutMode, string]>
            ).map(([m, label]) => (
              <button key={m} className={layoutMode === m ? 'on' : ''} onClick={() => pickLayout(m)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="bb-right">
          <button
            className="mini-btn"
            onClick={() => setFullAtlas((v) => !v)}
            title={fullAtlas ? 'Exit fullscreen - bring back the stats and list' : 'Fullscreen - the map fills the window under the header'}
          >
            {fullAtlas ? <Minimize2 size={12} style={{ verticalAlign: -2 }} /> : <Maximize2 size={12} style={{ verticalAlign: -2 }} />}
          </button>
        </div>
      </div>
      </div>

      <div className="atlas-right">
      {selectedFn && (
        <div className="atlas-detail aero-panel atlas-detail-card">
          <div className="atlas-detail-top">
            <span className="ad-name mono">{selectedFn.name}</span>
            <span className="ad-meta">
              {selectedFn.module} · 0x{selectedFn.addr.toString(16).padStart(8, '0')} · {selectedFn.size}b ·{' '}
              {selectedFn.matched
                ? 'matched'
                : selectedFn.noMatch
                  ? 'needs no match'
                  : selectedFn.div != null
                    ? `near-miss (div ${selectedFn.div})`
                    : selectedFn.srcPath
                      ? 'draft'
                      : 'unmatched'}
            </span>
            <div style={{ flex: 1 }} />
            {!selectedFn.matched && !selectedFn.noMatch &&
              (draftRefs.has(selectedFn.name) ? (
                <button className="aero-button danger" onClick={() => onRemove(selectedFn.name)}>
                  <Minus size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
                  Remove from batch
                </button>
              ) : (
                <button
                  className="aero-button"
                  onClick={() =>
                    onAdd({
                      id: `${Date.now()}-${selectedFn.name}`,
                      ref: selectedFn.name,
                      label: selectedFn.module,
                      module: selectedFn.module,
                      addr: selectedFn.addr,
                      size: selectedFn.size,
                      srcPath: selectedFn.srcPath
                    })
                  }
                >
                  <Plus size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
                  Add to batch
                </button>
              ))}
            <button
              className="aero-button danger"
              title="Close this function and clear the whole batch selection"
              onClick={clearSelection}
            >
              <X size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
              Clear selection
            </button>
          </div>

          {/* Why this one is red and carries no Add button. The same sentence the map hovers. */}
          {selectedFn.noMatch && (
            <div className="ad-nomatch">
              <b>Needs no match</b>
              <span> {selectedFn.noMatch.reason}</span>
            </div>
          )}

          {/* Prior tries: plan before queueing — data from repo logs, not pasted into agent prompts */}
          <div className="ad-history">
            <div className="ad-history-head">
              <span className="ad-history-title">Prior tries</span>
              {historyLoading && <span className="hint">loading…</span>}
              {!historyLoading && history && (
                <span className="hint">
                  {history.attempts.length} attempt{history.attempts.length === 1 ? '' : 's'}
                  {history.tip ? ' · tip on disk' : ''}
                </span>
              )}
            </div>
            {history?.tip && (
              <div className="ad-tip">
                <b>Best tip</b>
                {history.tip.divergences != null ? ` · div ${history.tip.divergences}` : ''}
                {history.tip.source ? ` · ${history.tip.source}` : ''}
                {history.tip.hasCSource ? ' · C in nearmiss DB' : ''}
                {history.tip.srcPath && (
                  <button
                    className="path-link"
                    style={{ marginLeft: 8 }}
                    title={history.tip.srcPath}
                    onClick={() => window.tangos.revealPath(history.tip!.srcPath!)}
                  >
                    open tip path
                  </button>
                )}
              </div>
            )}
            {historyLoading ? null : history?.attempts.length ? (
              <ul className="ad-attempt-list">
                {history.attempts.map((a) => (
                  <li
                    key={a.attemptId}
                    className={`ad-attempt st-${a.status.replace(/[^a-z_]/gi, '')}`}
                    style={{ paddingLeft: 8 + a.depth * 12 }}
                    title={a.attemptId}
                  >
                    <span className={`ad-status st-${a.status}`}>{a.status}</span>
                    {a.divergences != null && a.status === 'near_miss' && (
                      <span className="ad-div">div {a.divergences}</span>
                    )}
                    {a.improvedNearMiss && <span className="ad-flag">↑</span>}
                    {/* Values only: "Grok 4.5 (high) · grok-build" — no model= keys, no timestamps */}
                    {(a.model || a.harness || a.reasoning) && (
                      <span className="ad-model mono">
                        {[
                          a.model
                            ? a.reasoning
                              ? `${a.model.replace(/-/g, ' ')} (${a.reasoning})`
                              : a.model.replace(/-/g, ' ')
                            : null,
                          a.harness || null
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                    {(a.usedNearMissDraft || a.usedGhidraDraft) && (
                      <span className="ad-flags">
                        {a.usedNearMissDraft ? 'nm' : ''}
                        {a.usedNearMissDraft && a.usedGhidraDraft ? '+' : ''}
                        {a.usedGhidraDraft ? 'gh' : ''}
                      </span>
                    )}
                    {a.note && <span className="ad-note">{a.note}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ad-empty hint">
                {history?.note ||
                  (historyLoading
                    ? ''
                    : // A banked draft (near-miss tip on disk, or a NONMATCHING src file) is not the
                      // same as a logged attempt: only the console driver writes MATCH_RESULT rows, so
                      // a hand-banked draft shows here with an empty history. Say the draft exists so
                      // "no attempts logged" is not misread as "no draft".
                      history?.tip || selectedFn.div != null || selectedFn.srcPath
                      ? 'Draft on record (see above) — no console attempts logged yet.'
                      : 'No draft and no attempts logged for this function yet.')}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="atlas-toolbar aero-panel">
        <div className="atlas-search">
          <Search size={14} />
          <input placeholder="Search function or module…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button className="run-icon" onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <select className="theme-select" value={filter} onChange={(e) => setFilter(e.target.value as 'all')}>
          <option value="all">all</option>
          <option value="unmatched">unmatched</option>
          <option value="matched">matched</option>
        </select>
        <select className="theme-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title="Sort by">
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <option key={k} value={k}>sort: {SORT_LABELS[k]}</option>
          ))}
        </select>
        <label className="tm-check" title="show near-misses in yellow on the map">
          <input type="checkbox" checked={showNearMiss} onChange={(e) => setShowNearMiss(e.target.checked)} />
          near-misses
        </label>
        {moduleFilter && <button className="mini-btn" onClick={() => setModuleFilter(null)}>{moduleFilter} <X size={11} style={{ verticalAlign: -1 }} /></button>}
        {moduleFilter && (
          <button className="mini-btn" onClick={() => window.tangos.openModulePopout(moduleFilter)} title={`open ${moduleFilter} in its own window`}>
            <ExternalLink size={12} style={{ verticalAlign: -2 }} />
          </button>
        )}
        <span className="hint" style={{ margin: 0 }}>showing {shown.length.toLocaleString()} of {filtered.length.toLocaleString()}</span>
      </div>

      <div className="atlas-list aero-panel aero-scroll" ref={listRef}>
        {shown.map((f) => {
          return (
            <div
              className={`fn-row${selectedFn?.id === f.id ? ' sel' : ''}`}
              data-fnid={f.id}
              key={f.id}
              style={{ cursor: 'pointer' }}
              title="Fly to this function on the map"
              onClick={() => setSelectedFn(f)}
            >
              <span
                className={`status-dot ${f.matched ? 'ok' : ''}`}
                style={f.matched ? {} : { background: f.noMatch ? 'var(--aero-nomatch, #a8324a)' : 'var(--aero-unmatched)' }}
                title={f.noMatch ? `needs no match: ${f.noMatch.reason}` : undefined}
              />
              <span className="fn-name mono">{f.name}</span>
              <span className="fn-mod">{f.module}</span>
              <span className="fn-author" title="author">{f.author ?? ''}</span>
              <span className="fn-size">{f.size}b</span>
              <span className="fn-add">
                {!f.matched && !f.claim && !f.noMatch && (draftRefs.has(f.name) ? (
                  <button
                    className="bubble-btn added"
                    title="Remove from batch"
                    onClick={(e) => { e.stopPropagation(); onRemove(f.name) }}
                  >
                    <Minus size={14} strokeWidth={2.5} />
                  </button>
                ) : (
                  <button
                    className="bubble-btn"
                    title="Add to batch"
                    onClick={(e) => { e.stopPropagation(); onAdd({ id: `${Date.now()}-${f.name}`, ref: f.name, label: f.module, module: f.module, addr: f.addr, size: f.size, srcPath: f.srcPath }) }}
                  >
                    <Plus size={14} strokeWidth={2.5} />
                  </button>
                ))}
              </span>
            </div>
          )
        })}
      </div>
      </div>
      </div>
    </div>
  )
}

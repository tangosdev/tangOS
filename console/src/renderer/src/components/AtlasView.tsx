import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search, Plus, Minus, X, Database, Cloud, HardDrive, Users, ExternalLink } from 'lucide-react'
import type { AtlasDb, AtlasFunction, BatchItem, GithubCredits } from '../../../shared/types'
import ChaosViewer from '../chaos/ChaosViewer'
import { sortFns, SORT_LABELS, type SortKey } from '../atlas/sort'

const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(1)}%` : '0%')
const PALETTE = [
  '#4363d8', '#e6194B', '#3cb44b', '#f58231', '#911eb4', '#00a0b0', '#f032e6', '#469990',
  '#9A6324', '#a83232', '#808000', '#7d4bd8', '#0ea5e9', '#d97706', '#059669', '#db2777'
]

export default function AtlasView({
  onAdd,
  onRemove,
  draftRefs,
  liveEnabled
}: {
  onAdd: (item: BatchItem) => void
  onRemove: (ref: string) => void
  draftRefs: Set<string>
  liveEnabled: boolean
}): JSX.Element {
  const [db, setDb] = useState<AtlasDb | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [source, setSource] = useState<'local' | 'live'>('local')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'unmatched' | 'matched'>('all')
  const [moduleFilter, setModuleFilter] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('unmatched')
  const [colorBy, setColorBy] = useState<'status' | 'author'>('status')
  const [authorFilter, setAuthorFilter] = useState<string | null>(null)
  const [showNearMiss, setShowNearMiss] = useState(true)
  const [selectedFn, setSelectedFn] = useState<AtlasFunction | null>(null)
  const [gh, setGh] = useState<GithubCredits | null>(null)
  const [recentStems, setRecentStems] = useState<Set<string>>(new Set()) // fn names matched in last 24h

  useEffect(() => {
    window.tangos.githubCredits().then(setGh).catch(() => {})
    let alive = true
    // functions matched (src added to origin/main) in the last 24h - drives the green ▲ per contributor
    window.tangos.recentAdds(24).then((s) => alive && setRecentStems(new Set(s))).catch(() => {})
    window.tangos
      .viewerPrefsGet()
      .then((p) => {
        if (!alive) return
        setColorBy(p.contributorColors ? 'author' : 'status')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const pickColorBy = (c: 'status' | 'author'): void => {
    setColorBy(c)
    void window.tangos.viewerPrefsSet({ contributorColors: c === 'author' }).catch(() => {})
  }

  // data-file author key -> canonical GitHub login (dedups an email-derived key vs the GitHub login, etc.)
  const keyToLogin = useMemo(() => new Map(Object.entries(gh?.keyToLogin ?? {})), [gh])
  const loginFor = (f: AtlasFunction): string => (f.author ? keyToLogin.get(f.author) ?? f.author : '')

  // matched-function count per canonical login, seeded with everyone who has a PR/commit
  const loginCounts = useMemo(() => {
    const m = new Map<string, number>()
    if (db) for (const f of db.functions) if (f.matched && f.author) {
      const login = keyToLogin.get(f.author) ?? f.author
      if (/\[bot\]$/i.test(login)) continue
      m.set(login, (m.get(login) ?? 0) + 1)
    }
    for (const l of gh?.logins ?? []) if (!m.has(l.login)) m.set(l.login, 0)
    for (const p of gh?.prAuthors ?? []) if (!m.has(p)) m.set(p, 0)
    return m
  }, [db, gh, keyToLogin])

  // matched-in-the-last-24h count per canonical login (the green ▲ badge in the legend)
  const recentByLogin = useMemo(() => {
    const m = new Map<string, number>()
    if (db && recentStems.size) for (const f of db.functions) {
      if (!f.matched || !f.author || !recentStems.has(f.name)) continue
      const login = keyToLogin.get(f.author) ?? f.author
      if (/\[bot\]$/i.test(login)) continue
      m.set(login, (m.get(login) ?? 0) + 1)
    }
    return m
  }, [db, recentStems, keyToLogin])

  const authorColors = useMemo(() => {
    const out = new Map<string, string>()
    ;[...loginCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([name], i) => out.set(name, PALETTE[i % PALETTE.length]))
    return out
  }, [loginCounts])

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
      }
      await load('local')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          <p className="tagline">Generate this repo&apos;s data locally, or pull the team&apos;s live published data.</p>
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button className="aero-button" onClick={generate} disabled={generating}>
              <HardDrive size={15} style={{ verticalAlign: -3, marginRight: 6 }} />
              {generating ? 'Generating…' : 'Generate local data'}
            </button>
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
    <div className="atlas">
      <div className="atlas-head aero-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Atlas</h2>
          {liveEnabled && (
            <div className="seg" title="Live = the whole team's published progress (recommended). Local = your generated data.">
              <button className={source === 'live' ? 'on' : ''} onClick={() => load('live', true)}><Cloud size={12} /> Live</button>
              <button className={source === 'local' ? 'on' : ''} onClick={generate} title="Recount from your repo (reads src/ + symbols now)"><HardDrive size={12} /> Local</button>
            </div>
          )}
          <span className="hint" style={{ margin: 0 }}>
            {source === 'live' ? 'live · everyone’s progress' : 'local'}{db.generatedAt ? ` · ${db.generatedAt}` : ''}
          </span>
          <div style={{ flex: 1 }} />
          {source === 'live' && (
            <button className="mini-btn" onClick={() => load('live', true)} disabled={loading} title="re-fetch the team's latest published progress (bypasses cache)">
              <RefreshCw size={12} className={loading ? 'spin' : ''} style={{ verticalAlign: -2, marginRight: 4 }} />
              Refresh
            </button>
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
              <button
                key={name}
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
            ))}
            {authorFilter && (
              <button className="mini-btn" style={{ flex: 'none' }} onClick={() => setAuthorFilter(null)}>clear</button>
            )}
          </div>
        )}
        {liveEnabled && source === 'local' && (
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
            setModuleFilter(f.module)
          }
        }}
        selectedId={selectedFn?.id}
        colorBy={colorBy}
        onColorBy={pickColorBy}
        authorColors={authorColors}
        authorResolve={keyToLogin}
        authorFilter={authorFilter}
        showNearMiss={showNearMiss}
      />
      </div>

      <div className="atlas-right">
      {selectedFn && (
        <div className="atlas-detail aero-panel">
          <span className="ad-name mono">{selectedFn.name}</span>
          <span className="ad-meta">
            {selectedFn.module} · 0x{selectedFn.addr.toString(16).padStart(8, '0')} · {selectedFn.size}b ·{' '}
            {selectedFn.matched
              ? 'matched'
              : selectedFn.div != null
                ? `near-miss (div ${selectedFn.div})`
                : selectedFn.srcPath
                  ? 'draft'
                  : 'unmatched'}
          </span>
          <div style={{ flex: 1 }} />
          {!selectedFn.matched &&
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
          <button className="run-icon" title="close" onClick={() => { setSelectedFn(null); setModuleFilter(null) }}>
            <X size={14} />
          </button>
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
            <div className={`fn-row${selectedFn?.id === f.id ? ' sel' : ''}`} data-fnid={f.id} key={f.id}>
              <span className={`status-dot ${f.matched ? 'ok' : ''}`} style={f.matched ? {} : { background: 'var(--aero-unmatched)' }} />
              <span className="fn-name mono">{f.name}</span>
              <span className="fn-mod">{f.module}</span>
              <span className="fn-author" title="author">{f.author ?? ''}</span>
              <span className="fn-size">{f.size}b</span>
              <span className="fn-add">
                {!f.matched && (draftRefs.has(f.name) ? (
                  <button
                    className="bubble-btn added"
                    title="Remove from batch"
                    onClick={() => onRemove(f.name)}
                  >
                    <Minus size={14} strokeWidth={2.5} />
                  </button>
                ) : (
                  <button
                    className="bubble-btn"
                    title="Add to batch"
                    onClick={() => onAdd({ id: `${Date.now()}-${f.name}`, ref: f.name, label: f.module, module: f.module, addr: f.addr, size: f.size, srcPath: f.srcPath })}
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

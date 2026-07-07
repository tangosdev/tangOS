import { useEffect, useMemo, useState } from 'react'
import { X, Plus } from 'lucide-react'
import Treemap from './Treemap'
import WindowControls from './WindowControls'
import { sortFns, SORT_LABELS, type SortKey } from '../atlas/sort'
import type { AtlasDb, AtlasFunction, Claim } from '../../../shared/types'

function addToBatch(f: AtlasFunction): void {
  window.tangos.addDraftItem({ id: `${Date.now()}-${f.name}`, ref: f.name, label: f.module, module: f.module, addr: f.addr, size: f.size, srcPath: f.srcPath })
}

export default function ModulePopout({ module }: { module: string }): JSX.Element {
  const [db, setDb] = useState<AtlasDb | null>(null)
  const [claims, setClaims] = useState<Claim[]>([])
  const [whoami, setWhoami] = useState<{ hasKey: boolean; handle: string }>({ hasKey: false, handle: '' })
  const [sel, setSel] = useState<AtlasFunction | null>(null)
  const [sort, setSort] = useState<SortKey>('unmatched')

  useEffect(() => {
    document.title = `tangOS · ${module}`
    ;(async () => {
      // reuse the data the main window already loaded (never fetches -> no hang)
      let data: AtlasDb | null = null
      try {
        data = await window.tangos.atlasCurrent()
      } catch {
        /* ignore */
      }
      setDb(data)
      try {
        const cl = await window.tangos.claimsList()
        setClaims(cl.claims)
        setWhoami(cl.whoami)
      } catch {
        /* no claims */
      }
    })()
  }, [module])

  const moduleDb = useMemo<AtlasDb | null>(() => {
    if (!db) return null
    const functions = db.functions.filter((f) => f.module === module)
    const matched = functions.filter((f) => f.matched)
    return {
      generatedAt: db.generatedAt,
      stats: {
        totalFunctions: functions.length,
        matchedFunctions: matched.length,
        totalBytes: functions.reduce((s, f) => s + f.size, 0),
        matchedBytes: matched.reduce((s, f) => s + f.size, 0),
        moduleCount: 1
      },
      functions
    }
  }, [db, module])

  function claimFor(f: AtlasFunction): Claim | null {
    return claims.find((c) => c.module === f.module && f.addr < Number(c.end) && f.addr + f.size > Number(c.start)) ?? null
  }

  const funcs = useMemo(() => (moduleDb ? sortFns(moduleDb.functions, sort) : []), [moduleDb, sort])

  const s = moduleDb?.stats

  return (
    <div className="popout">
      <div className="pop-head">
        <span className="pop-title">{module}</span>
        {s && <span className="hint" style={{ margin: 0 }}>{s.matchedFunctions}/{s.totalFunctions} matched · {s.totalBytes.toLocaleString()} b</span>}
        <div style={{ flex: 1 }} />
        <WindowControls />
      </div>

      {!moduleDb ? (
        <div className="center-stage"><p className="hint">Loading {module}…</p></div>
      ) : (
        <div className="ds">
          <div className="ds-screen top">
            <Treemap db={moduleDb} moduleFilter={null} onModule={() => {}} onFunction={setSel} selectedId={sel?.id} square />
          </div>

          <div className="ds-screen bottom aero-scroll">
            {sel && (
              <div className="fn-detail" style={{ marginBottom: 10 }}>
                <div className="fd-head">
                  <span className={`status-dot ${sel.matched ? 'ok' : ''}`} style={sel.matched ? {} : { background: 'var(--aero-unmatched)' }} />
                  <h3 className="mono">{sel.name}</h3>
                  <span className={`aero-badge ${sel.matched ? 'ro' : 'mutating'}`}>{sel.matched ? 'matched' : 'unmatched'}</span>
                  <div style={{ flex: 1 }} />
                  <button className="dock-close" onClick={() => setSel(null)}><X size={16} /></button>
                </div>
                <div className="fd-grid">
                  <div><span className="k">module</span><span className="v">{sel.module}</span></div>
                  <div><span className="k">address</span><span className="v mono">0x{sel.addr.toString(16)}</span></div>
                  <div><span className="k">size</span><span className="v">{sel.size} b</span></div>
                  {sel.author && <div><span className="k">author</span><span className="v">{sel.author}</span></div>}
                  {typeof sel.div === 'number' && <div><span className="k">near-miss</span><span className="v">div {sel.div}</span></div>}
                  {sel.cat && <div><span className="k">category</span><span className="v">{sel.cat}</span></div>}
                  {sel.floor && <div><span className="k">floor</span><span className="v">{sel.floor}</span></div>}
                  {sel.sibling && <div><span className="k">closest match</span><span className="v mono">{sel.sibling}{sel.sim ? ` (${sel.sim})` : ''}</span></div>}
                  {sel.srcPath && <div><span className="k">source</span><span className="v mono">{sel.srcPath}</span></div>}
                  {(() => {
                    const c = claimFor(sel)
                    return c ? <div><span className="k">claim</span><span className="v">{c.handle}{c.note ? ` — ${c.note}` : ''}</span></div> : null
                  })()}
                </div>
                {!sel.matched && (
                  <button
                    className="aero-button"
                    style={{ marginTop: 12 }}
                    disabled={!!claimFor(sel) && claimFor(sel)!.handle !== whoami.handle}
                    onClick={() => addToBatch(sel)}
                  >
                    <Plus size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> Add to batch
                  </button>
                )}
              </div>
            )}

            <div className="pop-sort">
              <select className="theme-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title="Sort by">
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                  <option key={k} value={k}>sort: {SORT_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div className="pop-list">
              {funcs.map((f) => {
                const c = claimFor(f)
                const claimedByOther = !!c && c.handle !== whoami.handle
                return (
                  <div key={f.id} className={`fn-row2 ${sel?.id === f.id ? 'sel' : ''}`} onClick={() => setSel(f)}>
                    <span className={`status-dot ${f.matched ? 'ok' : ''}`} style={f.matched ? {} : { background: 'var(--aero-unmatched)' }} />
                    <span className="fn-name mono">{f.name}</span>
                    {c && <span className="claim-chip other" title={`claimed by ${c.handle}`}>{c.handle}</span>}
                    <span className="fn-size">{f.size}b</span>
                    <span className="fn-add2" onClick={(e) => e.stopPropagation()}>
                      {!f.matched && (
                        <button
                          className="bubble-btn"
                          disabled={claimedByOther}
                          title={claimedByOther ? `claimed by ${c!.handle}` : 'Add to batch'}
                          onClick={() => addToBatch(f)}
                        >
                          <Plus size={13} strokeWidth={2.5} />
                        </button>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

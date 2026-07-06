import { useMemo, useState } from 'react'
import { ChevronRight, Check, SlidersHorizontal } from 'lucide-react'
import type { RepoState, TangosTool } from '../../../shared/types'
import RunDock from './RunDock'

export default function ToolPalette({
  repo,
  allowMutations,
  enabledIds,
  onSetEnabled
}: {
  repo: RepoState
  allowMutations: boolean
  enabledIds: string[]
  onSetEnabled: (ids: string[]) => void
}): JSX.Element {
  const desc = repo.descriptor!
  const python = desc.runtime?.python ?? 'python'
  const [openCats, setOpenCats] = useState<Set<string>>(new Set())
  const [dockToolId, setDockToolId] = useState<string | null>(null)

  const enabled = useMemo(() => new Set(enabledIds), [enabledIds])
  const allIds = useMemo(() => desc.tools.map((t) => t.id), [desc])

  const grouped = useMemo(() => {
    const cats = (desc.categories ?? []).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    const known = new Set(cats.map((c) => c.id))
    const buckets: { id: string; label: string; tools: TangosTool[] }[] = cats.map((c) => ({
      id: c.id,
      label: c.label ?? c.id,
      tools: []
    }))
    const other: TangosTool[] = []
    for (const t of desc.tools) {
      const b = buckets.find((x) => x.id === t.category)
      if (t.category && known.has(t.category) && b) b.tools.push(t)
      else other.push(t)
    }
    if (other.length) buckets.push({ id: '_other', label: 'Other', tools: other })
    return buckets.filter((b) => b.tools.length)
  }, [desc])

  const dockTool = desc.tools.find((t) => t.id === dockToolId) || null
  const allSelected = enabledIds.length === allIds.length

  function toggleCat(id: string): void {
    setOpenCats((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleTool(id: string): void {
    const next = new Set(enabled)
    next.has(id) ? next.delete(id) : next.add(id)
    onSetEnabled([...next])
  }

  return (
    <>
      <div className="panel aero-panel">
        <h2>Tools</h2>
        <div className="tools-head">
          <span className="count">
            {enabledIds.length} / {allIds.length} exposed to the AI
          </span>
          <button className="mini-btn" onClick={() => onSetEnabled(allSelected ? [] : allIds)}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>

        {grouped.map((b) => {
          const open = openCats.has(b.id)
          const on = b.tools.filter((t) => enabled.has(t.id)).length
          return (
            <div className="cat-wrap" key={b.id}>
              <button className={`cat-bubble${open ? ' open' : ''}`} onClick={() => toggleCat(b.id)}>
                <ChevronRight className="chev" size={16} />
                <span className="cname">{b.label}</span>
                <span className="ccount">{on}/{b.tools.length}</span>
              </button>
              <div className={`cat-body${open ? ' open' : ''}`}>
                <div className="cat-inner">
                  <div>
                    {b.tools.map((t) => {
                      const sel = enabled.has(t.id)
                      return (
                        <div
                          key={t.id}
                          className={`tool-row ${sel ? 'selected' : 'deselected'}`}
                          onClick={() => toggleTool(t.id)}
                          title={sel ? 'Exposed to the AI — click to hide' : 'Hidden from the AI — click to expose'}
                        >
                          <span className="sel-dot">{sel ? <Check size={10} color="#fff" strokeWidth={4} /> : null}</span>
                          <span className="tl">
                            <span className="lbl">{t.label ?? t.id}</span>
                            <span className="id"> {t.id}</span>
                          </span>
                          <span className={`aero-badge ${t.readOnly ? 'ro' : 'mutating'}`}>
                            {t.readOnly ? 'read' : 'writes'}
                          </span>
                          <button
                            className="run-icon"
                            title="Open run panel"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDockToolId(t.id)
                            }}
                          >
                            <SlidersHorizontal size={15} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {dockTool && (
        <RunDock
          key={dockTool.id}
          tool={dockTool}
          python={python}
          allowMutations={allowMutations}
          onClose={() => setDockToolId(null)}
        />
      )}
    </>
  )
}

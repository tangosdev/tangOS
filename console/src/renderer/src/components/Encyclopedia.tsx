import { useMemo, useState } from 'react'
import { Search, SlidersHorizontal, ChevronRight, EyeOff, X } from 'lucide-react'
import type { RepoState, TangosTool, TangosCategory } from '../../../shared/types'
import RunDock from './RunDock'

/** The Encyclopedia: the repo's whole tool surface as a reference, not a control panel.
 *  Tools are for the AI - the human mostly needs to LOOK THINGS UP (what does fdiff do,
 *  what args does match need), so this reads like an encyclopedia: searchable, grouped by
 *  category with the category's own blurb, each entry expanding to its full description,
 *  arguments, and command template. Run (the manual dock) and the rarely-used hide-from-AI
 *  toggle live inside each entry instead of being the whole UI. Full-screen overlay, opened
 *  from the paper button in the Chaos Controller footer. */
export default function Encyclopedia({
  repo,
  allowMutations,
  enabledIds,
  onSetEnabled,
  onClose
}: {
  repo: RepoState
  allowMutations: boolean
  enabledIds: string[]
  onSetEnabled: (ids: string[]) => void
  onClose: () => void
}): JSX.Element {
  const desc = repo.descriptor!
  const python = desc.runtime?.python ?? 'python'
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [dockToolId, setDockToolId] = useState<string | null>(null)
  const enabled = useMemo(() => new Set(enabledIds), [enabledIds])

  const grouped = useMemo(() => {
    const cats: TangosCategory[] = (desc.categories ?? []).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    const needle = q.trim().toLowerCase()
    const hit = (t: TangosTool): boolean =>
      !needle ||
      t.id.toLowerCase().includes(needle) ||
      (t.label ?? '').toLowerCase().includes(needle) ||
      (t.description ?? '').toLowerCase().includes(needle) ||
      (t.args ?? []).some((a) => a.name.toLowerCase().includes(needle))
    const buckets = cats.map((c) => ({
      cat: c,
      tools: desc.tools.filter((t) => t.category === c.id && hit(t))
    }))
    const known = new Set(cats.map((c) => c.id))
    const other = desc.tools.filter((t) => (!t.category || !known.has(t.category)) && hit(t))
    if (other.length) buckets.push({ cat: { id: '_other', label: 'Other' }, tools: other })
    return buckets.filter((b) => b.tools.length)
  }, [desc, q])

  const hiddenCount = desc.tools.length - enabledIds.length
  const dockTool = desc.tools.find((t) => t.id === dockToolId) || null

  function toggleHidden(id: string): void {
    const next = new Set(enabled)
    next.has(id) ? next.delete(id) : next.add(id)
    onSetEnabled([...next])
  }

  return (
    <div className="ency-scrim" onClick={onClose}>
      <div className="ency panel aero-panel solid" onClick={(e) => e.stopPropagation()}>
        <div className="ency-head">
          <h2>Encyclopedia</h2>
          <span className="hint" style={{ margin: 0 }}>
            Every tool this repo gives the AIs - what it does, its arguments, and how it gets called.
            {hiddenCount > 0 && ` ${hiddenCount} currently hidden from the AI.`}
          </span>
          <div style={{ flex: 1 }} />
          <div className="ency-search">
            <Search size={14} />
            <input
              autoFocus
              placeholder="Search tools, args, descriptions…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button className="dock-close" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="ency-scroll aero-scroll">
          {grouped.length === 0 && <p className="hint">Nothing matches "{q}".</p>}

          {grouped.map(({ cat, tools }) => (
            <section className="ency-cat" key={cat.id}>
              <div className="ency-cat-head">
                <h3>{cat.label ?? cat.id}</h3>
                {cat.description && <span className="hint" style={{ margin: 0 }}>{cat.description}</span>}
              </div>
              {tools.map((t) => {
                const open = openId === t.id
                const hidden = !enabled.has(t.id)
                return (
                  <div className={`ency-entry${open ? ' open' : ''}${hidden ? ' hidden-tool' : ''}`} key={t.id}>
                    <button className="ency-row" onClick={() => setOpenId(open ? null : t.id)}>
                      <ChevronRight size={13} className="settings-info-caret" style={open ? { transform: 'rotate(90deg)' } : {}} />
                      <span className="ency-lbl">{t.label ?? t.id}</span>
                      <span className="ency-id mono">{t.id}</span>
                      <span className={`aero-badge ${t.readOnly ? 'ro' : 'mutating'}`}>{t.readOnly ? 'read' : 'writes'}</span>
                      {hidden && <span className="aero-badge" title="Not exposed to the AI"><EyeOff size={10} style={{ verticalAlign: -1 }} /> hidden</span>}
                    </button>
                    {open && (
                      <div className="ency-body">
                        {t.description && <p className="ency-desc">{t.description}</p>}
                        {t.needs && t.needs.length > 0 && (
                          <p className="hint" style={{ margin: '0 0 6px' }}>Requires: {t.needs.join(', ')}</p>
                        )}
                        {t.args && t.args.length > 0 && (
                          <table className="ency-args">
                            <thead>
                              <tr><th>arg</th><th>flag</th><th>type</th><th></th></tr>
                            </thead>
                            <tbody>
                              {t.args.map((a) => (
                                <tr key={a.name}>
                                  <td className="mono">{a.name}{a.required ? ' *' : ''}</td>
                                  <td className="mono">{a.flag ?? (a.positional ? '(positional)' : '')}</td>
                                  <td>{a.type}{a.default !== undefined ? ` = ${String(a.default)}` : ''}</td>
                                  <td>{a.description ?? ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        <code className="ency-cmd mono">{t.command}</code>
                        {t.apply && (
                          <p className="hint" style={{ margin: '4px 0 0' }}>
                            Dry-run by default; pass {t.apply} to actually write changes.
                          </p>
                        )}
                        <div className="ency-actions">
                          <button className="mini-btn go" onClick={() => setDockToolId(t.id)}>
                            <SlidersHorizontal size={12} /> Run it yourself
                          </button>
                          <button
                            className="mini-btn"
                            title={hidden ? 'Expose this tool to the AI again' : 'Hide this tool from the AI (rarely needed - Writes already gates mutations)'}
                            onClick={() => toggleHidden(t.id)}
                          >
                            <EyeOff size={12} /> {hidden ? 'Expose to AI' : 'Hide from AI'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ))}
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
      </div>
    </div>
  )
}

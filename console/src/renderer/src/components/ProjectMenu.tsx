import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { ProjectSummary } from '../../../shared/types'
import { useDismiss } from '../useDismiss'

/** The project switcher, sitting next to the wordmark. Which decomp the whole console is pointed
 *  at - the Controller's tools and agents, and the Viewer's atlas, both follow it. */
export default function ProjectMenu({
  projects,
  busy,
  onPick
}: {
  projects: ProjectSummary[]
  busy: boolean
  onPick: (id: string) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))
  const active = projects.find((p) => p.active)
  if (!projects.length) return null

  return (
    <div className="pop-wrap" data-tour="project" ref={ref}>
      <button
        className={`app-switch-btn project-pick${open ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title={active?.path ?? active?.github ?? undefined}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {active && <span className="glyph">{active.glyph}</span>}
        <span className="t">{active?.title ?? 'Choose a project'}</span>
        <ChevronDown size={14} className={`caret${open ? ' up' : ''}`} />
      </button>
      <div className={`app-menu aero-panel${open ? ' open' : ''}`} role="menu">
        {projects.map((p) => (
          <button
            key={p.id}
            role="menuitem"
            className={`app-menu-item${p.active ? ' sel' : ''}`}
            onClick={() => {
              setOpen(false)
              if (!p.active) onPick(p.id)
            }}
          >
            <span className="glyph">{p.glyph}</span>
            <span className="t">{p.title}</span>
            {!p.cloned && <span className="sub">viewer only</span>}
            {p.active && <Check size={13} style={{ flex: 'none', opacity: 0.8 }} />}
          </button>
        ))}
      </div>
    </div>
  )
}

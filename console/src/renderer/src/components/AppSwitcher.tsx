import { useEffect, useRef, useState } from 'react'
import { ChevronDown, TerminalSquare, LayoutGrid } from 'lucide-react'

export type AppView = 'console' | 'atlas'

const APPS: { id: AppView; name: string; icon: JSX.Element }[] = [
  { id: 'console', name: 'Chaos Tools', icon: <TerminalSquare size={15} /> },
  { id: 'atlas', name: 'Chaos Viewer', icon: <LayoutGrid size={15} /> }
]

export default function AppSwitcher({
  view,
  onSwitch
}: {
  view: AppView
  onSwitch: (v: AppView) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = APPS.find((a) => a.id === view) ?? APPS[0]

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="brand">
      <span>tang<span className="os">OS</span></span>
      <div className="pop-wrap" ref={ref}>
        <button className="app-switch-btn" onClick={() => setOpen((o) => !o)}>
          {current.icon}
          {current.name}
          <ChevronDown size={14} style={{ opacity: 0.6 }} />
        </button>
        <div className={`app-menu aero-panel${open ? ' open' : ''}`}>
          {APPS.map((a) => (
            <button
              key={a.id}
              className={`app-menu-item${a.id === view ? ' sel' : ''}`}
              onClick={() => {
                setOpen(false)
                onSwitch(a.id)
              }}
            >
              {a.icon}
              {a.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

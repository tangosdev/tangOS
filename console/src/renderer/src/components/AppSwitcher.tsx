import type { CSSProperties } from 'react'

export type AppView = 'console' | 'atlas'

const APPS: { id: AppView; name: string }[] = [
  { id: 'console', name: 'Chaos Controller' },
  { id: 'atlas', name: 'Chaos Viewer' }
]

/** Top-middle segmented slide toggle: the thumb slides to the active app; clicking a
 *  segment switches (App.tsx runs the splash). */
export default function AppSwitcher({
  view,
  onSwitch
}: {
  view: AppView
  onSwitch: (v: AppView) => void
}): JSX.Element {
  const idx = Math.max(0, APPS.findIndex((a) => a.id === view))
  return (
    <div className="app-seg" data-tour="toggle" style={{ '--i': idx } as CSSProperties}>
      <span className="app-seg-thumb" />
      {APPS.map((a) => (
        <button key={a.id} className={a.id === view ? 'on' : ''} onClick={() => onSwitch(a.id)}>
          {a.name}
        </button>
      ))}
    </div>
  )
}

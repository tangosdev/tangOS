import { useEffect, useState } from 'react'
import { Check, X, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import type { RepoState, PreflightItem } from '../../../shared/types'

export default function Requirements({
  repo,
  onStatus
}: {
  repo: RepoState
  onStatus?: (allOk: boolean) => void
}): JSX.Element | null {
  const [items, setItems] = useState<PreflightItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)

  async function check(): Promise<void> {
    setBusy(true)
    try {
      setItems(await window.tangos.preflight())
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.path])

  const allOk = !!items && items.length > 0 && items.every((i) => i.ok)

  useEffect(() => {
    if (items) onStatus?.(allOk)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  const req = repo.descriptor?.requirements
  const anyRequired = !!req && (req.rom || !!req.compiler || !!req.pythonPackages?.length)
  if (!anyRequired) return null

  // All satisfied -> a tiny chip (click to peek at the details).
  if (allOk && !expanded) {
    return (
      <button className="panel aero-panel req-compact" onClick={() => setExpanded(true)} title="Show details">
        <span className="req-ico" style={{ background: 'rgb(var(--aero-matched-rgb))' }}>
          <Check size={11} strokeWidth={3} />
        </span>
        <span className="req-compact-text">Requirements — all set</span>
        <ChevronDown size={13} style={{ opacity: 0.5 }} />
      </button>
    )
  }

  return (
    <div className="panel aero-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ flex: 1 }}>This repo needs</h2>
        {allOk && <span className="aero-badge ro">all set</span>}
        {allOk && (
          <button className="dock-close" onClick={() => setExpanded(false)} title="Collapse">
            <ChevronUp size={14} />
          </button>
        )}
        <button className="dock-close" onClick={check} title="Re-check" disabled={busy}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} />
        </button>
      </div>

      {!items ? (
        <p className="hint">Checking…</p>
      ) : (
        <ul className="req-list">
          {items.map((it) => (
            <li key={it.id} className={`req-item ${it.ok ? 'ok' : 'bad'}`}>
              <span className="req-ico">{it.ok ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}</span>
              <span className="req-text">
                <span className="req-label">{it.label}</span>
                <span className="req-detail">{it.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {req?.notes && !allOk && <p className="notice">{req.notes}</p>}
    </div>
  )
}

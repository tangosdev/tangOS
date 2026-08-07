import { useEffect, useState } from 'react'
import { Check, X, RefreshCw, ChevronDown, ChevronUp, Copy, Wrench } from 'lucide-react'
import type { RepoState, PreflightItem } from '../../../shared/types'

/** A failing requirement's how-to-fix line: a button that performs the fix where Console can, the
 *  sentence, and the click-to-copy command for anyone who would rather run it themselves. */
function FixHint({ item, onFixed }: { item: PreflightItem; onFixed: () => void }): JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  if (item.ok || (!item.fix && !item.fixCmd)) return null

  async function runFix(): Promise<void> {
    if (!item.fixAction) return
    if (item.fixConfirm && !window.confirm(item.fixConfirm)) return
    let filePath: string | undefined
    if (item.fixNeedsFile) {
      // Cancelling the picker is a decision, not a failure - leave the row untouched and silent.
      const picked = await window.tangos.pickFixFile(item.fixNeedsFile.title, item.fixNeedsFile.extensions)
      if (!picked) return
      filePath = picked
    }
    setBusy(true)
    setResult(null)
    try {
      const r = await window.tangos.preflightFix(item.fixAction, filePath)
      setResult(r)
      if (r.ok) onFixed()
    } catch (e) {
      setResult({ ok: false, message: String((e as Error).message ?? e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="req-fix">
      {item.fixAction && (
        <button className="mini-btn go req-fix-btn" disabled={busy} onClick={runFix}>
          {busy ? <RefreshCw size={11} className="spin" /> : <Wrench size={11} />}{' '}
          {busy ? 'Working…' : item.fixLabel ?? 'Fix this'}
        </button>
      )}
      {item.fix}
      {item.fixCmd && (
        <button
          className="req-fix-cmd mono"
          title="Copy this command"
          onClick={async () => {
            await window.tangos.copy(item.fixCmd!)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1800)
          }}
        >
          {item.fixCmd} {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      )}
      {result && <span className={`req-fix-result ${result.ok ? 'ok' : 'bad'}`}>{result.message}</span>}
    </span>
  )
}

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
  // The function-data check comes from descriptor.data rather than requirements, so a repo that
  // declares no requirements at all can still have something here worth showing.
  const anyRequired =
    (!!req && (req.rom || !!req.compiler || !!req.pythonPackages?.length)) ||
    !!items?.some((i) => i.id === 'chaosdb')
  if (!anyRequired) return null

  // All satisfied -> a tiny chip (click to peek at the details).
  if (allOk && !expanded) {
    return (
      <button className="panel aero-panel req-compact" onClick={() => setExpanded(true)} title="Show details">
        <span className="req-ico" style={{ background: 'rgb(var(--aero-matched-rgb))' }}>
          <Check size={11} strokeWidth={3} />
        </span>
        <span className="req-compact-text">Requirements - all set</span>
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
                <FixHint item={it} onFixed={check} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {req?.notes && !allOk && <p className="notice">{req.notes}</p>}
    </div>
  )
}

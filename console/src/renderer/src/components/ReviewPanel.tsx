import { useState } from 'react'
import { GitBranch, GitMerge, Trash2, ChevronDown, ChevronUp, FilePlus, FileText } from 'lucide-react'
import type { Review } from '../../../shared/types'

function DiffLines({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n').slice(0, 200)
  return (
    <pre className="diff">
      {lines.map((l, i) => {
        const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''
        return (
          <div key={i} className={`dl ${cls}`}>{l || ' '}</div>
        )
      })}
    </pre>
  )
}

export default function ReviewPanel({
  reviews,
  baseBranch
}: {
  reviews: Review[]
  baseBranch: string | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileCount = reviews.reduce((n, r) => n + r.files.length, 0)

  async function merge(): Promise<void> {
    setBusy(true)
    try {
      await window.tangos.mergeReview()
    } catch (e) {
      alert(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }
  async function discard(): Promise<void> {
    if (!confirm(`Discard all ${fileCount} change(s) on tangos/work? This deletes the work branch.`)) return
    setBusy(true)
    try {
      await window.tangos.discardReview()
    } catch (e) {
      alert(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="review-panel aero-panel">
      <div className="review-head" onClick={() => setOpen((o) => !o)}>
        <GitBranch size={15} color="#eab308" />
        <span className="rp-title">
          <b>{fileCount}</b> change{fileCount === 1 ? '' : 's'} pending review on <span className="mono">tangos/work</span>
          {baseBranch ? <> → <span className="mono">{baseBranch}</span></> : null}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="aero-button"
          onClick={(e) => { e.stopPropagation(); merge() }}
          disabled={busy}
        >
          <GitMerge size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
          Merge to {baseBranch ?? 'base'}
        </button>
        <button className="aero-button ghost danger" onClick={(e) => { e.stopPropagation(); discard() }} disabled={busy}>
          <Trash2 size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
          Discard
        </button>
        <button className="dock-close" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {open && (
        <div className="review-body aero-scroll">
          {reviews.map((r) => (
            <div className="review-item" key={r.id}>
              <div className="ri-head">
                <span className="aero-badge mutating">{r.toolId}</span>
                <span className="hint" style={{ margin: 0 }}>{r.files.length} file{r.files.length === 1 ? '' : 's'}</span>
              </div>
              {r.files.map((f) => (
                <div className="ri-file" key={f.path}>
                  <div className="rf-head">
                    {f.status === 'new' ? <FilePlus size={13} color="var(--aero-matched)" /> : <FileText size={13} />}
                    <span className="mono">{f.path}</span>
                    <span className={`aero-badge ${f.status === 'new' ? 'ro' : ''}`}>{f.status}</span>
                  </div>
                  <DiffLines text={f.diff} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

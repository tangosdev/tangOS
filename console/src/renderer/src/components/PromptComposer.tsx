import { useState } from 'react'
import { Send, Plus, X, ChevronUp, ChevronDown, Trash2, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react'
import type { Batch, BatchDraft, BatchItem } from '../../../shared/types'
import { BATCH_SOFT_CAP } from '../../../shared/types'

export default function PromptComposer({
  draft,
  onDraft,
  batches,
  mcpRunning
}: {
  draft: BatchDraft
  onDraft: (d: BatchDraft) => void
  batches: Batch[]
  mcpRunning: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [showQueue, setShowQueue] = useState(true)
  const [newRef, setNewRef] = useState('')

  const overCap = draft.items.length > BATCH_SOFT_CAP
  const queued = batches.filter((b) => b.status === 'queued')
  const active = batches.find((b) => b.status === 'active')
  const doneCount = batches.filter((b) => b.status === 'done').length

  function addItem(): void {
    const ref = newRef.trim()
    if (!ref) return
    const item: BatchItem = { id: `${Date.now()}-${ref}`, ref }
    onDraft({ ...draft, items: [...draft.items, item] })
    setNewRef('')
  }
  function removeItem(id: string): void {
    onDraft({ ...draft, items: draft.items.filter((i) => i.id !== id) })
  }

  async function send(): Promise<void> {
    if (!draft.prompt.trim() && draft.items.length === 0) return
    await window.tangos.enqueueBatch(draft)
    onDraft({ title: '', prompt: draft.prompt, items: [] }) // keep prompt, clear the rest
  }

  return (
    <div className={`composer aero-panel ${open ? 'up' : 'down'}`}>
      <div className="composer-head" onClick={() => setOpen((o) => !o)}>
        <span className="ch-title">Compose batch</span>
        {draft.items.length > 0 && <span className={`aero-badge${overCap ? ' warn' : ''}`}>{draft.items.length}</span>}
        {queued.length > 0 && <span className="aero-badge">{queued.length} queued</span>}
        {active && <span className="status-dot running" style={{ width: 8, height: 8 }} />}
        <div style={{ flex: 1 }} />
        <button
          className="dock-close"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          title={open ? 'Send down' : 'Bring up'}
        >
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </div>

      <div className="composer-body aero-scroll">
        <input
          className="ch-input"
          placeholder="Batch title (optional)"
          value={draft.title}
          onChange={(e) => onDraft({ ...draft, title: e.target.value })}
        />
        <textarea
          className="ch-textarea"
          placeholder="Prompt for the AI — what to do with these targets…"
          value={draft.prompt}
          onChange={(e) => onDraft({ ...draft, prompt: e.target.value })}
          rows={5}
        />

        <div className="ch-additem">
          <input
            className="ch-input"
            placeholder="Add target (function name or module:0xaddr)"
            value={newRef}
            onChange={(e) => setNewRef(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addItem()}
          />
          <button className="mini-btn" onClick={addItem}><Plus size={13} /></button>
        </div>

        {draft.items.length > 0 && (
          <div className="ch-items">
            {draft.items.map((it) => (
              <span className="ch-chip" key={it.id}>
                {it.ref}
                <button onClick={() => removeItem(it.id)}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}

        {overCap && (
          <div className="ch-warn">
            <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
            {draft.items.length} targets — over {BATCH_SOFT_CAP}. The prompt may be too big for one turn; consider splitting into multiple batches.
          </div>
        )}

        <button className="aero-button ch-send" onClick={send} disabled={!draft.prompt.trim() && draft.items.length === 0}>
          <Send size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
          Send to queue
        </button>
        {!mcpRunning && <p className="notice" style={{ marginTop: 6 }}>Start the MCP server so the AI can pull batches with next_batch.</p>}

        <div className="section-title" style={{ marginTop: 10, cursor: 'pointer' }} onClick={() => setShowQueue((s) => !s)}>
          Queue · {queued.length} waiting{active ? ' · 1 active' : ''}{doneCount ? ` · ${doneCount} done` : ''}
        </div>
        {showQueue && (
          <div className="queue-list">
            {batches.length === 0 && <p className="hint" style={{ margin: 0 }}>No batches yet. Compose one and Send.</p>}
            {batches.map((b) => (
              <div className={`queue-row ${b.status}`} key={b.id}>
                <span className={`status-dot ${b.status === 'active' ? 'running' : b.status === 'done' ? 'ok' : 'blocked'}`} />
                <span className="qr-title">{b.title}</span>
                <span className="aero-badge">{b.items.length}</span>
                {b.status === 'queued' && (
                  <>
                    <button className="run-icon" onClick={() => window.tangos.reorderBatch(b.id, 'up')}><ArrowUp size={13} /></button>
                    <button className="run-icon" onClick={() => window.tangos.reorderBatch(b.id, 'down')}><ArrowDown size={13} /></button>
                  </>
                )}
                <button className="run-icon" onClick={() => window.tangos.removeBatch(b.id)}><X size={13} /></button>
              </div>
            ))}
            {doneCount > 0 && (
              <button className="mini-btn" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => window.tangos.clearDoneBatches()}>
                <Trash2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                Clear done
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

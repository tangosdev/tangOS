import { useState } from 'react'
import { Trash2, User, ChevronDown, ChevronRight } from 'lucide-react'
import type { ActivityRun } from '../../../shared/types'
import { aiColor } from '../aiColor'

function dur(run: ActivityRun): string {
  const end = run.finishedAt ?? Date.now()
  const ms = Math.max(0, end - run.startedAt)
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function autoBottom(el: HTMLPreElement | null): void {
  if (el) el.scrollTop = el.scrollHeight
}

export default function LiveViewer({
  runs,
  onClear
}: {
  runs: ActivityRun[]
  onClear: () => void
}): JSX.Element {
  const [manual, setManual] = useState<Record<string, boolean>>({})
  const latestId = runs.length ? runs[runs.length - 1].runId : null

  const ordered = runs.slice().reverse()

  function isOpen(run: ActivityRun): boolean {
    if (run.runId in manual) return manual[run.runId]
    return run.status === 'running' || run.runId === latestId
  }

  return (
    <div className="panel aero-panel viewer">
      <div className="head">
        <h2>Live activity</h2>
        <span className="aero-badge">{runs.length}</span>
        <div style={{ flex: 1 }} />
        <button className="aero-button ghost" onClick={onClear} style={{ padding: '5px 10px', fontSize: 12 }}>
          <Trash2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          Clear
        </button>
      </div>

      {runs.length === 0 ? (
        <div className="empty-feed">
          Nothing yet. Start the MCP server and let an AI drive a tool — or run one from the Tools panel —
          and you&apos;ll watch it here, live.
        </div>
      ) : (
        <div className="feed aero-scroll">
          {ordered.map((run) => {
            const open = isOpen(run)
            return (
              <div className="run" key={run.runId}>
                <div
                  className="rhead"
                  onClick={() => setManual((m) => ({ ...m, [run.runId]: !open }))}
                >
                  <span className={`status-dot ${run.status}`} />
                  <span className="rt">
                    <span className="name">
                      {open ? <ChevronDown size={13} style={{ verticalAlign: -2 }} /> : <ChevronRight size={13} style={{ verticalAlign: -2 }} />}{' '}
                      {run.label}
                      {run.mutating && <span className="aero-badge mutating" style={{ marginLeft: 8 }}>writes</span>}
                    </span>
                    <span className="cmd">{run.commandPreview}</span>
                  </span>
                  {run.source === 'ai' ? (
                    (() => {
                      const col = aiColor(run.client?.name ?? 'AI')
                      return (
                        <span className="who ai" style={{ background: `${col}22`, color: col, borderColor: `${col}66` }}>
                          <span className="agent-dot" style={{ background: col, width: 7, height: 7 }} />
                          {run.client?.name ?? 'AI'}
                          {run.client?.role && run.client.role !== 'Unassigned' ? ` · ${run.client.role}` : ''}
                        </span>
                      )
                    })()
                  ) : (
                    <span className="who user">
                      <User size={11} style={{ verticalAlign: -1 }} /> you
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--aero-muted)', minWidth: 42, textAlign: 'right' }}>
                    {dur(run)}
                  </span>
                </div>
                {open && (
                  <pre className="out aero-scroll" ref={run.status === 'running' ? autoBottom : undefined}>
                    {run.output || '(no output yet)'}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

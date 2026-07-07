import { useMemo, useState } from 'react'
import { Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import type { ActivityRun } from '../../../shared/types'
import { aiColor } from '../aiColor'

function dur(run: ActivityRun): string {
  const end = run.finishedAt ?? Date.now()
  const ms = Math.max(0, end - run.startedAt)
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function autoBottom(el: HTMLPreElement | null): void {
  if (el) el.scrollTop = el.scrollHeight
}

interface Group {
  name: string
  source: 'ai' | 'user'
  role?: string
  current: ActivityRun
  runs: ActivityRun[] // newest first
  tools: [string, number][] // tool id -> times called, most-used first
}

export default function LiveViewer({
  runs,
  onClear
}: {
  runs: ActivityRun[]
  onClear: () => void
}): JSX.Element {
  const [openAgent, setOpenAgent] = useState<Record<string, boolean>>({})
  const [openRun, setOpenRun] = useState<Record<string, boolean>>({})

  // One group per AI (user runs collapse into "You").
  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, ActivityRun[]>()
    for (const r of runs) {
      const key = r.source === 'ai' ? r.client?.name ?? 'AI' : 'You'
      const arr = m.get(key)
      if (arr) arr.push(r)
      else m.set(key, [r])
    }
    const out: Group[] = []
    for (const [name, list] of m) {
      const sorted = list.slice().sort((a, b) => b.startedAt - a.startedAt)
      const current = sorted.find((r) => r.status === 'running') ?? sorted[0]
      const counts = new Map<string, number>()
      for (const r of sorted) counts.set(r.toolId, (counts.get(r.toolId) ?? 0) + 1)
      const tools = [...counts.entries()].sort((a, b) => b[1] - a[1])
      out.push({ name, source: list[0].source, role: current.client?.role, current, runs: sorted, tools })
    }
    return out.sort((a, b) => b.current.startedAt - a.current.startedAt)
  }, [runs])

  return (
    <div className="panel aero-panel viewer">
      <div className="head">
        <h2>Live activity</h2>
        <span className="aero-badge">{groups.length}</span>
        <div style={{ flex: 1 }} />
        <button className="aero-button ghost" onClick={onClear} style={{ padding: '5px 10px', fontSize: 12 }}>
          <Trash2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          Clear
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="empty-feed">
          Nothing yet. Start the MCP server and let an AI drive a tool — or run one from the Tools panel —
          and each connected agent shows up here with what it&apos;s doing right now.
        </div>
      ) : (
        <div className="feed aero-scroll">
          {groups.map((g) => {
            const col = g.source === 'ai' ? aiColor(g.name) : 'var(--aero-muted)'
            const open = openAgent[g.name]
            const cur = g.current
            const hasMore = g.runs.length > 1
            return (
              <div className="ai-card" key={g.name}>
                <div className="ai-head" onClick={() => hasMore && setOpenAgent((o) => ({ ...o, [g.name]: !open }))}>
                  <span className="agent-dot" style={{ background: col }} />
                  <span className="ai-name">
                    {g.name}
                    {g.role && g.role !== 'Unassigned' && <span className="ai-role"> · {g.role}</span>}
                  </span>
                  <span className={`status-dot ${cur.status}`} />
                  <span className="ai-dur">{dur(cur)}</span>
                  {hasMore && (
                    <span className="ai-count">
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      {g.runs.length}
                    </span>
                  )}
                </div>

                <div className="ai-current">
                  <span className="cur-label">{cur.label}{cur.mutating && <span className="aero-badge mutating" style={{ marginLeft: 8 }}>writes</span>}</span>
                  <span className="cur-cmd mono">{cur.commandPreview}</span>
                </div>

                {open && hasMore && (
                  <div className="ai-runs">
                    <div className="tools-called">
                      <span className="tc-label">Tools called</span>
                      {g.tools.map(([id, n]) => (
                        <span className="tc-chip" key={id}>{id} <b>×{n}</b></span>
                      ))}
                    </div>
                    {g.runs.map((r) => {
                      const ro = openRun[r.runId] ?? r.status === 'running'
                      return (
                        <div className="mini-run" key={r.runId}>
                          <div className="mini-head" onClick={() => setOpenRun((o) => ({ ...o, [r.runId]: !ro }))}>
                            <span className={`status-dot ${r.status}`} />
                            <span className="mini-label">{r.label}</span>
                            <span className="mini-cmd mono">{r.commandPreview}</span>
                            <span className="mini-dur">{dur(r)}</span>
                          </div>
                          {ro && (
                            <pre className="out aero-scroll" ref={r.status === 'running' ? autoBottom : undefined}>
                              {r.output || '(no output yet)'}
                            </pre>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

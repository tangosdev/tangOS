import { useMemo, useState } from 'react'
import { X, FolderOpen, ChevronRight, Copy, Check } from 'lucide-react'
import type { AiAgent, ActivityRun } from '../../../shared/types'
import { aiColor } from '../aiColor'
import { recommendRole } from '../roleRec'

function dur(r: ActivityRun): string {
  const ms = Math.max(0, (r.finishedAt ?? Date.now()) - r.startedAt)
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// Absolute paths in a command line (quoted or bare), so they can be turned into
// click-to-open-folder links: "C:\dir\file with space.txt" or C:\dir\file.jsonl or /abs/unix.
const PATH_RE = /"([A-Za-z]:\\[^"]*|\/[^"]*)"|([A-Za-z]:\\[^\s]+|\/[^\s]+\.[A-Za-z0-9]+)/g

function firstPath(cmd: string): string | null {
  PATH_RE.lastIndex = 0
  const m = PATH_RE.exec(cmd)
  return m ? (m[1] ?? m[2]) : null
}

/** Render a command line with its file paths as click-to-reveal links. */
function renderCmd(cmd: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  PATH_RE.lastIndex = 0
  while ((m = PATH_RE.exec(cmd))) {
    if (m.index > last) out.push(cmd.slice(last, m.index))
    const p = m[1] ?? m[2]
    out.push(
      <button
        key={k++}
        className="path-link"
        title={`Open this file's folder\n${p}`}
        onClick={(e) => {
          e.stopPropagation()
          window.tangos.revealPath(p)
        }}
      >
        {p}
      </button>
    )
    last = m.index + m[0].length
  }
  if (last < cmd.length) out.push(cmd.slice(last))
  return out
}

function recommend(bySize?: AiAgent['stats']['bySize']): string {
  if (!bySize) return 'Not enough data yet - assign it some work.'
  const rows = Object.entries(bySize)
    .filter(([, t]) => t.attempts >= 2)
    .map(([b, t]) => ({ b, r: t.matches / t.attempts }))
    .sort((a, b) => b.r - a.r)
  if (!rows.length) return 'Not enough data yet - assign it some work.'
  const best = rows[0]
  const worst = rows[rows.length - 1]
  let s = `Strongest on ${best.b} (${Math.round(best.r * 100)}% hit)`
  if (worst.b !== best.b) s += `; weakest on ${worst.b} (${Math.round(worst.r * 100)}%)`
  return s + '.'
}

export default function AiDetail({
  agent,
  runs,
  onClose
}: {
  agent: AiAgent
  runs: ActivityRun[]
  onClose: () => void
}): JSX.Element {
  const col = aiColor(agent.name)
  const mine = useMemo(
    () =>
      runs
        .filter((r) => (r.source === 'ai' ? r.client?.name : 'You') === agent.name)
        .sort((a, b) => b.startedAt - a.startedAt),
    [runs, agent.name]
  )
  const tools = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of mine) m.set(r.toolId, (m.get(r.toolId) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [mine])
  const [scope, setScope] = useState<'all' | 'run'>('all')
  const s = scope === 'run' ? agent.run ?? agent.stats : agent.stats
  const rec = recommendRole(agent) // aptitude recommendation stays all-time (needs the full history)
  const running = mine.find((r) => r.status === 'running')
  // Fall back to the most recent run so the live pane PERSISTS between an MCP agent's tool calls.
  // Each call finishes in a flash and the agent then thinks, so keying only on 'running' means the
  // pane is empty almost always - the "why doesn't the live show up" bug.
  const latest = running ?? mine[0]
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  function copyLive(): void {
    if (!latest?.output) return
    void window.tangos.copy(latest.output)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="ai-detail-scrim" onClick={onClose}>
      <div className="ai-detail aero-panel solid" onClick={(e) => e.stopPropagation()}>
        <div className="head">
          <span className="agent-dot" style={{ background: col }} />
          <h2 style={{ color: col }}>{agent.name}</h2>
          <span className="aib-kind">{agent.kind === 'api' ? 'API-driven' : 'MCP'}</span>
          {agent.roles.map((r) => (
            <span className="aero-badge" key={r}>
              {r}
            </span>
          ))}
          <div style={{ flex: 1 }} />
          <button className="dock-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="aid-rec">
          <span className="aid-rec-label">{rec.role ? 'Best as' : 'Role'}</span>
          <b>{rec.role ?? 'not sure yet'}</b>
          <span className="aid-rec-why">- {rec.why}</span>
        </div>

        <div className="aid-scope">
          <div className="stat-scope" title="Which tally these numbers show">
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
              All-time
            </button>
            <button className={scope === 'run' ? 'on' : ''} onClick={() => setScope('run')}>
              This session
            </button>
          </div>
        </div>

        <div className="aid-grid">
          <div className="aid-stat">
            <b>{s.totalMatches}</b>
            <span>matches</span>
          </div>
          <div className="aid-stat">
            <b>{s.matchAttempts ? Math.round(s.hitRate * 100) : '-'}%</b>
            <span>hit rate</span>
          </div>
          <div className="aid-stat">
            <b>{s.matchAttempts}</b>
            <span>attempts</span>
          </div>
          <div className="aid-stat" title="compiled non-matches that pushed a function's byte-diff lower than ever before (real progress; re-hitting the same divergence doesn't count)">
            <b>{(s.nearMisses ?? 0).toLocaleString()}</b>
            <span>near misses</span>
          </div>
        </div>

        {s.bySize && (
          <>
            <div className="section-title">Hit rate by size</div>
            <div className="aid-bysize">
              {Object.entries(s.bySize).map(([b, t]) => (
                <div className="aid-size-row" key={b}>
                  <span className="mono">{b}</span>
                  <span className="aib-bar">
                    <span style={{ width: `${t.attempts ? (t.matches / t.attempts) * 100 : 0}%`, background: col }} />
                  </span>
                  <span className="muted">
                    {t.matches}/{t.attempts}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="section-title">Recommendation</div>
        <p className="hint" style={{ marginTop: 2 }}>{recommend(s.bySize)}</p>

        {tools.length > 0 && (
          <>
            <div className="section-title">Tools called</div>
            <div className="tools-called">
              {tools.map(([id, n]) => (
                <span className="tc-chip" key={id}>
                  {id} <b>×{n}</b>
                </span>
              ))}
            </div>
          </>
        )}

        {latest && (
          <>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center' }}>
              <span className={`status-dot ${latest.status}`} style={{ verticalAlign: -1, marginRight: 6 }} />
              {running ? 'Live' : 'Latest'} - {latest.label}
              <button
                onClick={copyLive}
                disabled={!latest.output}
                title="Copy the full output"
                style={{
                  marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
                  border: '1px solid var(--aero-border)', background: 'rgba(var(--aero-gloss-rgb) / 0.55)',
                  color: 'var(--aero-muted)', cursor: latest.output ? 'pointer' : 'default',
                  opacity: latest.output ? 1 : 0.45
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="aid-live aero-scroll" ref={(el) => el && (el.scrollTop = el.scrollHeight)}>
              {latest.output || (running ? '(starting…)' : '(no output)')}
            </pre>
          </>
        )}

        <details className="aid-runs-wrap">
          <summary className="section-title aid-runs-summary">
            <ChevronRight size={12} className="settings-info-caret" /> Recent runs
            {mine.length > 0 && <span className="aid-runs-count">{Math.min(mine.length, 10)}</span>}
          </summary>
          <div className="aid-runs aero-scroll">
            {mine.length === 0 && <p className="hint">No activity yet.</p>}
            {mine.slice(0, 10).map((r) => {
            const fp = firstPath(r.commandPreview)
            const expanded = openRun === r.runId
            return (
              <div className="mini-run" key={r.runId}>
                <div
                  className="mini-head"
                  onClick={() => setOpenRun(expanded ? null : r.runId)}
                  title={expanded ? 'Hide output' : 'Show this run’s output'}
                >
                  <span className={`status-dot ${r.status}`} />
                  <span className="mini-label">{r.label}</span>
                  <span className="mini-cmd mono">{renderCmd(r.commandPreview)}</span>
                  {fp && (
                    <button
                      className="mini-folder"
                      title={`Open the run folder\n${fp}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.tangos.revealPath(fp)
                      }}
                    >
                      <FolderOpen size={13} />
                    </button>
                  )}
                  <span className="mini-dur">{dur(r)}</span>
                </div>
                {expanded && <pre className="mini-output aero-scroll">{r.output || '(no output)'}</pre>}
              </div>
            )
            })}
          </div>
        </details>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Play, Square, ShoppingCart, ShieldCheck, AlertTriangle, GitBranch } from 'lucide-react'
import type { AiAgent, ActivityRun, Batch } from '../../../shared/types'
import { ROLE_NAMES, ROLE_PRESETS } from '../../../shared/types'
import { aiColor } from '../aiColor'
import { recommendRole } from '../roleRec'
import GithubSignIn from './GithubSignIn'

const SIZES = [8, 16, 32, 64] // batch-size options; -1 = infinite (continuous)

/** Ticks mm:ss from mount — shows the batch generator is working, not frozen. */
function Elapsed(): JSX.Element {
  const [s, setS] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setS((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="aib-elapsed">
      {Math.floor(s / 60)}:{(s % 60).toString().padStart(2, '0')}
    </span>
  )
}

function runName(r: ActivityRun): string {
  return r.source === 'ai' ? r.client?.name ?? 'AI' : 'You'
}
function lastLine(s: string): string {
  const t = s.trimEnd()
  const nl = t.lastIndexOf('\n')
  return (nl >= 0 ? t.slice(nl + 1) : t).slice(0, 90)
}

export interface AgentView {
  agent: AiAgent
  batch?: Batch
  done: number
  total: number
  task?: string
  live: boolean // has a currently-running tool
  batchDone: boolean // its latest batch has finished
  liveLine: string // latest streaming output line (so you can watch it work)
}

export default function Controller({
  agents,
  runs,
  batches,
  looping,
  cartCount,
  onAssignCart,
  onClearCart,
  onOpenViewer,
  allowMutations,
  safeMode,
  onToggleWrites,
  onToggleReview,
  onOpenDetail,
  mcpControl
}: {
  agents: AiAgent[]
  runs: ActivityRun[]
  batches: Batch[]
  looping: string[]
  cartCount: number
  onAssignCart: (agent: string) => void
  onClearCart: () => void
  onOpenViewer: () => void
  allowMutations: boolean
  safeMode: boolean
  onToggleWrites: () => void
  onToggleReview: () => void
  onOpenDetail: (name: string) => void
  mcpControl: JSX.Element
}): JSX.Element {
  const [busy, setBusy] = useState<Record<string, string>>({}) // name -> loading label
  const [sizes, setSizes] = useState<Record<string, number>>({}) // name -> batch size (-1 = infinite)

  // Latest run per agent in a single pass (instead of filter+sort over all runs per agent on
  // every output chunk — that was quadratic during a long scan and made the view lag/drop).
  const latestByName = useMemo(() => {
    const m = new Map<string, ActivityRun>()
    for (const r of runs) {
      const n = runName(r)
      const cur = m.get(n)
      if (!cur || r.startedAt >= cur.startedAt) m.set(n, r)
    }
    return m
  }, [runs])

  const views = useMemo<AgentView[]>(() => {
    return agents.map((agent) => {
      // the agent's most recent batch (any status) so a finished one still shows its result
      const batch = batches
        .filter((b) => b.targetAgent === agent.name)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      const done = batch ? batch.items.filter((i) => i.done).length : 0
      const total = batch ? batch.items.length : 0
      const batchDone = batch?.status === 'done'
      const latest = latestByName.get(agent.name)
      const live = !!latest && latest.status === 'running'
      const task = agent.stats.currentTask ?? batch?.title ?? latest?.label
      // Keep the last line up between functions (don't blank when a run finishes) so the box
      // doesn't visibly reset after every function during a scan.
      const liveLine = latest?.output ? lastLine(latest.output) : ''
      return { agent, batch, done, total, task, live, batchDone, liveLine }
    })
  }, [agents, latestByName, batches])

  async function assign(name: string, role: string | undefined): Promise<void> {
    const size = sizes[name] ?? 16
    const loop = size === -1
    setBusy((b) => ({ ...b, [name]: 'Generating batch' }))
    try {
      await window.tangos.assignAi({ agent: name, role, count: loop ? 16 : size, loop })
    } catch (e) {
      alert(String((e as Error).message ?? e))
    } finally {
      setBusy((b) => ({ ...b, [name]: '' }))
    }
  }
  async function drive(name: string): Promise<void> {
    setBusy((b) => ({ ...b, [name]: 'Driving' }))
    try {
      await window.tangos.driveAi(name)
    } catch (e) {
      alert(String((e as Error).message ?? e))
    } finally {
      setBusy((b) => ({ ...b, [name]: '' }))
    }
  }

  return (
    <div className="panel aero-panel controller" data-tour="controller">
      <div className="head">
        <h2>Chaos Controller</h2>
        {cartCount > 0 && (
          <span className="ctl-cart" title="Functions you picked in the Chaos Viewer">
            <ShoppingCart size={13} /> {cartCount} in cart
            <button onClick={onClearCart} title="Empty the cart">clear</button>
          </span>
        )}
        <button className="mini-btn" onClick={onOpenViewer} title="Pick functions in the Chaos Viewer">
          <ShoppingCart size={12} /> Pick in Viewer
        </button>
        <div style={{ flex: 1 }} />
        {mcpControl}
      </div>

      {agents.length === 0 ? (
        <div className="empty-feed">
          No AIs yet. Start the MCP server and connect an agent, or add an LLM API key in Settings —
          each one gets a box here you can assign work to and watch live.
        </div>
      ) : (
        <div className="ctl-grid aero-scroll">
          {views.map(({ agent, batch, done, total, task, live, batchDone, liveLine }) => {
            const a = agent
            const col = aiColor(a.name)
            const pct = total ? Math.round((done / total) * 100) : 0
            const hit = a.stats.matchAttempts ? Math.round(a.stats.hitRate * 100) : null
            // API providers are always available (we hold the key) — never grayed offline.
            const available = a.kind === 'api' || a.connected
            const state = live ? 'live' : available ? 'idle' : 'off'
            const isLooping = looping.includes(a.name)
            // Actively running its API driver right now (a.connected = apiDriving on the main side;
            // busy covers the click->spawn gap). Drive flips to a red Stop while this is true.
            const driving = a.kind === 'api' && (a.connected || busy[a.name] === 'Driving')
            const canDrive = a.kind === 'api' && !!batch && !batchDone && !isLooping && !driving && !busy[a.name] && !live
            const generating = busy[a.name] === 'Generating batch'
            const size = sizes[a.name] ?? 16
            const rec = recommendRole(a)
            return (
              <div
                className={`ai-box ${state}${generating ? ' busy' : ''}`}
                key={a.name}
                style={{ borderColor: col }}
                onClick={() => onOpenDetail(a.name)}
              >
                {generating && (
                  <div className="aib-loading">
                    <span className="aib-loadtext">
                      Generating batch… <Elapsed />
                    </span>
                    <span className="aib-loadsub">ranking targets by similarity — up to a minute on a cold start</span>
                    <span className="aib-loadbar" />
                  </div>
                )}
                <div className="aib-top">
                  <span className={`status-dot ${live ? 'running' : available ? 'ok' : 'blocked'}`} />
                  <span className="aib-name" style={{ color: col }}>
                    {a.name}
                  </span>
                  {a.kind === 'api' && <span className="aib-kind">API</span>}
                  {isLooping && <span className="aib-kind loop" title="Running continuously">∞</span>}
                  <span className="aib-matches">
                    {a.stats.totalMatches}
                    <small> matched</small>
                  </span>
                </div>

                <div className="aib-task">
                  {task ? (
                    <>
                      <span className="aib-task-label">
                        {task}
                        {batchDone && !isLooping && <span className="aib-done"> ✓ done</span>}
                      </span>
                      {total > 0 && (
                        <span className="aib-prog">
                          <span className="aib-bar">
                            <span style={{ width: `${pct}%`, background: col }} />
                          </span>
                          {done}/{total} matched · {pct}%
                        </span>
                      )}
                      {liveLine && <span className={`aib-live mono${live ? '' : ' done'}`}>▸ {liveLine}</span>}
                    </>
                  ) : (
                    <span className="aib-idle">{available ? 'idle — ready to assign' : 'offline'}</span>
                  )}
                </div>

                <div className="aib-stats">
                  {hit != null && <span title="matches / match attempts">{hit}% hit</span>}
                  {a.stats.tokensPerMatch != null && <span>{a.stats.tokensPerMatch} tok/match</span>}
                  {a.kind === 'mcp' && <span className="muted">tokens n/a</span>}
                </div>

                <div className="aib-actions" onClick={(e) => e.stopPropagation()}>
                  <div className="aib-roles">
                    {a.roles.map((r) => (
                      <span className="role-chip" key={r} title={ROLE_PRESETS[r]}>
                        {r}
                        <button
                          className="role-x"
                          onClick={() => window.tangos.setClientRoles(a.name, a.roles.filter((x) => x !== r))}
                          title={`Remove ${r}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <select
                      className={`agent-role add${a.roles.length === 0 ? ' needs' : ''}`}
                      value=""
                      onChange={(e) => {
                        const r = e.target.value
                        if (r) window.tangos.setClientRoles(a.name, [...a.roles, r])
                      }}
                      title={rec.role ? `Recommended role: ${rec.role} (${rec.why})` : 'Give this agent a role'}
                    >
                      <option value="">{a.roles.length ? '+ add role' : 'assign role'}</option>
                      {ROLE_NAMES.filter((r) => r !== 'Unassigned' && !a.roles.includes(r)).map((r) => (
                        <option key={r} value={r}>
                          {r}
                          {r === rec.role ? ' (recommended)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="aib-btns">
                    <select
                      className="aib-size"
                      value={size}
                      onChange={(e) => setSizes((s) => ({ ...s, [a.name]: Number(e.target.value) }))}
                      title="Batch size (infinite keeps going after each batch)"
                    >
                      {SIZES.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                      <option value={-1}>∞</option>
                    </select>
                    <button className="mini-btn" disabled={generating} onClick={() => assign(a.name, a.roles[0])} title="Generate a role-fit batch of this size and assign it">
                      <Sparkles size={12} /> Recommended
                    </button>
                    {driving || isLooping ? (
                      <button
                        className="mini-btn stop"
                        onClick={() => window.tangos.stopAi(a.name)}
                        title={driving ? 'Stop this run early — keeps the matches found so far and prints results' : 'Stop the continuous loop'}
                      >
                        <Square size={12} /> Stop
                      </button>
                    ) : canDrive ? (
                      <button className="mini-btn go" onClick={() => drive(a.name)} title="Run this AI on its batch via its API key">
                        <Play size={12} /> Drive
                      </button>
                    ) : null}
                  </div>
                  {cartCount > 0 && (
                    <button className="mini-btn custom" onClick={() => onAssignCart(a.name)} title="Assign your hand-picked cart to this AI">
                      <ShoppingCart size={12} /> Assign custom ({cartCount})
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="ctl-footer">
        <div className="ctl-foot-side" />
        <div className="ctl-foot-mid" data-tour="policies">
          <button
            className={`tb-btn ${allowMutations ? 'warn' : ''}`}
            onClick={onToggleWrites}
            title={allowMutations ? 'Tools may write to the repo' : 'Read-only: mutating tools blocked'}
          >
            {allowMutations ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
            Writes: {allowMutations ? 'ON' : 'OFF'}
          </button>
          <button
            className={`tb-btn ${safeMode ? 'active' : ''}`}
            onClick={onToggleReview}
            title={safeMode ? 'Mutations run on tangos/work for review' : 'Mutations write straight to your branch'}
          >
            <GitBranch size={14} />
            Review: {safeMode ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="ctl-foot-side right">
          <GithubSignIn />
        </div>
      </div>
    </div>
  )
}

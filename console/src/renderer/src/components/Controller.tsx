import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Play, Square, ShoppingCart, ShieldCheck, AlertTriangle, GitBranch, GitPullRequest, BarChart2, FileText } from 'lucide-react'
import type { AiAgent, ActivityRun, Batch } from '../../../shared/types'
import { ROLE_NAMES, ROLE_PRESETS, ROLE_STRENGTH } from '../../../shared/types'
import { aiColor } from '../aiColor'
import { recommendRole } from '../roleRec'
import { effortSpec, currentEffort } from '../efforts'
import GithubSignIn from './GithubSignIn'


/** Ticks mm:ss from mount - shows the batch generator is working, not frozen. */
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
  // Work on a small tail slice: trimEnd() copies the WHOLE string, and this runs per agent per
  // render against outputs that reach 200KB - megabytes of copying just to show 90 chars.
  const t = s.slice(-400).trimEnd()
  const nl = t.lastIndexOf('\n')
  return (nl >= 0 ? t.slice(nl + 1) : t).slice(0, 90)
}

// Presence dot thresholds, measured from an agent's last MCP signal (any tool call OR a next_batch
// poll ~every 45s). A working agent keeps signalling, so it stays green even across a long think or
// one slow `match`; it only yellows if it actually goes quiet, then reds after an hour.
const PRESENCE_GREEN_MS = 5 * 60_000 // fresh: working, or connected-and-polling -> green
const PRESENCE_YELLOW_MS = 60 * 60_000 // quiet but seen within the hour -> yellow (grace), then red

/** Presence dot class for an agent. API providers are always reachable (we hold the key) so they read
 *  online. MCP agents decay green -> yellow -> red by time since their last signal. `live` (a tool is
 *  running right now) adds a pulse. */
function presenceClass(agent: AiAgent, live: boolean, now: number): string {
  if (agent.kind === 'api') return live ? 'online live' : 'online'
  const ts = agent.lastSeen ?? 0
  const age = now - ts
  if (ts && age < PRESENCE_GREEN_MS) return live ? 'online live' : 'online'
  if (ts && age < PRESENCE_YELLOW_MS) return 'stale'
  return 'offline'
}

export interface AgentView {
  agent: AiAgent
  batch?: Batch
  analyzed: number // functions worked through this batch (matched, near-miss, or no-match alike)
  total: number
  task?: string
  live: boolean // has a currently-running tool
  batchDone: boolean // its latest batch has finished
  liveLine: string // latest streaming output line (so you can watch it work)
  queueRemaining: number // unfinished functions across this agent's pending batches
  queuedBatches: number // batches waiting (not yet active)
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
  autoPush,
  onToggleWrites,
  onToggleReview,
  onOpenDetail,
  onOpenEncyclopedia,
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
  autoPush: { enabled: boolean; on: boolean; state: 'idle' | 'pushing' | 'ok' | 'error' | 'skipped'; message?: string; prUrl?: string }
  onToggleWrites: () => void
  onToggleReview: () => void
  onOpenDetail: (name: string) => void
  onOpenEncyclopedia: () => void
  mcpControl: JSX.Element
}): JSX.Element {
  const [busy, setBusy] = useState<Record<string, string>>({}) // name -> loading label
  const [sizes, setSizes] = useState<Record<string, number>>({}) // name -> batch size (-1 = infinite)
  const [notice, setNotice] = useState<string | null>(null) // gentle info toast (e.g. "no work for this role")
  const [statScope, setStatScope] = useState<'all' | 'run'>('run') // which tally the boxes show
  const [genTail, setGenTail] = useState('') // the in-flight scheduler's streamed output (one gen at a time)
  const [genLogOpen, setGenLogOpen] = useState(false)
  useEffect(() => window.tangos.onGenOutput(setGenTail), [])
  // Re-render every 30s so a quiet agent's presence dot decays green -> yellow -> red on time even
  // when no state push arrives (nothing else forces a render while an agent sits idle/disconnected).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Latest run per agent in a single pass (instead of filter+sort over all runs per agent on
  // every output chunk - that was quadratic during a long scan and made the view lag/drop).
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
      // The bar tracks progress THROUGH the batch, not just wins: a target counts as soon as the
      // agent has worked it (matched, near-miss, or dead end), so the bar advances on every function.
      const analyzed = batch ? batch.items.filter((i) => i.worked || i.done).length : 0
      const total = batch ? batch.items.length : 0
      const batchDone = batch?.status === 'done'
      // The agent's QUEUE: everything not yet worked through. queueRemaining counts targets the agent
      // has NOT yet worked (neither matched nor attempted) across those batches - it ticks down as the
      // agent grinds each one, matched or not, so the header reflects real work left, not just misses.
      const queue = batches.filter((b) => b.targetAgent === agent.name && b.status !== 'done')
      const queueRemaining = queue.reduce((n, b) => n + b.items.filter((i) => !(i.worked || i.done)).length, 0)
      const queuedBatches = queue.filter((b) => b.status === 'queued').length
      const latest = latestByName.get(agent.name)
      const live = !!latest && latest.status === 'running'
      const task = agent.stats.currentTask ?? batch?.title ?? latest?.label
      // Keep the last line up between functions (don't blank when a run finishes) so the box
      // doesn't visibly reset after every function during a scan.
      const liveLine = latest?.output ? lastLine(latest.output) : ''
      return { agent, batch, analyzed, total, task, live, batchDone, liveLine, queueRemaining, queuedBatches }
    })
  }, [agents, latestByName, batches])

  async function assign(name: string, role: string | undefined): Promise<void> {
    const size = sizes[name] ?? 16
    const loop = size === -1
    setBusy((b) => ({ ...b, [name]: 'Generating batch' }))
    try {
      await window.tangos.assignAi({ agent: name, role, count: loop ? 16 : size, loop })
    } catch (e) {
      // Strip Electron's "Error invoking remote method 'ai:assign': Error:" IPC wrapper.
      const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '')
      if (/cancelled/i.test(msg)) {
        setNotice('Batch generation cancelled.')
        window.setTimeout(() => setNotice(null), 4000)
      } else if (/^No work /i.test(msg)) {
        // Not a failure - just nothing to do for this role. Show a calm, dismissable notice.
        setNotice(msg.split('--- scheduler output ---')[0].trim())
        window.setTimeout(() => setNotice(null), 7000)
      } else {
        alert(msg) // real errors keep the full dialog (with setup hints)
      }
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
      {notice && (
        <div className="ctrl-notice" onClick={() => setNotice(null)} title="Click to dismiss">
          {notice}
        </div>
      )}
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
        <div className="stat-scope" title="Which tally the boxes show">
          <button className={statScope === 'run' ? 'on' : ''} onClick={() => setStatScope('run')}>
            This session
          </button>
          <button className={statScope === 'all' ? 'on' : ''} onClick={() => setStatScope('all')}>
            All-time
          </button>
        </div>
        {mcpControl}
      </div>

      {agents.length === 0 ? (
        <div className="empty-feed">
          No AIs yet. Start the MCP server and connect an agent, or add an LLM API key in Settings -
          each one gets a box here you can assign work to and watch live.
        </div>
      ) : (
        <div className="ctl-grid aero-scroll">
          {views.map(({ agent, batch, analyzed, total, task, live, batchDone, liveLine, queueRemaining, queuedBatches }) => {
            const a = agent
            const st = statScope === 'run' ? a.run ?? a.stats : a.stats // all-time vs this-run tally
            const col = aiColor(a.name)
            const pct = total ? Math.round((analyzed / total) * 100) : 0
            const hit = st.matchAttempts ? Math.round(st.hitRate * 100) : null
            // API providers are always available (we hold the key). Boxes never gray out now -
            // presence is shown by the dot's color (green/yellow/red), not by fading the whole box.
            const available = a.kind === 'api' || a.connected
            const state = live ? 'live' : 'idle'
            const dotClass = presenceClass(a, live, now)
            const isLooping = looping.includes(a.name)
            // Actively running its API driver right now (a.connected = apiDriving on the main side;
            // busy covers the click->spawn gap). Drive flips to a red Stop while this is true.
            const driving = a.kind === 'api' && (a.connected || busy[a.name] === 'Driving')
            // Drive appears once there's anything in the queue; it walks the WHOLE queue.
            const canDrive = a.kind === 'api' && queueRemaining > 0 && !isLooping && !driving && !busy[a.name] && !live
            // Actively working (driving its API, or on a continuous loop). While running, the box
            // collapses to just a Stop - the role/effort/size/loop/start controls only clutter it.
            const running = driving || isLooping
            const generating = busy[a.name] === 'Generating batch'
            const rawSize = sizes[a.name] // undefined = empty (use recommended); -1 = loop
            // Reflect the ACTUAL loop state, not just the local ∞ toggle: an MCP agent the main
            // process has in its loop set stays "looping" in the UI even if the local sizes state
            // reset (or the loop was started elsewhere), so the box can't show "Add to queue" while
            // it loops. Scoped to MCP - API agents drive/stop through their own row.
            const loopSel = rawSize === -1 || (a.kind === 'mcp' && isLooping)
            const rec = recommendRole(a)
            return (
              <div
                className={`ai-box ${state}${generating ? ' busy' : ''}`}
                key={a.name}
                style={{ borderColor: col }}
              >
                {generating && (
                  <div className="aib-loading">
                    <span className="aib-loadtext">
                      Generating batch… <Elapsed />
                    </span>
                    <span className="aib-loadsub">ranking targets by similarity - up to a minute on a cold start</span>
                    {genLogOpen && (
                      <pre className="aib-loadlog aero-scroll" ref={(el) => el && (el.scrollTop = el.scrollHeight)}>
                        {genTail.split('\n').slice(-14).join('\n') || '(waiting for scheduler output…)'}
                      </pre>
                    )}
                    <span className="aib-loadbar" />
                    <span className="aib-load-actions">
                      <button className="mini-btn" onClick={() => setGenLogOpen((o) => !o)}>
                        {genLogOpen ? 'Hide details' : 'Details'}
                      </button>
                      <button className="mini-btn stop" onClick={() => window.tangos.cancelGen()} title="Stop the scheduler - nothing is queued">
                        <Square size={12} /> Cancel
                      </button>
                    </span>
                  </div>
                )}
                <div className="aib-top">
                  <span
                    className={`status-dot ${dotClass}`}
                    title={
                      dotClass.startsWith('online')
                        ? 'Connected / active'
                        : dotClass === 'stale'
                          ? 'Quiet - last signal within the hour'
                          : 'Offline - no signal for over an hour'
                    }
                  />
                  <span className="aib-name" style={{ color: col }}>
                    {a.name}
                  </span>
                  {a.kind === 'api' && <span className="aib-kind">API</span>}
                  {isLooping && <span className="aib-kind loop" title="Matching continuously">∞</span>}
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
                  <span className="aib-matches">
                    {st.totalMatches}
                    <small> matched</small>
                  </span>
                  <button
                    className="aib-detail-btn"
                    title="Open detailed stats, history, and recommendation"
                    onClick={() => onOpenDetail(a.name)}
                  >
                    <BarChart2 size={13} />
                  </button>
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
                          {analyzed}/{total} analyzed · {pct}%
                        </span>
                      )}
                      {batch?.note && <span className="aib-note">{batch.note}</span>}
                      {liveLine && <span className={`aib-live mono${live ? '' : ' done'}`}>▸ {liveLine}</span>}
                    </>
                  ) : (
                    <span className="aib-idle">{available ? 'idle - ready to assign' : 'offline'}</span>
                  )}
                </div>

                {/* Only render when there's something to say - an all-zero stats row was pure dead
                    height on a fresh box, pushing the controls down for no information. */}
                {(hit != null || (st.nearMisses ?? 0) > 0) && (
                  <div className="aib-stats">
                    {hit != null && <span title="matches / match attempts">{hit}% hit</span>}
                    {(st.nearMisses ?? 0) > 0 && (
                      <span title="near misses: compiled non-matches that pushed a function's byte-diff lower than anyone had before (real progress; re-hitting the same divergence doesn't count)">
                        {st.nearMisses} near
                      </span>
                    )}
                  </div>
                )}

                <div className="aib-actions" onClick={(e) => e.stopPropagation()}>
                  {running ? (
                    // Working (driving or looping): collapse to a single Stop - the role/effort/size/
                    // loop/start controls only add clutter and jump the box height while it runs.
                    <button
                      className={`mini-btn stop aib-stop${a.stopping ? ' stopping' : ''}`}
                      disabled={a.stopping}
                      onClick={() => window.tangos.stopAi(a.name)}
                      title={
                        a.stopping
                          ? 'Stopping - banking matches, running the clone/paramclone post-pass, and pushing the near-miss PR. Finishes on its own.'
                          : driving
                            ? 'Stop - finishes nothing further; matches found so far are kept'
                            : "Stop looping - no new batch is queued once the current one finishes; the agent isn't signalled or interrupted"
                      }
                    >
                      <Square size={12} /> {a.stopping ? 'Stopping…' : 'Stop'}
                    </button>
                  ) : (
                    <>
                      <div className="aib-roles">
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
                              {ROLE_STRENGTH[r] ? ` (${ROLE_STRENGTH[r]})` : ''}
                              {r === rec.role ? ' - recommended' : ''}
                            </option>
                          ))}
                        </select>
                        {(() => {
                          const spec = effortSpec(a)
                          return (
                            <select
                              className="agent-effort"
                              value={currentEffort(a)}
                              onChange={(e) => window.tangos.setClientEffort(a.name, e.target.value)}
                              title={`Reasoning effort${spec.note ? ` - ${spec.note}` : ''}`}
                            >
                              {spec.options.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </select>
                          )
                        })()}
                        {a.kind === 'api' && (
                          <input
                            className="agent-attempts"
                            type="number"
                            min={1}
                            max={20}
                            value={a.attempts ?? ''}
                            placeholder="4"
                            title="Attempts limit - max tries per function before moving on (default 4)"
                            onChange={(e) => {
                              const v = e.target.value.trim()
                              window.tangos.setClientAttempts(
                                a.name,
                                v === '' ? null : Math.max(1, Math.min(20, Math.floor(Number(v)) || 1))
                              )
                            }}
                          />
                        )}
                      </div>
                      <div className="aib-btns">
                        <input
                          className="aib-size"
                          type="number"
                          min={1}
                          max={200}
                          value={loopSel || rawSize == null ? '' : rawSize}
                          placeholder={loopSel ? '∞' : '16'}
                          disabled={loopSel}
                          title={loopSel ? 'Running continuously (∞)' : 'Batch size - leave empty for the recommended 16, max 200'}
                          onChange={(e) => {
                            const v = e.target.value.trim()
                            setSizes((s) => {
                              const next = { ...s }
                              if (v === '') delete next[a.name]
                              else next[a.name] = Math.max(1, Math.min(200, Math.floor(Number(v)) || 1))
                              return next
                            })
                          }}
                        />
                        <button
                          className={`aib-loop${loopSel ? ' on' : ''}`}
                          title={loopSel ? 'Switch back to one-shot: queue up a set amount instead' : 'Continuous: this AI keeps pulling fresh batches from its queue until you stop it'}
                          onClick={() =>
                            setSizes((s) => {
                              const next = { ...s }
                              if (loopSel) delete next[a.name]
                              else next[a.name] = -1
                              return next
                            })
                          }
                        >
                          ∞
                        </button>
                        <button
                          className="mini-btn"
                          disabled={generating}
                          onClick={() => assign(a.name, a.roles[0])}
                          title={
                            loopSel
                              ? 'Start matching: this AI keeps pulling role-fit batches and working them until stopped'
                              : 'Generate a role-fit batch of this size and add it to the queue - press again to line up more'
                          }
                        >
                          <Sparkles size={12} />{' '}
                          {loopSel ? 'Start matching' : queueRemaining > 0 ? `Add to queue (${queueRemaining})` : 'Add to queue'}
                        </button>
                        {!loopSel && queuedBatches > 0 && (
                          <button
                            className="aib-clearq"
                            title="Clear the queue (waiting batches only - the batch being worked isn't touched)"
                            onClick={() => window.tangos.clearQueue(a.name)}
                          >
                            ×
                          </button>
                        )}
                      </div>
                      {cartCount > 0 && (
                        <button className="mini-btn custom" onClick={() => onAssignCart(a.name)} title="Add the functions you picked in the Chaos Viewer to this AI's queue">
                          <ShoppingCart size={12} /> Add chosen functions ({cartCount})
                        </button>
                      )}
                      {canDrive && (
                        <div className="aib-drive-row">
                          <button
                            className="mini-btn go"
                            onClick={() => drive(a.name)}
                            title={`Work through the queue (${queueRemaining} function${queueRemaining === 1 ? '' : 's'}) via this AI's API key`}
                          >
                            <Play size={12} /> Drive queue ({queueRemaining})
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="ctl-footer">
        <div className="ctl-foot-side">
          <button
            className="tb-btn icononly"
            onClick={onOpenEncyclopedia}
            title="Encyclopedia - every tool this repo gives the AIs: what it does, its arguments, how it gets called"
          >
            <FileText size={14} />
          </button>
        </div>
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
            title={
              safeMode
                ? 'Mutations run on tangos/work for review. With Writes ON, matched work auto-pushes as a rolling PR.'
                : 'Mutations write straight to your branch'
            }
          >
            <GitBranch size={14} />
            Review: {safeMode ? 'ON' : 'OFF'}
          </button>
          <button
            className={`tb-btn ${autoPush.enabled ? 'active' : ''}`}
            onClick={() => window.tangos.setAutoPush(!autoPush.enabled)}
            title={
              autoPush.enabled
                ? 'Auto-push matched work as a rolling PR. With Writes + Review also on, the pipeline runs end-to-end with no human step.'
                : 'Turn on to auto-push matched work as a rolling PR (needs Writes + Review on, a git clone, and GitHub sign-in)'
            }
          >
            <GitPullRequest size={14} />
            Push: {autoPush.enabled ? 'ON' : 'OFF'}
          </button>
          {autoPush.on && (
            <span
              className={`autopush-chip ${autoPush.state}`}
              title={autoPush.message ?? 'Matched work auto-pushes as a rolling PR'}
              onClick={() => autoPush.prUrl && window.tangos.openExternal(autoPush.prUrl)}
              style={{ cursor: autoPush.prUrl ? 'pointer' : 'default' }}
            >
              <GitPullRequest size={12} />
              {autoPush.state === 'pushing'
                ? 'pushing…'
                : autoPush.state === 'ok'
                  ? 'PR updated'
                  : autoPush.state === 'error'
                    ? 'push failed'
                    : autoPush.state === 'skipped'
                      ? 'auto-PR blocked'
                      : 'auto-PR on'}
            </span>
          )}
        </div>
        <div className="ctl-foot-side right">
          <GithubSignIn />
        </div>
      </div>
    </div>
  )
}

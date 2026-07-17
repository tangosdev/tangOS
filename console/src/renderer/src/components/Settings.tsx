import { useState, type ReactNode } from 'react'
import { FolderOpen, Bug, ChevronRight, Trash2 } from 'lucide-react'
import type { RepoState, BackgroundPrefs, MatchingPrefs } from '../../../shared/types'
import KeyVault from './KeyVault'
import SyncRepo from './SyncRepo'

/** Clear-all-stats with an inline two-click confirm (no native dialog): the first click arms it,
 *  a second within 4s wipes. Keeps a stray click from nuking every tally. */
function ClearStatsButton(): JSX.Element {
  const [armed, setArmed] = useState(false)
  const [done, setDone] = useState(false)
  return (
    <button
      className={`mini-btn${armed ? ' danger' : ''}`}
      onClick={async () => {
        if (!armed) {
          setArmed(true)
          window.setTimeout(() => setArmed(false), 4000)
          return
        }
        await window.tangos.clearAllStats()
        setArmed(false)
        setDone(true)
        window.setTimeout(() => setDone(false), 3000)
      }}
    >
      <Trash2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
      {done ? 'Stats cleared' : armed ? 'Click again to confirm' : 'Clear all stats'}
    </button>
  )
}

/** Collapsible "info bubble" - keeps the settings panel compact by tucking each setting's long
 *  explanation behind a click. Collapsed by default. */
function Info({ children }: { children: ReactNode }): JSX.Element {
  return (
    <details className="settings-info">
      <summary>
        <ChevronRight size={11} className="settings-info-caret" /> What&apos;s this?
      </summary>
      <div className="settings-info-body">{children}</div>
    </details>
  )
}

/** The gear-opened settings panel: repo/decomp folder, theme, throughput, and the API-key vault.
 *  Long explanations live in collapsible Info bubbles so the panel stays short. */
export default function Settings({
  repo,
  theme,
  themes,
  onTheme,
  onPickRepo,
  reportsEnabled,
  useAgents,
  agentFanout,
  autoLand,
  bgPrefs,
  onBgPrefs,
  matchingPrefs,
  onMatchingPrefs
}: {
  repo: RepoState | null
  theme: string
  themes: string[]
  onTheme: (t: string) => void
  onPickRepo: () => void
  reportsEnabled: boolean
  useAgents: boolean
  agentFanout: number
  autoLand: boolean
  bgPrefs: BackgroundPrefs
  onBgPrefs: (p: Partial<BackgroundPrefs>) => void
  matchingPrefs: MatchingPrefs
  onMatchingPrefs: (p: Partial<MatchingPrefs>) => void
}): JSX.Element {
  const fanout = agentFanout ?? 8
  return (
    <div className="inner-pad settings-panel aero-scroll">
      <h2 style={{ margin: '0 0 10px' }}>Settings</h2>

      <div className="section-title">Decomp repo</div>
      <button className="repo-chip settings-repo" onClick={onPickRepo} title={repo?.path ?? ''}>
        <FolderOpen size={14} style={{ flex: 'none', opacity: 0.7 }} />
        <span className="path">{repo?.path ?? 'Choose a repo folder…'}</span>
      </button>
      <SyncRepo repo={repo} />
      <Info>
        <b>Sync repo</b> hard-resets this checkout to match <code>origin</code> - the fresh-clone state -
        throwing away local edits, custom/untracked files, and unpushed commits. Use it when your clone
        has drifted behind main and batches keep coming up short. Your extracted ROM, dependencies, and{' '}
        <code>.env</code> are kept, and the <b>Back up first</b> button saves everything it would delete.
      </Info>

      <div className="section-title" style={{ marginTop: 14 }}>Matching drafts</div>
      <label className="settings-check" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={matchingPrefs.allowNearMiss}
          onChange={(e) => onMatchingPrefs({ allowNearMiss: e.target.checked })}
        />
        <span>Allow near-miss tips</span>
      </label>
      <label className="settings-check" style={{ marginTop: 6 }}>
        <input
          type="checkbox"
          checked={matchingPrefs.allowGhidra}
          onChange={(e) => onMatchingPrefs({ allowGhidra: e.target.checked })}
        />
        <span>Allow Ghidra scaffolds</span>
      </label>
      <Info>
        Same idea as Chaos Viewer&apos;s draft toggles. These do <b>not</b> paste tip C, disasm, or
        Ghidra into the agent message — agents call tools / open files when ON. When near-miss is OFF,
        <code> nearmiss_*</code> tools are hidden on the next MCP session. Restart MCP (or reconnect
        the agent) after flipping Near-miss so the tool list updates. Ghidra policy applies on the
        next <code>next_batch</code> immediately.
      </Info>

      <div className="section-title" style={{ marginTop: 14 }}>Theme</div>
      <select className="theme-select" value={theme} onChange={(e) => onTheme(e.target.value)} style={{ width: '100%' }}>
        {themes.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <label className="settings-check" style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={bgPrefs.enabled}
          onChange={(e) => onBgPrefs({ enabled: e.target.checked })}
        />
        <span>Animate the background</span>
      </label>
      <Info>
        Turns the theme&apos;s background into a drifting blurred mesh-gradient with soft glass bubbles
        behind the panels. Off falls back to the flat theme background. Motion is kept calm and pauses
        when the window is hidden.
      </Info>

      <div className="section-title" style={{ marginTop: 14 }}>Throughput</div>
      <label className="settings-check">
        <input type="checkbox" checked={useAgents} onChange={(e) => window.tangos.setUseAgents(e.target.checked)} />
        <span>Use agents (run batches in parallel)</span>
      </label>
      <Info>
        Off = one worker at a time. On = a console-driven AI runs its batch across several parallel workers,
        and multiple AIs can drive at once. Faster, but uses more API tokens and CPU.
      </Info>

      <div className="settings-num-row">
        <span>Functions per sub-agent</span>
        <input
          type="number"
          min={1}
          max={64}
          value={fanout}
          onChange={(e) => {
            const n = Math.floor(Number(e.target.value))
            if (Number.isFinite(n) && n >= 1) window.tangos.setAgentFanout(Math.min(64, n))
          }}
          style={{ width: 60 }}
        />
      </div>
      <Info>
        When agents mode is on and an AI fans out into sub-agents, each one takes this many functions
        (a 16-function batch = {Math.max(1, Math.round(16 / fanout))} sub-agents). 8 is the sweet spot -
        smaller repeats per-agent setup cost, and one-function-per-agent is the most wasteful.
      </Info>
      {fanout !== 8 && (
        <span className="aib-size-warn">
          {fanout < 8
            ? `${fanout} per sub-agent is low - small groups repeat setup cost and waste tokens. 8 is recommended.`
            : `${fanout} per sub-agent is high - big groups make each sub-agent slow and pricey. 8 is recommended.`}
        </span>
      )}

      <label className="settings-check" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={autoLand} onChange={(e) => window.tangos.setAutoLand(e.target.checked)} />
        <span>Auto-land matches into the repo</span>
      </label>
      <Info>
        On (default) = when a drive finishes, its matches are banked into <code>src/</code>, the free-tier
        clone pass runs, and every bank is link-checked - so a found match actually reaches your working tree.
        It stops before <code>git commit</code>; review and commit yourself. Off = matches stay in a scratch
        file for you to land by hand.
      </Info>

      <div className="section-title" style={{ marginTop: 14 }}>Help</div>
      <button className="mini-btn" onClick={() => window.tangos.replayTour()}>
        Replay Tango&apos;s tour
      </button>

      <div className="section-title" style={{ marginTop: 14 }}>Stats</div>
      <ClearStatsButton />
      <Info>
        Wipes every AI box&apos;s tallies - matches, hit rate, near misses, tokens, and the per-function
        best-divergence history - for both all-time and this run. Can&apos;t be undone.
      </Info>

      <div className="section-title" style={{ marginTop: 14 }}>Debug reports</div>
      <label className="settings-check">
        <input type="checkbox" checked={reportsEnabled} onChange={(e) => window.tangos.setReports(e.target.checked)} />
        <span>Save batch &amp; run reports (48h)</span>
      </label>
      <Info>
        Off by default. When on, every batch and tool run is logged locally for 48 hours so you can share
        them for prompt and driver tuning. Nothing is sent anywhere.
      </Info>
      {reportsEnabled && (
        <button className="mini-btn" onClick={() => window.tangos.openReports()}>
          <FolderOpen size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          Open reports folder
        </button>
      )}

      <div className="section-title" style={{ marginTop: 14 }}>Debug snapshot</div>
      <Info>
        Saves a screenshot + full app state + the rendered layout to a folder, for diagnosing visual and
        state bugs. Shortcut: <code>Ctrl+Shift+D</code>. (<code>Ctrl+Shift+I</code> toggles DevTools.)
      </Info>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="mini-btn go" onClick={() => window.tangos.dumpDebug()}>
          <Bug size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          Save snapshot
        </button>
        <button className="mini-btn" onClick={() => window.tangos.openDebug()}>
          <FolderOpen size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          Open debug folder
        </button>
      </div>

      <div className="section-title" style={{ marginTop: 14 }}>API keys</div>
      <KeyVault />
    </div>
  )
}

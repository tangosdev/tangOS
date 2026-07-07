import { FolderOpen } from 'lucide-react'
import type { RepoState } from '../../../shared/types'
import KeyVault from './KeyVault'

/** The gear-opened settings panel: repo/decomp folder, theme, and the API-key vault.
 *  Everything that used to clutter the top bar lives here now. */
export default function Settings({
  repo,
  theme,
  themes,
  onTheme,
  onPickRepo,
  reportsEnabled,
  useAgents,
  autoLand
}: {
  repo: RepoState | null
  theme: string
  themes: string[]
  onTheme: (t: string) => void
  onPickRepo: () => void
  reportsEnabled: boolean
  useAgents: boolean
  autoLand: boolean
}): JSX.Element {
  return (
    <div className="inner-pad settings-panel aero-scroll">
      <h2 style={{ margin: '0 0 10px' }}>Settings</h2>

      <div className="section-title">Decomp repo</div>
      <button className="repo-chip settings-repo" onClick={onPickRepo} title={repo?.path ?? ''}>
        <FolderOpen size={14} style={{ flex: 'none', opacity: 0.7 }} />
        <span className="path">{repo?.path ?? 'Choose a repo folder…'}</span>
      </button>

      <div className="section-title" style={{ marginTop: 14 }}>Theme</div>
      <select className="theme-select" value={theme} onChange={(e) => onTheme(e.target.value)} style={{ width: '100%' }}>
        {themes.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <div className="section-title" style={{ marginTop: 14 }}>Throughput</div>
      <label className="settings-check">
        <input type="checkbox" checked={useAgents} onChange={(e) => window.tangos.setUseAgents(e.target.checked)} />
        <span>Use agents (run batches in parallel)</span>
      </label>
      <p className="hint" style={{ margin: '2px 0 6px' }}>
        Off = one worker at a time. On = a console-driven AI runs its batch across several parallel workers,
        and multiple AIs can drive at once. Faster, but uses more API tokens and CPU.
      </p>
      <label className="settings-check" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={autoLand} onChange={(e) => window.tangos.setAutoLand(e.target.checked)} />
        <span>Auto-land matches into the repo</span>
      </label>
      <p className="hint" style={{ margin: '2px 0 6px' }}>
        On (default) = when a drive finishes, its matches are banked into <code>src/</code>, the free-tier
        clone pass runs, and every bank is link-checked — so a found match actually reaches your working tree.
        It stops before <code>git commit</code>; review and commit yourself. Off = matches stay in a scratch
        file for you to land by hand.
      </p>

      <div className="section-title" style={{ marginTop: 14 }}>Help</div>
      <button className="mini-btn" onClick={() => window.tangos.replayTour()}>
        Replay Tango&apos;s tour
      </button>

      <div className="section-title" style={{ marginTop: 14 }}>Debug reports</div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={reportsEnabled}
          onChange={(e) => window.tangos.setReports(e.target.checked)}
        />
        <span>Save batch &amp; run reports (48h)</span>
      </label>
      <p className="hint" style={{ margin: '2px 0 6px' }}>
        Off by default. When on, every batch and tool run is logged locally for 48 hours so you can share
        them for prompt and driver tuning. Nothing is sent anywhere.
      </p>
      {reportsEnabled && (
        <button className="mini-btn" onClick={() => window.tangos.openReports()}>
          <FolderOpen size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          Open reports folder
        </button>
      )}

      <div className="section-title" style={{ marginTop: 14 }}>API keys</div>
      <KeyVault />
    </div>
  )
}

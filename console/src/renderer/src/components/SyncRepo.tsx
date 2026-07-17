import { useEffect, useState } from 'react'
import { RefreshCw, Loader2, AlertTriangle, Save, Check, FolderOpen } from 'lucide-react'
import type { RepoState, SyncPreview } from '../../../shared/types'

/** "Sync repo": a hard reset of the local checkout back to origin/<default> plus a clean of
 *  untracked files - the fresh-clone src tree, keeping the gitignored setup (extracted ROM, deps,
 *  .env). Destructive, so it hides behind a confirm that spells out exactly what's lost, offers a
 *  one-click backup first, and arms the actual sync with a second click. */
export default function SyncRepo({ repo }: { repo: RepoState | null }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<SyncPreview | null>(null)
  const [busy, setBusy] = useState<'backup' | 'sync' | null>(null)
  const [armed, setArmed] = useState(false)
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null)
  const [backup, setBackup] = useState<{ path: string; files: number; bundle: boolean } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => window.tangos.onRepoSyncProgress(setProgress), [])

  // Only a real git checkout can be synced (a Download-ZIP snapshot has no origin to reset to).
  if (!repo?.path || repo.isGit === false) return null

  async function expand(): Promise<void> {
    setOpen(true)
    setResult(null)
    setBackup(null)
    setArmed(false)
    setPreview(null)
    try {
      setPreview(await window.tangos.repoSyncPreview())
    } catch {
      setPreview(null)
    }
  }

  async function backUp(): Promise<void> {
    setBusy('backup')
    setResult(null)
    try {
      const r = await window.tangos.repoBackup()
      if (r.ok && r.path) setBackup({ path: r.path, files: r.files ?? 0, bundle: r.bundle !== false })
      else setResult({ ok: false, text: `Backup failed: ${r.error ?? 'unknown error'}` })
    } finally {
      setBusy(null)
    }
  }

  async function sync(): Promise<void> {
    if (!armed) {
      setArmed(true)
      window.setTimeout(() => setArmed(false), 5000)
      return
    }
    setArmed(false)
    setBusy('sync')
    setResult(null)
    setProgress({ label: 'Starting', pct: 0 })
    try {
      const r = await window.tangos.repoSync()
      if (r.ok) {
        setResult({ ok: true, text: `Synced to origin/${r.branch} (${r.head}). Your checkout is fresh.` })
        setPreview(await window.tangos.repoSyncPreview().catch(() => null as unknown as SyncPreview))
      } else {
        setResult({ ok: false, text: `Sync failed: ${r.error ?? 'unknown error'}` })
      }
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const p = preview
  const nothingToLose = p && !p.localChanges && !p.untracked && !p.ahead

  return (
    <div className="sync-repo">
      {!open ? (
        <button className="mini-btn" onClick={expand} title="Reset this checkout back to origin (a fresh-clone src tree)">
          <RefreshCw size={12} style={{ verticalAlign: -2, marginRight: 4 }} /> Sync repo…
        </button>
      ) : (
        <div className="sync-repo-card">
          <div className="sync-repo-warn">
            <AlertTriangle size={14} />
            <span>
              Resets this checkout to match <code>origin/{p?.defaultBranch ?? 'main'}</code> exactly. Any
              uncommitted edits, <b>custom or untracked files</b>, and unpushed local commits are{' '}
              <b>permanently deleted</b>. Your extracted ROM, dependencies, and <code>.env</code> are kept.
            </span>
          </div>

          {p && !p.error && (
            <div className="sync-repo-counts">
              {nothingToLose ? (
                <span className="muted">Nothing local to lose - you&apos;re already clean.</span>
              ) : (
                <>
                  This will discard{' '}
                  <b>{p.localChanges}</b> local change{p.localChanges === 1 ? '' : 's'},{' '}
                  <b>{p.untracked}</b> custom file{p.untracked === 1 ? '' : 's'}, and{' '}
                  <b>{p.ahead}</b> unpushed commit{p.ahead === 1 ? '' : 's'}
                  {p.behind > 0 && (
                    <>
                      {' '}
                      &middot; gains <b>{p.behind}</b> new upstream commit{p.behind === 1 ? '' : 's'}
                    </>
                  )}
                  .
                </>
              )}
            </div>
          )}
          {p?.error && <div className="sync-repo-counts muted">Couldn&apos;t read repo state: {p.error}</div>}

          {backup && (
            <div className={`sync-repo-msg ${backup.bundle ? 'ok' : 'err'}`}>
              {backup.bundle ? <Check size={13} /> : <AlertTriangle size={13} />}
              {backup.bundle
                ? `Backed up ${backup.files} file${backup.files === 1 ? '' : 's'} + local commits.`
                : `Backed up ${backup.files} file${backup.files === 1 ? '' : 's'}, but the COMMIT bundle failed - unpushed commits are NOT backed up.`}
              <button className="linkish" onClick={() => window.tangos.revealPath(backup.path)} title={backup.path}>
                <FolderOpen size={12} style={{ verticalAlign: -2, marginRight: 3 }} /> Open backup
              </button>
            </div>
          )}
          {result && (
            <div className={`sync-repo-msg ${result.ok ? 'ok' : 'err'}`}>
              {result.ok ? <Check size={13} /> : <AlertTriangle size={13} />} {result.text}
            </div>
          )}

          {busy === 'sync' && progress && (
            <div className="repo-warn-progress">
              <div className="repo-warn-progress-track">
                <i style={{ width: `${progress.pct}%` }} />
              </div>
              <span className="repo-warn-progress-label">{progress.label}</span>
            </div>
          )}

          <div className="sync-repo-actions">
            <button className="mini-btn" disabled={!!busy} onClick={backUp} title="Copy everything the sync would delete into a timestamped backup folder next to the repo">
              {busy === 'backup' ? <Loader2 size={12} className="spin" /> : <Save size={12} />} Back up first
            </button>
            <button className={`mini-btn danger`} disabled={!!busy} onClick={sync}>
              {busy === 'sync' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}{' '}
              {armed ? 'Click again to sync' : 'Sync repo'}
            </button>
            <button className="linkish" disabled={!!busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

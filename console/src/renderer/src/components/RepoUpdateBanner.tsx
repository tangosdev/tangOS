import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, Download, Loader2, Check } from 'lucide-react'
import type { RepoState, RepoUpdateStatus } from '../../../shared/types'

/** Warns when the local checkout is stale and offers a one-click fix:
 *  - not a git checkout (Download ZIP): stale tooling -> "Clone fresh copy"
 *  - git checkout behind origin: -> "Update" (fast-forward, never clobbers local work) */
export default function RepoUpdateBanner({
  repo,
  onRepo
}: {
  repo: RepoState
  onRepo: (r: RepoState) => void
}): JSX.Element | null {
  const [status, setStatus] = useState<RepoUpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Re-check whenever the repo changes. Skipped for ZIP snapshots (case 1 handles those).
  useEffect(() => {
    let alive = true
    setStatus(null)
    setMsg(null)
    if (!repo.path || repo.isGit === false) return
    window.tangos
      .repoUpdateStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [repo.path, repo.isGit])

  const github = repo.descriptor?.project?.github

  async function update(): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.tangos.repoPull()
      if (r.ok) {
        setStatus(await window.tangos.repoUpdateStatus())
        setMsg('Updated to the latest.')
        setTimeout(() => setMsg(null), 4000)
      } else if (r.err && /diverged|fast-forward|non-fast/i.test(r.err)) {
        setMsg("Your branch has local commits the remote doesn't — can't auto-update. Commit or reconcile manually.")
      } else {
        setMsg(`Update failed: ${r.err ?? 'unknown error'}`)
      }
    } finally {
      setBusy(false)
    }
  }

  async function cloneFresh(): Promise<void> {
    if (!github) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.tangos.cloneAndOpen(github)
      if (res.ok && res.repo?.path) onRepo(res.repo)
      else if (res.error) setMsg('Clone failed: ' + res.error)
    } finally {
      setBusy(false)
    }
  }

  // Case 1: a Download-ZIP snapshot, not a real checkout.
  if (repo.path && repo.isGit === false) {
    return (
      <div className="repo-warn">
        <AlertTriangle size={14} />
        <span>
          This folder isn&apos;t a git checkout — looks like a <b>Download ZIP</b>. You can&apos;t commit or push from
          here, and the tooling may be out of date.{' '}
          {github ? (
            'Get a proper clone for a working setup:'
          ) : (
            <>
              Use <code>git clone</code> for a working setup.
            </>
          )}
        </span>
        {github && (
          <button className="repo-warn-btn" disabled={busy} onClick={cloneFresh}>
            {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Clone fresh copy
          </button>
        )}
        {msg && <span className="repo-warn-msg">{msg}</span>}
      </div>
    )
  }

  // Case 2: a git checkout that's behind the remote default branch.
  if (status?.isGit && (status.behind ?? 0) > 0) {
    const db = status.defaultBranch ?? 'main'
    return (
      <div className="repo-warn behind">
        <ArrowDownToLine size={14} />
        <span>
          Your local is <b>{status.behind}</b> commit{status.behind === 1 ? '' : 's'} behind{' '}
          <code>origin/{db}</code>
          {status.dirty ? ' (your uncommitted work is kept)' : ''}.
        </span>
        <button className="repo-warn-btn" disabled={busy} onClick={update}>
          {busy ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />} Update
        </button>
        {msg && <span className="repo-warn-msg">{msg}</span>}
      </div>
    )
  }

  // Brief confirmation after an update lands (or a failure message), else nothing.
  if (msg) {
    return (
      <div className="repo-warn ok">
        <Check size={14} />
        <span>{msg}</span>
      </div>
    )
  }
  return null
}

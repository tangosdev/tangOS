import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, Download, Loader2, Check, GitPullRequest } from 'lucide-react'
import type { RepoState, RepoUpdateStatus } from '../../../shared/types'

/** Warns when the local checkout is stale and offers a one-click fix:
 *  - not a git checkout (Download ZIP): stale tooling -> "Clone fresh copy"
 *  - git checkout behind origin: -> "Update" (fast-forward, never clobbers local work) */
export default function RepoUpdateBanner({
  repo,
  onRepo,
  refreshNonce = 0
}: {
  repo: RepoState
  onRepo: (r: RepoState) => void
  refreshNonce?: number // bumped by the top-bar refresh; re-runs the local-vs-origin check
}): JSX.Element | null {
  const [status, setStatus] = useState<RepoUpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  // A transient banner message carries its outcome, so a failure is never rendered as a green "ok".
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null)

  // Live phase + percent streamed from the main process during an Update, so the button isn't a
  // dead spinner during the slow git fetch/rebase. Subscribe synchronously (StrictMode-safe).
  useEffect(() => window.tangos.onRepoPullProgress(setProgress), [])

  // Reset the transient banner state only when the repo itself changes (not on a refresh), so a
  // manual refresh doesn't blank the banner out from under the fresh check below.
  useEffect(() => {
    setStatus(null)
    setMsg(null)
  }, [repo.path, repo.isGit])

  // Auto-dismiss any transient message (success OR failure) after 10s. A "Couldn't auto-update"
  // error used to sit in the banner forever; now every message clears itself.
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), 10000)
    return () => clearTimeout(t)
  }, [msg])

  // (Re-)check on repo change AND whenever the refresh nonce bumps. repo:updateStatus does a real
  // git fetch first, so if a PR merged upstream while the app was open, one refresh clears the
  // "behind"/"diverged" banner. Skipped for ZIP snapshots (case 1 handles those).
  useEffect(() => {
    let alive = true
    if (!repo.path || repo.isGit === false) return
    window.tangos
      .repoUpdateStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [repo.path, repo.isGit, refreshNonce])

  const github = repo.descriptor?.project?.github

  async function update(): Promise<void> {
    setBusy(true)
    setMsg(null)
    setProgress({ label: 'Starting', pct: 0 })
    try {
      const r = await window.tangos.repoPull()
      if (r.ok) {
        setStatus(await window.tangos.repoUpdateStatus())
        setMsg({ text: r.note ? `Updated to the latest. ${r.note}` : 'Updated to the latest.', ok: true })
      } else if (r.err && /conflict|rebase/i.test(r.err)) {
        setMsg({ text: "Couldn't auto-update - your local changes conflict with the new upstream work. Nothing was changed; reconcile manually.", ok: false })
      } else {
        setMsg({ text: `Update failed: ${r.err ?? 'unknown error'}`, ok: false })
      }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function cloneFresh(): Promise<void> {
    if (!github) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.tangos.cloneAndOpen(github)
      if (res.ok && res.repo?.path) onRepo(res.repo)
      else if (res.error) setMsg({ text: 'Clone failed: ' + res.error, ok: false })
    } finally {
      setBusy(false)
    }
  }

  async function pushWorkPr(): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.tangos.repoPushWorkPr()
      if (r.ok) {
        if (r.url) window.tangos.openExternal(r.url)
        setMsg({ text: 'Opened a PR with your local commits.', ok: true })
        setStatus(await window.tangos.repoUpdateStatus())
      } else {
        setMsg({ text: r.error?.includes('signed into GitHub') ? 'Sign into GitHub in Settings, then try again.' : `Push failed: ${r.error ?? 'unknown error'}`, ok: false })
      }
    } finally {
      setBusy(false)
    }
  }

  // Single source of truth for the transient message row: green + check on success, red + alert on
  // failure. Rendered in exactly one place per branch so an error never shows up as a green "ok".
  const msgRow = msg && (
    <div className={`repo-warn ${msg.ok ? 'ok' : 'err'}`}>
      {msg.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
      <span>{msg.text}</span>
    </div>
  )

  // Case 1: a Download-ZIP snapshot, not a real checkout.
  if (repo.path && repo.isGit === false) {
    return (
      <div className="repo-warn">
        <AlertTriangle size={14} />
        <span>
          This folder isn&apos;t a git checkout - looks like a <b>Download ZIP</b>. You can&apos;t commit or push from
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
        {msg && <span className="repo-warn-msg">{msg.text}</span>}
      </div>
    )
  }

  // Case 2: a git checkout. Two INDEPENDENT signals, each its own row - having unpublished commits
  // never blocks getting new upstream work (that was the old, wrong coupling):
  //   - behind: new upstream commits you don't have -> Update (rebases, so it keeps your local work)
  //   - unmergedAhead: your commits not yet published; already-merged ones are excluded, so a
  //     squash-merged PR stops nagging. Quiet and optional - no pressure to publish.
  {
    const behind = status?.behind ?? 0
    const unpublished = status?.unmergedAhead ?? 0
    if (status?.isGit && (behind > 0 || unpublished > 0)) {
      const db = status.defaultBranch ?? 'main'
      return (
        <>
          {behind > 0 && (
            <div className="repo-warn behind">
              <ArrowDownToLine size={14} />
              <span>
                <b>{behind}</b> new commit{behind === 1 ? '' : 's'} available from <code>origin/{db}</code>
                {status?.dirty ? ' (your uncommitted work is kept)' : ''}.
              </span>
              <button className="repo-warn-btn" disabled={busy} onClick={update}>
                {busy ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />}{' '}
                {busy && progress ? `${progress.pct}%` : 'Update'}
              </button>
              {busy && progress && (
                <div className="repo-warn-progress">
                  <div className="repo-warn-progress-track">
                    <i style={{ width: `${progress.pct}%` }} />
                  </div>
                  <span className="repo-warn-progress-label">{progress.label}</span>
                </div>
              )}
            </div>
          )}
          {unpublished > 0 && (
            <div className="repo-warn unpushed">
              <GitPullRequest size={14} />
              <span>
                You have <b>{unpublished}</b> unpublished commit{unpublished === 1 ? '' : 's'} - optional, publish
                whenever. Your local branch stays untouched.
              </span>
              <button className="repo-warn-btn ghost" disabled={busy} onClick={pushWorkPr}>
                {busy ? <Loader2 size={13} className="spin" /> : <GitPullRequest size={13} />} Push as PR
              </button>
            </div>
          )}
          {msgRow}
        </>
      )
    }
  }

  // Brief confirmation after an update lands (or a failure message), else nothing.
  return msgRow || null
}

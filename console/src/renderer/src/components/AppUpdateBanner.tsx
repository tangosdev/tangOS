import { useEffect, useState } from 'react'
import { ArrowUpCircle, Download, RefreshCw } from 'lucide-react'
import type { AppUpdateInfo } from '../../../shared/types'

/** Top banner that says a newer app release is out. Two live sources feed it:
 *  - the updater's event stream (startup check + background download progress), and
 *  - a manual check fired by the top-bar refresh button (refreshNonce bump).
 *  Renders nothing unless an update is actually available/downloaded (dev, up-to-date, offline,
 *  and errored all show nothing). Packaged builds only - the updater no-ops in dev. */
export default function AppUpdateBanner({ refreshNonce = 0 }: { refreshNonce?: number }): JSX.Element | null {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null)
  const [restarting, setRestarting] = useState(false)

  // Don't let a later manual "available" downgrade an already-"downloaded" state for the same
  // version (a re-check after the download still reports the version as newer than the running one).
  function apply(next: AppUpdateInfo): void {
    setInfo((prev) =>
      prev?.state === 'downloaded' && next.state === 'available' && next.version === prev.version ? prev : next
    )
  }

  // Live updater events. Subscribe synchronously so StrictMode's mount/cleanup/remount can remove
  // the listener (a subscribe after an await would leak a duplicate).
  useEffect(() => {
    return window.tangos.onAppUpdate(apply)
  }, [])

  // Check on mount and on every refresh. In dev this returns 'dev' and the banner stays hidden.
  useEffect(() => {
    let alive = true
    window.tangos
      .checkAppUpdate()
      .then((r) => alive && apply(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [refreshNonce])

  if (info?.state !== 'available' && info?.state !== 'downloaded') return null
  const downloaded = info.state === 'downloaded'

  async function restart(): Promise<void> {
    setRestarting(true)
    await window.tangos.quitAndInstall()
  }

  return (
    <div className="repo-warn update">
      {downloaded ? <ArrowUpCircle size={14} /> : <Download size={14} />}
      <span>
        {downloaded ? (
          <>
            Update <b>v{info.version}</b> is ready - restart to finish. It also installs on its own next
            time you quit.
          </>
        ) : (
          <>
            A new version (<b>v{info.version}</b>) is out - downloading it in the background.
          </>
        )}
      </span>
      {downloaded && (
        <button className="repo-warn-btn" disabled={restarting} onClick={restart}>
          <RefreshCw size={13} className={restarting ? 'spin' : ''} /> Restart &amp; update
        </button>
      )}
    </div>
  )
}

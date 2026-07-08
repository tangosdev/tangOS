import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppUpdateInfo } from '../shared/types'

// Checks this repo's public GitHub Releases for a newer build, downloads it in the background, and
// surfaces it in the app's top banner (see AppUpdateBanner) instead of a modal dialog. It also
// installs on next quit regardless. No-ops in dev - it only works in a packaged install. Failures
// (offline, no releases yet) are swallowed quietly and reported to the UI as state 'error'.

/** Push the current update state to the renderer's top banner. */
function broadcast(info: AppUpdateInfo): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('app:update', info)
}

/** Numeric x.y.z compare - true when `a` is strictly newer than `b`. Avoids a false "update out"
 *  when the running build is actually ahead of the published release (a local dev/test build). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true
    if ((pa[i] || 0) < (pb[i] || 0)) return false
  }
  return false
}

export function initAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => broadcast({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => broadcast({ state: 'none' }))
  autoUpdater.on('update-downloaded', (info) => broadcast({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', () => broadcast({ state: 'error' }))

  autoUpdater.checkForUpdates().catch(() => {})
}

/** Manual check, wired to the top-bar refresh button. Triggers a fresh look at Releases (which also
 *  fires the events above) and returns the state directly for immediate UI feedback. */
export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  if (!app.isPackaged) return { state: 'dev' }
  try {
    const r = await autoUpdater.checkForUpdates()
    const v = r?.updateInfo?.version
    if (v && isNewer(v, app.getVersion())) return { state: 'available', version: v }
    return { state: 'none' }
  } catch {
    return { state: 'error' }
  }
}

/** Restart into the downloaded update now (the banner's "Restart & update" button). */
export function quitAndInstallUpdate(): void {
  if (app.isPackaged) autoUpdater.quitAndInstall()
}

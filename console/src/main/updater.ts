import { app, dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

// Checks the public tangos-console GitHub Releases for a newer build, downloads it in the
// background, and offers to restart into it (also installs on next quit). No-ops in dev — it only
// works in a packaged install. Failures (offline, no releases yet) are swallowed quietly.
export function initAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', async (info) => {
    const win = BrowserWindow.getAllWindows()[0]
    const opts = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'tangOS Console update ready',
      message: `Version ${info.version} downloaded.`,
      detail: 'Restart to finish updating. It will also install automatically next time you quit.'
    }
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', () => {
    /* offline, rate-limited, or no releases published yet — ignore */
  })

  autoUpdater.checkForUpdates().catch(() => {})
}

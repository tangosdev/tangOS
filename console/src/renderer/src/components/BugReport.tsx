import { useState, type ClipboardEvent } from 'react'
import { Bug, X, ImagePlus, Loader2, Check } from 'lucide-react'

/** Report-a-bug dialog: description + screenshots + an auto-gathered debug bundle. On submit,
 *  the main process writes a folder (report + screenshots + debug), copies a paste-ready report
 *  to the clipboard, and opens the folder so the user can attach the shots wherever they file it. */
export default function BugReport({
  repoName,
  localOnly,
  onClose
}: {
  repoName?: string
  /** A local-only project is open: the report leaves the project out, and the dialog says so. */
  localOnly?: boolean
  onClose: () => void
}): JSX.Element {
  const [desc, setDesc] = useState('')
  const [shots, setShots] = useState<string[]>([]) // absolute paths
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ folder: string } | null>(null)

  async function attach(): Promise<void> {
    const paths = await window.tangos.pickBugScreenshots()
    if (paths.length) setShots((s) => [...new Set([...s, ...paths])])
  }

  async function onPaste(e: ClipboardEvent): Promise<void> {
    const items = Array.from(e.clipboardData?.items ?? [])
    const img = items.find((i) => i.type.startsWith('image/'))
    if (!img) return
    const file = img.getAsFile()
    if (!file) return
    const buf = new Uint8Array(await file.arrayBuffer())
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
    const path = await window.tangos.saveBugImage(Array.from(buf), ext)
    if (path) setShots((s) => [...s, path])
  }

  async function submit(): Promise<void> {
    setBusy(true)
    try {
      const res = await window.tangos.submitBug({ description: desc, screenshots: shots })
      setDone({ folder: res.folder })
    } catch (e) {
      alert(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-detail-scrim" onClick={onClose}>
      <div className="bug-report aero-panel solid" onClick={(e) => e.stopPropagation()} onPaste={onPaste}>
        <div className="head">
          <Bug size={16} />
          <h2>Report a bug</h2>
          <div style={{ flex: 1 }} />
          <button className="dock-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {done ? (
          <div className="bug-done">
            <Check size={30} className="bug-check" />
            <p>
              <b>Report ready.</b> The details are copied to your clipboard and the folder with your
              screenshots is open - paste the report wherever you file bugs and drag the screenshots in.
            </p>
            <code className="bug-folder">{done.folder}</code>
            <button className="mini-btn go" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <p className="hint" style={{ margin: '0 0 8px' }}>
              What went wrong? We attach app version, OS, and recent activity{repoName && !localOnly ? ` in ${repoName}` : ''} -{' '}
              <b>no API keys</b>. Ctrl+V to paste a screenshot.
            </p>
            {localOnly && (
              <p className="hint" style={{ margin: '0 0 8px' }}>
                This project is local only, so the attached details leave out its name, folder, branch and tool output.
                Your own description and screenshots go in as they are: check them before you share the report.
              </p>
            )}
            <textarea
              className="bug-desc"
              placeholder="Describe the bug: what you did, what you expected, what happened…"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              autoFocus
            />
            <div className="bug-shots">
              <button className="mini-btn" onClick={attach}>
                <ImagePlus size={12} /> Attach screenshots
              </button>
              {shots.map((p) => (
                <span className="bug-chip" key={p} title={p}>
                  {p.split(/[\\/]/).pop()}
                  <button className="role-x" onClick={() => setShots((s) => s.filter((x) => x !== p))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="bug-actions">
              <button className="mini-btn" onClick={onClose}>
                Cancel
              </button>
              <button className="mini-btn go" disabled={busy || !desc.trim()} onClick={submit}>
                {busy ? <Loader2 size={12} className="spin" /> : null} Prepare report
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

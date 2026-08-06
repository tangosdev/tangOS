import { useState } from 'react'
import { FolderOpen, Github, Copy, Download, Compass } from 'lucide-react'
import type { ProjectSummary, RepoState } from '../../../shared/types'

/** Shown in the Controller's place for a project you're browsing but haven't cloned. The Viewer
 *  works fine off the published atlas; the tools need somewhere to run. */
export default function CloneGate({
  project,
  onChanged,
  onOpenViewer
}: {
  project: ProjectSummary | null
  onChanged: (r: RepoState) => void
  onOpenViewer: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const title = project?.title ?? 'This project'
  const github = project?.github ?? ''

  async function clone(): Promise<void> {
    if (!github) return
    setBusy(true)
    try {
      const res = await window.tangos.cloneAndOpen(`${github}.git`)
      if (res.ok && res.repo?.path) onChanged(res.repo)
      else if (res.error) alert('Clone failed:\n\n' + res.error)
    } finally {
      setBusy(false)
    }
  }

  async function pick(): Promise<void> {
    const r = await window.tangos.pickRepo()
    if (r.path) onChanged(r)
  }

  return (
    <div className="center-stage">
      <div className="landing aero-panel">
        <h1>{title} isn&apos;t on this machine</h1>
        <p className="tagline">
          You can browse its progress in the Chaos Viewer right now - that reads the project&apos;s
          published data. Running its tools needs a local clone.
        </p>

        <button className="aero-button" onClick={clone} disabled={busy || !github}>
          <Download size={15} style={{ verticalAlign: -3, marginRight: 6 }} />
          {busy ? 'Cloning…' : 'Clone it'}
        </button>

        <div className="or-divider"><span>or</span></div>

        <button className="aero-button ghost" onClick={pick} disabled={busy}>
          <FolderOpen size={16} style={{ verticalAlign: -3, marginRight: 6 }} />
          Choose a folder you already have
        </button>
        <button className="aero-button ghost" onClick={onOpenViewer} disabled={busy}>
          <Compass size={16} style={{ verticalAlign: -3, marginRight: 6 }} />
          Open the Chaos Viewer
        </button>

        {github && (
          <div className="example-card aero-glass" style={{ marginTop: 22 }}>
            <div className="glyph">{project?.glyph}</div>
            <div className="meta">
              <div className="t">{title}</div>
              <div className="d">{github.replace(/^https:\/\//, '')}</div>
            </div>
            <div className="buttons">
              <button className="aero-button ghost" onClick={() => window.tangos.openExternal(github)}>
                <Github size={15} />
              </button>
              <button
                className="aero-button ghost"
                title="Copy a git clone command"
                onClick={() => window.tangos.copy(`git clone ${github}.git`)}
              >
                <Copy size={15} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

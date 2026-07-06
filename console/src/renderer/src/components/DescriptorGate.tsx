import { useState } from 'react'
import { Wand2, FileWarning, FolderOpen, FileCog } from 'lucide-react'
import type { RepoState, GenerateReport } from '../../../shared/types'

export default function DescriptorGate({
  repo,
  onChanged
}: {
  repo: RepoState
  onChanged: (r: RepoState) => void
}): JSX.Element {
  const [preview, setPreview] = useState<GenerateReport | null>(null)
  const [busy, setBusy] = useState(false)
  const invalid = repo.hasDescriptor && repo.validationErrors.length > 0

  async function generate(): Promise<void> {
    setBusy(true)
    try {
      setPreview(await window.tangos.generatePreview())
    } finally {
      setBusy(false)
    }
  }

  async function write(): Promise<void> {
    if (!preview) return
    setBusy(true)
    try {
      const r = await window.tangos.writeDescriptor(preview.descriptor)
      onChanged(r)
    } finally {
      setBusy(false)
    }
  }

  async function pickOther(): Promise<void> {
    const r = await window.tangos.pickRepo()
    if (r.path) {
      setPreview(null)
      onChanged(r)
    }
  }

  return (
    <div className="landing aero-panel" style={{ width: 'min(680px, 100%)' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        {invalid ? <FileWarning size={34} color="var(--aero-danger)" /> : <FileCog size={34} color="var(--aero-primary)" />}
      </div>
      <h1 style={{ fontSize: 22 }}>
        {invalid ? 'That tangos.json has problems' : 'No tangos.json here yet'}
      </h1>
      <p className="tagline">
        {invalid
          ? 'Fix these, or regenerate a fresh descriptor:'
          : 'tangOS can scan this repo and scaffold a descriptor. Review it, then write it to the repo.'}
      </p>

      {invalid && (
        <div className="errbox" style={{ textAlign: 'left' }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {repo.validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {!preview ? (
        <div className="actions">
          <button className="aero-button" onClick={generate} disabled={busy}>
            <Wand2 size={16} style={{ verticalAlign: -3, marginRight: 6 }} />
            {busy ? 'Scanning…' : 'Generate descriptor'}
          </button>
          <button className="aero-button ghost" onClick={pickOther}>
            <FolderOpen size={16} style={{ verticalAlign: -3, marginRight: 6 }} />
            Different folder
          </button>
        </div>
      ) : (
        <div style={{ textAlign: 'left' }}>
          <div className="section-title">What tangOS detected</div>
          <ul className="detect-list">
            {preview.detected.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
          <div className="section-title">Draft</div>
          <p className="hint" style={{ marginBottom: 12 }}>
            project <b>{preview.descriptor.project.title}</b> · {preview.descriptor.tools.length} tool(s).
            You can hand-edit tangos.json afterwards for full control.
          </p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="aero-button" onClick={write} disabled={busy}>
              {busy ? 'Writing…' : 'Write tangos.json'}
            </button>
            <button className="aero-button ghost" onClick={() => setPreview(null)}>
              Back
            </button>
          </div>
        </div>
      )}

      {repo.descriptorPath && (
        <p className="notice">
          <button
            className="aero-button ghost"
            style={{ padding: '3px 10px', fontSize: 12 }}
            onClick={() => window.tangos.openPath(repo.descriptorPath!)}
          >
            Open tangos.json
          </button>
        </p>
      )}
    </div>
  )
}

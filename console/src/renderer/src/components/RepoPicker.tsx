import { useState } from 'react'
import { FolderOpen, Github, Copy, Download } from 'lucide-react'
import type { RepoState } from '../../../shared/types'

const EXAMPLE = {
  title: 'sm64ds-decomp',
  desc: 'The reference repo — ships a hand-authored tangos.json exposing its full toolchain. (Running it still needs mwccarm + your own ROM.)',
  github: 'https://github.com/bmanus2-dotcom/sm64ds-decomp'
}

export default function RepoPicker({ onChanged }: { onChanged: (r: RepoState) => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  async function pick(): Promise<void> {
    const r = await window.tangos.pickRepo()
    if (r.path) onChanged(r)
  }

  async function clone(): Promise<void> {
    const u = url.trim()
    if (!u) return
    setBusy(true)
    try {
      const res = await window.tangos.cloneAndOpen(u)
      if (res.ok && res.repo?.path) onChanged(res.repo)
      else if (res.error) alert('Clone failed:\n\n' + res.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="landing aero-panel">
      <div className="brand" style={{ justifyContent: 'center', fontSize: 22 }}>
        <span>tang<span className="os">OS</span></span>
        <span className="sub">Console</span>
      </div>
      <h1>Point it at a decomp repo</h1>
      <p className="tagline">
        Paste a GitHub repo to clone it, or choose a folder you already have. tangOS reads its{' '}
        <code>tangos.json</code> and exposes the repo&apos;s tools as an MCP server an AI can drive — live.
      </p>

      <div className="repo-entry">
        <input
          className="ch-input"
          placeholder="Paste a GitHub repo URL to clone…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && clone()}
          disabled={busy}
        />
        <button className="aero-button" onClick={clone} disabled={busy || !url.trim()}>
          <Download size={15} style={{ verticalAlign: -3, marginRight: 6 }} />
          {busy ? 'Cloning…' : 'Get repo'}
        </button>
      </div>

      <div className="or-divider"><span>or</span></div>

      <button className="aero-button ghost" onClick={pick} disabled={busy}>
        <FolderOpen size={16} style={{ verticalAlign: -3, marginRight: 6 }} />
        Choose repo folder
      </button>

      <div className="section-title" style={{ marginTop: 22 }}>Example</div>
      <div className="example-card aero-glass">
        <div className="glyph">64</div>
        <div className="meta">
          <div className="t">{EXAMPLE.title}</div>
          <div className="d">{EXAMPLE.desc}</div>
        </div>
        <div className="buttons">
          <button className="aero-button ghost" title="Use this URL" onClick={() => setUrl(`${EXAMPLE.github}.git`)} disabled={busy}>
            Use
          </button>
          <button className="aero-button ghost" onClick={() => window.tangos.openExternal(EXAMPLE.github)}>
            <Github size={15} />
          </button>
          <button className="aero-button ghost" title="Copy a git clone command" onClick={() => window.tangos.copy(`git clone ${EXAMPLE.github}.git`)}>
            <Copy size={15} />
          </button>
        </div>
      </div>
      <p className="notice">
        No <code>tangos.json</code> in your repo yet? Open the folder anyway — tangOS will offer to generate one.
      </p>
    </div>
  )
}

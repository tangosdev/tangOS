import { useEffect, useState } from 'react'
import { Power, PowerOff, Copy, Plug, Users, Check, Sparkles } from 'lucide-react'
import type { McpState, ConnectedClient } from '../../../shared/types'
import { ROLE_NAMES } from '../../../shared/types'
import { aiColor } from '../aiColor'

interface RegisterOutcome {
  target: string
  path: string
  action: string
  message?: string
}

export default function McpBubble({
  mcp,
  onMcp,
  clients
}: {
  mcp: McpState | null
  onMcp: (m: McpState) => void
  clients: ConnectedClient[]
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<RegisterOutcome[] | null>(null)
  const [cli, setCli] = useState('')
  const [prompt, setPrompt] = useState('')
  const [copied, setCopied] = useState(false)
  const running = mcp?.running ?? false

  useEffect(() => {
    window.tangos.agentPrompt().then(setPrompt).catch(() => setPrompt(''))
  }, [running, mcp?.url])

  async function copyPrompt(): Promise<void> {
    await window.tangos.copy(prompt)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  async function toggleServer(): Promise<void> {
    setBusy(true)
    try {
      onMcp(running ? await window.tangos.stopMcp() : await window.tangos.startMcp())
    } catch (e) {
      alert(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function connect(): Promise<void> {
    setBusy(true)
    try {
      const res = await window.tangos.connect()
      setOutcomes(res.outcomes as RegisterOutcome[])
      setCli(res.cli)
    } catch (e) {
      alert(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="inner-pad">
      <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>MCP server</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        The endpoint an AI connects to. Every call it makes streams into the viewer.
      </p>

      <div className="kv">
        <span className="k">Status</span>
        <span className="v" style={{ color: running ? 'var(--aero-matched)' : 'var(--aero-muted)' }}>
          {running ? 'running' : 'stopped'}
        </span>
      </div>
      {running && (
        <>
          <div className="kv">
            <span className="k">Clients</span>
            <span className="v">
              <Users size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              {mcp?.connectedClients ?? 0}
            </span>
          </div>
          <div className="kv" style={{ alignItems: 'stretch', flexDirection: 'column', gap: 4 }}>
            <span className="k">URL</span>
            <div className="url-box">{mcp?.url}</div>
          </div>
        </>
      )}

      <div className="pill-row" style={{ marginTop: 12 }}>
        <button className={`aero-button${running ? ' danger' : ''}`} onClick={toggleServer} disabled={busy}>
          {running ? (
            <PowerOff size={15} style={{ verticalAlign: -2, marginRight: 5 }} />
          ) : (
            <Power size={15} style={{ verticalAlign: -2, marginRight: 5 }} />
          )}
          {running ? 'Stop' : 'Start server'}
        </button>
        {running && (
          <>
            <button className="aero-button ghost" onClick={() => window.tangos.copy(mcp!.url!)}>
              <Copy size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
              Copy
            </button>
            <button className="aero-button" onClick={connect} disabled={busy}>
              <Plug size={15} style={{ verticalAlign: -2, marginRight: 5 }} />
              Add to Claude
            </button>
          </>
        )}
      </div>

      {cli && (
        <>
          <div className="section-title" style={{ marginTop: 12 }}>Or add it yourself</div>
          <div className="url-box" onClick={() => window.tangos.copy(cli)} title="click to copy">{cli}</div>
        </>
      )}
      {outcomes && (
        <ul className="detect-list">
          {outcomes.map((o, i) => (
            <li key={i} style={{ color: o.action === 'error' ? 'var(--aero-danger)' : undefined }}>
              {o.target}: {o.action}{o.message ? ` (${o.message})` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="section-title" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Sparkles size={13} /> Prompt for your AI
      </div>
      <p className="hint" style={{ margin: '2px 0 6px' }}>
        Paste this to any AI agent so it knows what tangOS is and how to connect + start working.
      </p>
      <pre className="agent-prompt aero-scroll">{prompt || 'Loading…'}</pre>
      <button className="aero-button ghost" style={{ marginTop: 6 }} onClick={copyPrompt} disabled={!prompt}>
        {copied ? <Check size={14} style={{ verticalAlign: -2, marginRight: 5 }} /> : <Copy size={14} style={{ verticalAlign: -2, marginRight: 5 }} />}
        {copied ? 'Copied' : 'Copy prompt'}
      </button>

      <div className="section-title" style={{ marginTop: 14 }}>Connected agents · {clients.length}</div>
      {clients.length === 0 ? (
        <p className="notice" style={{ marginTop: 0 }}>No AI connected yet. Add the URL to your AI and it&apos;ll appear here — designate each one a role to give it standing instructions via next_batch.</p>
      ) : (
        <div className="agent-list">
          {clients.map((c) => (
            <div className="agent-row" key={c.id}>
              <span className="agent-dot" style={{ background: aiColor(c.name) }} />
              <span className="agent-name">{c.name}</span>
              <select
                className="agent-role"
                value={c.role}
                onChange={(e) => window.tangos.setClientRole(c.id, e.target.value)}
                title="Designate this agent's role — sets standing instructions injected into its next_batch"
              >
                {ROLE_NAMES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

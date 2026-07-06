import { useEffect, useState } from 'react'
import { KeyRound, Trash2, Plus, ShieldCheck, ShieldAlert } from 'lucide-react'
import type { SecretsInfo } from '../../../shared/types'

/** Manage the secure API-key vault: keys stored encrypted (OS DPAPI) and injected
 *  into every tool run as env vars — for repos whose tools call an HTTP API. */
export default function KeyVault(): JSX.Element {
  const [info, setInfo] = useState<SecretsInfo | null>(null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    window.tangos.secretsInfo().then(setInfo)
  }, [])

  const stored = new Set((info?.secrets ?? []).map((s) => s.name))
  const missing = (info?.declared ?? []).filter((d) => !stored.has(d))
  const available = info?.available ?? false
  const activeHelp = info?.help?.[name.trim()]

  async function save(preset?: string): Promise<void> {
    const key = (preset ?? name).trim()
    if (!key) {
      setErr('Enter a key name')
      return
    }
    if (!value.trim()) {
      setErr('Enter a value')
      return
    }
    setBusy(true)
    setErr('')
    try {
      setInfo(await window.tangos.setSecret(key, value))
      setName('')
      setValue('')
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(n: string): Promise<void> {
    setInfo(await window.tangos.deleteSecret(n))
  }

  return (
    <div className="inner-pad">
      <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>API keys</h2>
      <p className="hint" style={{ marginBottom: 10 }}>
        For tools that reach a service over HTTP instead of MCP. Stored encrypted by your OS keychain
        (Windows DPAPI) and passed to each tool run as an environment variable. Values never leave this
        machine and are never shown back in full.
      </p>

      {info && !available && (
        <p className="notice" style={{ color: 'var(--aero-danger)' }}>
          <ShieldAlert size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          OS secure storage is unavailable, so keys can&apos;t be stored safely here.
        </p>
      )}

      {info && available && (
        <div className="kv" style={{ marginBottom: 8 }}>
          <span className="k">
            <ShieldCheck size={12} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--aero-matched)' }} />
            Encrypted at rest
          </span>
          <span className="v">{info.secrets.length} stored</span>
        </div>
      )}

      {(info?.secrets.length ?? 0) > 0 && (
        <div className="agent-list" style={{ marginBottom: 8 }}>
          {info!.secrets.map((s) => (
            <div className="agent-row" key={s.name}>
              <KeyRound size={13} style={{ opacity: 0.7, flex: 'none' }} />
              <span className="agent-name mono" style={{ fontSize: 12 }}>{s.name}</span>
              <span className="mono" style={{ opacity: 0.55, fontSize: 12 }}>{s.hint}</span>
              <button className="icon-btn" title={`Remove ${s.name}`} onClick={() => remove(s.name)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <>
          <div className="section-title">This repo&apos;s tools expect</div>
          <div className="pill-row" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
            {missing.map((d) => (
              <button
                key={d}
                className="aero-button ghost"
                style={{ fontSize: 12, padding: '5px 10px' }}
                title={`Fill in ${d}`}
                onClick={() => setName(d)}
              >
                <Plus size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                {d}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="section-title">Add / update a key</div>
      <input
        className="vault-input mono"
        placeholder="ENV_VAR_NAME"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={!available}
      />
      {activeHelp && (
        <p className="hint" style={{ margin: '5px 2px 0', fontSize: 11.5, lineHeight: 1.45 }}>
          {activeHelp.note}{' '}
          {activeHelp.url && (
            <a
              style={{ cursor: 'pointer', color: 'var(--aero-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}
              onClick={() => window.tangos.openExternal(activeHelp.url!)}
            >
              Create one ↗
            </a>
          )}
        </p>
      )}
      <input
        className="vault-input mono"
        type="password"
        placeholder="value — paste your key"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={!available}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
        }}
      />
      {err && (
        <p className="notice" style={{ color: 'var(--aero-danger)', marginTop: 6 }}>
          {err}
        </p>
      )}
      <div className="pill-row" style={{ marginTop: 8 }}>
        <button className="aero-button" onClick={() => save()} disabled={busy || !available}>
          <Plus size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
          Save key
        </button>
      </div>
    </div>
  )
}

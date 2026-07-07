import { useEffect, useState } from 'react'
import { KeyRound, Trash2, Plus, ShieldCheck, ShieldAlert, Check, X } from 'lucide-react'
import type { SecretsInfo } from '../../../shared/types'

/** The secure API-key vault: keys stored encrypted (OS DPAPI) and injected into every
 *  tool run as env vars. Add a key by clicking its provider chip and pasting the value;
 *  to change one, delete it and add again. */
export default function KeyVault(): JSX.Element {
  const [info, setInfo] = useState<SecretsInfo | null>(null)
  const [adding, setAdding] = useState<string | null>(null) // which declared key is being entered
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    window.tangos.secretsInfo().then(setInfo)
  }, [])

  const stored = new Set((info?.secrets ?? []).map((s) => s.name))
  const missing = (info?.declared ?? []).filter((d) => !stored.has(d))
  const available = info?.available ?? false
  const help = adding ? info?.help?.[adding] : undefined

  function begin(name: string): void {
    setAdding(name)
    setValue('')
    setErr('')
  }
  function cancel(): void {
    setAdding(null)
    setValue('')
    setErr('')
  }
  async function save(): Promise<void> {
    if (!adding) return
    if (!value.trim()) {
      setErr('Paste a value')
      return
    }
    setBusy(true)
    setErr('')
    try {
      setInfo(await window.tangos.setSecret(adding, value.trim()))
      cancel()
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
    <div className="vault">
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
          <div className="pill-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {missing.map((d) => (
              <button
                key={d}
                className={`aero-button ghost${adding === d ? ' active' : ''}`}
                style={{ fontSize: 12, padding: '5px 10px' }}
                title={`Add ${d}`}
                onClick={() => begin(d)}
              >
                <Plus size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                {d}
              </button>
            ))}
          </div>
        </>
      )}

      {adding && (
        <div className="vault-add">
          <div className="section-title" style={{ marginTop: 10 }}>{adding}</div>
          {help && (
            <p className="hint" style={{ margin: '2px 0 6px', fontSize: 11.5, lineHeight: 1.45 }}>
              {help.note}{' '}
              {help.url && (
                <a
                  style={{ cursor: 'pointer', color: 'var(--aero-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}
                  onClick={() => window.tangos.openExternal(help.url!)}
                >
                  Create one ↗
                </a>
              )}
            </p>
          )}
          <input
            className="vault-input mono"
            type="password"
            placeholder="paste your key"
            value={value}
            autoFocus
            disabled={!available}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') cancel()
            }}
          />
          {err && (
            <p className="notice" style={{ color: 'var(--aero-danger)', marginTop: 6 }}>
              {err}
            </p>
          )}
          <div className="pill-row" style={{ marginTop: 8 }}>
            <button className="aero-button" onClick={save} disabled={busy || !available}>
              <Check size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
              Save
            </button>
            <button className="aero-button ghost" onClick={cancel}>
              <X size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

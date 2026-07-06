import { useState } from 'react'
import { Play, ShieldAlert, Lock, X } from 'lucide-react'
import type { TangosTool, TangosArg } from '../../../shared/types'

export function previewArgv(tool: TangosTool, values: Record<string, unknown>, python: string, apply: boolean): string {
  const flags: string[] = []
  for (const a of tool.args ?? []) {
    const v = values[a.name]
    if (v === undefined || v === null || v === '') continue
    if (a.type === 'boolean') {
      if (v === true && a.flag) flags.push(a.flag)
      continue
    }
    const s = String(v)
    if (a.positional || !a.flag) flags.push(s)
    else flags.push(a.flag, s)
  }
  if (tool.apply && apply) flags.push(tool.apply)
  const out: string[] = []
  for (const tok of tool.command.trim().split(/\s+/)) {
    if (tok === '{flags}') out.push(...flags)
    else if (tok === '{python}') out.push(python)
    else if (tok.startsWith('{') && tok.endsWith('}')) {
      const v = values[tok.slice(1, -1)]
      if (v !== undefined && v !== null && v !== '') out.push(String(v))
    } else out.push(tok)
  }
  return out.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ')
}

function Field({ arg, value, onChange }: { arg: TangosArg; value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  if (arg.type === 'boolean') {
    return (
      <div className="field checkbox">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <label>
          {arg.name}
          {arg.description ? <span className="desc"> — {arg.description}</span> : null}
        </label>
      </div>
    )
  }
  if (arg.type === 'enum' && Array.isArray(arg.choices)) {
    return (
      <div className="field">
        <label>{arg.name}{arg.required ? ' *' : ''}</label>
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {arg.choices.map((c) => (
            <option key={String(c)} value={String(c)}>{String(c)}</option>
          ))}
        </select>
        {arg.description ? <span className="desc">{arg.description}</span> : null}
      </div>
    )
  }
  const numeric = arg.type === 'integer' || arg.type === 'number'
  return (
    <div className="field">
      <label>{arg.name}{arg.required ? ' *' : ''}</label>
      <input
        type={numeric ? 'number' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={arg.default !== undefined ? String(arg.default) : ''}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') return onChange(undefined)
          onChange(numeric ? Number(raw) : raw)
        }}
      />
      {arg.description ? <span className="desc">{arg.description}</span> : null}
    </div>
  )
}

export default function RunDock({
  tool,
  python,
  allowMutations,
  onClose
}: {
  tool: TangosTool
  python: string
  allowMutations: boolean
  onClose: () => void
}): JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [apply, setApply] = useState(false)
  const [running, setRunning] = useState(false)

  const mutating = !tool.readOnly
  const blockedByPolicy = mutating && !allowMutations

  async function run(): Promise<void> {
    setRunning(true)
    try {
      await window.tangos.runTool(tool.id, { ...values, ...(tool.apply ? { apply } : {}) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="run-dock aero-panel">
      <div className="dock-head">
        <span className={`aero-badge ${tool.readOnly ? 'ro' : 'mutating'}`}>{tool.readOnly ? 'read' : 'writes'}</span>
        <h3>{tool.label ?? tool.id}</h3>
        <button className="dock-close" onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </div>
      <div className="dock-body aero-scroll">
        <p className="hint" style={{ marginTop: 0 }}>{tool.description}</p>
        <div className="run-form">
          {(tool.args ?? []).map((a) => (
            <Field key={a.name} arg={a} value={values[a.name]} onChange={(v) => setValues((p) => ({ ...p, [a.name]: v }))} />
          ))}

          {tool.apply && (
            <div className="field checkbox">
              <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
              <label>
                <ShieldAlert size={13} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--aero-danger)' }} />
                apply — actually mutate ({tool.apply}). Off = dry run.
              </label>
            </div>
          )}

          <div className="section-title">Command</div>
          <div className="cmd-preview">{previewArgv(tool, values, python, apply)}</div>

          {blockedByPolicy && (
            <div className="errbox">
              <Lock size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              Writes are off. Flip the Writes switch in the top bar to run this.
            </div>
          )}

          <button className={`aero-button${mutating ? ' danger' : ''}`} onClick={run} disabled={running || blockedByPolicy}>
            <Play size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {running ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  )
}

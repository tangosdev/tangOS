import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, isAbsolute } from 'node:path'
import { activityBus } from './activityBus'
import type { TangosTool, TangosRuntime, RunStatus, RunResult } from '../shared/types'

export interface RunOptions {
  tool: TangosTool
  values: Record<string, unknown> // declared arg values, plus optional synthetic `apply` boolean
  runtime: TangosRuntime
  repoPath: string
  source: 'ai' | 'user'
  client?: { name: string; role?: string }
  allowMutations: boolean
  extraEnv?: Record<string, string> // decrypted vault keys merged into the child env
}

/** Render the argv for a tool from its declared args + supplied values. */
export function renderArgv(
  tool: TangosTool,
  values: Record<string, unknown>,
  runtime: TangosRuntime,
  allowApply: boolean
): { argv: string[]; mutating: boolean } {
  const python = runtime.python || 'python'
  const flags: string[] = []

  for (const a of tool.args ?? []) {
    const v = values[a.name]
    if (v === undefined || v === null || v === '') continue
    if (a.type === 'boolean') {
      if ((v === true || v === 'true') && a.flag) flags.push(a.flag)
      continue
    }
    const sval = String(v)
    if (a.positional || !a.flag) flags.push(sval)
    else flags.push(a.flag, sval)
  }

  if (tool.apply && allowApply) flags.push(tool.apply)

  // Expand the command template token-by-token so {flags} becomes multiple argv items.
  const baseTokens = tool.command.trim().split(/\s+/)
  const argv: string[] = []
  for (const tok of baseTokens) {
    if (tok === '{flags}') {
      argv.push(...flags)
    } else if (tok === '{python}') {
      argv.push(python)
    } else if (tok.startsWith('{') && tok.endsWith('}')) {
      const name = tok.slice(1, -1)
      const v = values[name]
      if (v !== undefined && v !== null && v !== '') argv.push(String(v))
    } else {
      argv.push(tok)
    }
  }
  return { argv, mutating: !tool.readOnly }
}

export function previewCommand(
  tool: TangosTool,
  values: Record<string, unknown>,
  runtime: TangosRuntime,
  allowApply: boolean
): string {
  const { argv } = renderArgv(tool, values, runtime, allowApply)
  return argv.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ')
}

export function runTool(opts: RunOptions): Promise<RunResult> {
  const { tool, values, runtime, repoPath, source, allowMutations, client } = opts
  const runId = randomUUID()
  const mutating = !tool.readOnly
  const allowApply = !!tool.apply && values.apply === true
  const commandPreview = previewCommand(tool, values, runtime, allowApply)
  const startedAt = Date.now()

  // Safety gate: refuse mutating tools when mutations are disabled.
  if (mutating && !allowMutations) {
    const note = `Blocked: "${tool.id}" mutates repo state and mutations are currently disabled in tangOS.`
    activityBus.publish({
      kind: 'run-started',
      run: {
        runId, toolId: tool.id, label: tool.label || tool.id, readOnly: tool.readOnly, mutating,
        args: sanitizeArgs(values), commandPreview, source, client, startedAt, status: 'blocked', output: note + '\n', note
      }
    })
    activityBus.publish({ kind: 'run-finished', runId, status: 'blocked', exitCode: null, finishedAt: Date.now() })
    return Promise.resolve({ runId, status: 'blocked', exitCode: null, output: note })
  }

  const { argv } = renderArgv(tool, values, runtime, allowApply)
  const cwdRel = runtime.cwd || '.'
  const cwd = isAbsolute(cwdRel) ? cwdRel : join(repoPath, cwdRel)

  activityBus.publish({
    kind: 'run-started',
    run: {
      runId, toolId: tool.id, label: tool.label || tool.id, readOnly: tool.readOnly, mutating,
      args: sanitizeArgs(values), commandPreview, source, client, startedAt, status: 'running', output: ''
    }
  })

  return new Promise<RunResult>((resolve) => {
    let acc = ''
    const push = (chunk: string, stream: 'stdout' | 'stderr') => {
      acc += chunk
      activityBus.publish({ kind: 'run-output', runId, chunk, stream })
    }

    const env = opts.extraEnv ? { ...process.env, ...opts.extraEnv } : process.env
    let child
    try {
      if (runtime.shell) {
        const cmd = argv.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ')
        child = spawn(cmd, { cwd, env, shell: true })
      } else {
        child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false })
      }
    } catch (e) {
      const msg = `failed to spawn: ${(e as Error).message}\n`
      push(msg, 'stderr')
      activityBus.publish({ kind: 'run-finished', runId, status: 'error', exitCode: null, finishedAt: Date.now() })
      resolve({ runId, status: 'error', exitCode: null, output: acc })
      return
    }

    child.stdout?.on('data', (d) => push(d.toString(), 'stdout'))
    child.stderr?.on('data', (d) => push(d.toString(), 'stderr'))
    child.on('error', (e) => push(`process error: ${e.message}\n`, 'stderr'))
    child.on('close', (code) => {
      const status: RunStatus = code === 0 ? 'ok' : 'error'
      activityBus.publish({ kind: 'run-finished', runId, status, exitCode: code, finishedAt: Date.now() })
      resolve({ runId, status, exitCode: code, output: acc })
    })
  })
}

function sanitizeArgs(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
}

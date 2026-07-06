// A small secure vault for API keys, for repos whose tools reach a service over an
// HTTP API (e.g. an LLM refine step) instead of talking to tangOS over MCP.
//
// Keys are encrypted at rest with Electron's safeStorage, which is backed by the OS
// keychain — on Windows that is DPAPI, tied to the logged-in user account. The raw
// value never leaves the main process: the renderer only ever sees the key NAME and a
// last-4 hint. At tool-run time the decrypted values are merged into the child
// process env, so a tool can read e.g. process.env.GLM_API_KEY exactly as it would
// from a shell.
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretMeta } from '../shared/types'

interface StoredSecret {
  enc: string // base64 of safeStorage-encrypted bytes
  hint: string
  updatedAt: number
}
type Store = Record<string, StoredSecret>

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function file(): string {
  return join(app.getPath('userData'), 'tangos-secrets.json')
}

function load(): Store {
  try {
    if (!existsSync(file())) return {}
    return JSON.parse(readFileSync(file(), 'utf8')) as Store
  } catch {
    return {}
  }
}

function save(s: Store): void {
  writeFileSync(file(), JSON.stringify(s, null, 2), { mode: 0o600 })
}

function hintFor(value: string): string {
  const t = value.trim()
  if (t.length <= 4) return '••••'
  return '…' + t.slice(-4)
}

/** True when the OS provides real encryption. If false, we refuse to store keys. */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function listSecrets(): SecretMeta[] {
  const s = load()
  return Object.entries(s)
    .map(([name, v]) => ({ name, hint: v.hint, updatedAt: v.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function setSecret(name: string, value: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error('key name must be an env-var style identifier (letters, digits, underscore)')
  }
  if (!value || !value.trim()) throw new Error('value is empty')
  if (!encryptionAvailable()) {
    throw new Error('OS secure storage is unavailable — refusing to store an API key in plaintext')
  }
  const s = load()
  s[name] = {
    enc: safeStorage.encryptString(value).toString('base64'),
    hint: hintFor(value),
    updatedAt: Date.now()
  }
  save(s)
}

export function deleteSecret(name: string): void {
  const s = load()
  if (name in s) {
    delete s[name]
    save(s)
  }
}

/** Decrypt every stored key into a name->value map for injection into a tool's env. */
export function secretsEnv(): Record<string, string> {
  if (!encryptionAvailable()) return {}
  const s = load()
  const out: Record<string, string> = {}
  for (const [name, rec] of Object.entries(s)) {
    try {
      out[name] = safeStorage.decryptString(Buffer.from(rec.enc, 'base64'))
    } catch {
      /* skip keys we can't decrypt (e.g. copied from another machine/user) */
    }
  }
  return out
}

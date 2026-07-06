import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SERVER_KEY = 'tangos'

export function claudeCodeConfigPath(): string {
  return join(homedir(), '.claude.json')
}

export function claudeDesktopConfigPath(): string {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'Claude', 'claude_desktop_config.json')
}

export function cliCommand(url: string): string {
  return `claude mcp add --transport http ${SERVER_KEY} ${url}`
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

export interface RegisterOutcome {
  target: string
  path: string
  action: 'added' | 'updated' | 'unchanged' | 'error'
  message?: string
}

/** Claude Code (~/.claude.json) speaks native Streamable HTTP: { type: "http", url }. */
export function registerClaudeCode(url: string): RegisterOutcome {
  const path = claudeCodeConfigPath()
  try {
    const cfg = readJson(path)
    const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>
    const existed = SERVER_KEY in servers
    const prev = JSON.stringify(servers[SERVER_KEY] ?? null)
    servers[SERVER_KEY] = { type: 'http', url }
    if (existed && JSON.stringify(servers[SERVER_KEY]) === prev) {
      return { target: 'Claude Code', path, action: 'unchanged' }
    }
    writeJson(path, cfg)
    return { target: 'Claude Code', path, action: existed ? 'updated' : 'added' }
  } catch (e) {
    return { target: 'Claude Code', path, action: 'error', message: (e as Error).message }
  }
}

/**
 * Claude Desktop's config traditionally launches stdio servers. To reach our local
 * HTTP endpoint we register the `mcp-remote` proxy (npx), which bridges stdio<->HTTP.
 */
export function registerClaudeDesktop(url: string): RegisterOutcome {
  const path = claudeDesktopConfigPath()
  try {
    const cfg = readJson(path)
    const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>
    const existed = SERVER_KEY in servers
    const prev = JSON.stringify(servers[SERVER_KEY] ?? null)
    servers[SERVER_KEY] = { command: 'npx', args: ['-y', 'mcp-remote', url] }
    if (existed && JSON.stringify(servers[SERVER_KEY]) === prev) {
      return { target: 'Claude Desktop', path, action: 'unchanged' }
    }
    writeJson(path, cfg)
    return { target: 'Claude Desktop', path, action: existed ? 'updated' : 'added' }
  } catch (e) {
    return { target: 'Claude Desktop', path, action: 'error', message: (e as Error).message }
  }
}

export function registerAll(url: string): RegisterOutcome[] {
  return [registerClaudeCode(url), registerClaudeDesktop(url)]
}

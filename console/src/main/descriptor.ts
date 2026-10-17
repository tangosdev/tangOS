import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TangosDescriptor } from '../shared/types'

export const DESCRIPTOR_FILENAME = 'tangos.json'

const ARG_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'enum'])
const ID_RE = /^[a-z0-9_]+$/
// The jobs Console can hand to a repo's own tools; see TangosConsoleRoles.
const CONSOLE_ROLES = new Set([
  'scheduler',
  'refineScheduler',
  'randomScheduler',
  'enrich',
  'driver',
  'land',
  'logAttempt',
  'verify',
  'unitScheduler',
  'unitVerify',
  'unitPromote',
  'unitReview'
])
const WORK_UNITS = new Set(['function', 'class', 'tu'])
const LANGUAGE_MODES = new Set(['c', 'cpp', 'mixed'])
const GATE_WHEN = new Set(['pre-push', 'pre-pr', 'pre-merge'])
const TIER_KEYS = new Set(['converted', 'linked', 'units'])

export function descriptorPathFor(repoPath: string): string {
  return join(repoPath, DESCRIPTOR_FILENAME)
}

export function hasDescriptor(repoPath: string): boolean {
  return existsSync(descriptorPathFor(repoPath))
}

/**
 * Structural validation of a parsed descriptor. Returns a list of human-readable
 * problems (empty = valid). Intentionally lenient about unknown extra keys.
 */
export function validateDescriptor(desc: unknown): string[] {
  const errs: string[] = []
  if (typeof desc !== 'object' || desc === null) return ['descriptor is not an object']
  const d = desc as Record<string, unknown>

  if (d.tangosVersion !== '1') errs.push('tangosVersion must be "1"')

  const project = d.project as Record<string, unknown> | undefined
  if (!project || typeof project !== 'object') errs.push('project is required')
  else {
    if (!project.name) errs.push('project.name is required')
    if (!project.title) errs.push('project.title is required')
    if (project.workUnit !== undefined && !WORK_UNITS.has(String(project.workUnit))) {
      errs.push('project.workUnit must be "function", "class" or "tu"')
    }
    if (project.languageMode !== undefined && !LANGUAGE_MODES.has(String(project.languageMode))) {
      errs.push('project.languageMode must be "c", "cpp" or "mixed"')
    }
    if (project.compilerPin !== undefined && (typeof project.compilerPin !== 'string' || !project.compilerPin.trim())) {
      errs.push('project.compilerPin must be a non-empty string')
    }
    if (project.gates !== undefined && !Array.isArray(project.gates)) errs.push('project.gates must be an array')
    if (project.pr !== undefined && (typeof project.pr !== 'object' || project.pr === null || Array.isArray(project.pr))) {
      errs.push('project.pr must be an object')
    }
  }
  const dataBlock = d.data as Record<string, unknown> | undefined
  if (dataBlock && dataBlock.tiers !== undefined) {
    const t = dataBlock.tiers
    if (typeof t !== 'object' || t === null || Array.isArray(t)) errs.push('data.tiers must be an object')
    else {
      for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
        if (!TIER_KEYS.has(k)) errs.push(`data.tiers: unknown key "${k}"`)
        else if (typeof v !== 'boolean') errs.push(`data.tiers.${k} must be a boolean`)
      }
    }
  }

  const cats = new Set<string>()
  if (Array.isArray(d.categories)) {
    for (const c of d.categories as Record<string, unknown>[]) {
      if (c && typeof c.id === 'string') cats.add(c.id)
    }
  }

  if (!Array.isArray(d.tools)) {
    errs.push('tools must be an array')
    return errs
  }

  const ids = new Set<string>()
  for (const t of d.tools as Record<string, unknown>[]) {
    const id = t.id
    if (typeof id !== 'string' || !id) {
      errs.push('a tool is missing an id')
      continue
    }
    if (ids.has(id)) errs.push(`duplicate tool id: ${id}`)
    ids.add(id)
    if (!ID_RE.test(id)) errs.push(`tool id must be snake_case: ${id}`)
    if (typeof t.readOnly !== 'boolean') errs.push(`tool ${id}: readOnly must be a boolean`)
    if (typeof t.command !== 'string' || !t.command) errs.push(`tool ${id}: command is required`)
    if (t.apply && t.readOnly) errs.push(`tool ${id}: has an apply flag but is marked readOnly`)
    if (t.previewFlag !== undefined && (typeof t.previewFlag !== 'string' || !t.previewFlag)) {
      errs.push(`tool ${id}: previewFlag must be a non-empty string`)
    }
    if (t.previewFlag && t.readOnly) errs.push(`tool ${id}: has a previewFlag but is marked readOnly`)
    if (t.previewFlag && t.apply) errs.push(`tool ${id}: declares both apply and previewFlag (pick one switch)`)
    if (t.successPattern !== undefined) {
      if (typeof t.successPattern !== 'string' || !t.successPattern) errs.push(`tool ${id}: successPattern must be a non-empty string`)
      else {
        try {
          new RegExp(t.successPattern)
        } catch {
          errs.push(`tool ${id}: successPattern is not a valid regular expression`)
        }
      }
    }
    if (typeof t.category === 'string' && t.category && cats.size > 0 && !cats.has(t.category)) {
      errs.push(`tool ${id}: references unknown category "${t.category}"`)
    }
    if (t.args !== undefined) {
      if (!Array.isArray(t.args)) errs.push(`tool ${id}: args must be an array`)
      else {
        for (const a of t.args as Record<string, unknown>[]) {
          if (typeof a.name !== 'string' || !a.name) errs.push(`tool ${id}: an arg is missing a name`)
          if (typeof a.type !== 'string' || !ARG_TYPES.has(a.type)) {
            errs.push(`tool ${id}: arg ${String(a.name)} has invalid type ${String(a.type)}`)
          }
        }
      }
    }
  }

  // Fields that name a tool: a typo is silent otherwise (the gate or the path helper just never runs).
  if (project && typeof project === 'object') {
    if (typeof project.srcPathTool === 'string' && !ids.has(project.srcPathTool)) {
      errs.push(`project.srcPathTool: no tool with id "${project.srcPathTool}"`)
    }
    if (Array.isArray(project.gates)) {
      for (const [i, g] of (project.gates as Record<string, unknown>[]).entries()) {
        if (!g || typeof g !== 'object' || typeof g.name !== 'string' || !g.name) {
          errs.push(`project.gates[${i}]: name is required`)
          continue
        }
        if (typeof g.tool !== 'string' || !ids.has(g.tool)) {
          errs.push(`project.gates[${i}] (${g.name}): no tool with id "${String(g.tool)}"`)
        }
        if (g.when !== undefined && !GATE_WHEN.has(String(g.when))) {
          errs.push(`project.gates[${i}] (${g.name}): when must be "pre-push", "pre-pr" or "pre-merge"`)
        }
      }
    }
  }

  // The console block maps Console's jobs onto this repo's tools. A typo here is silent otherwise:
  // the role just resolves to nothing and the feature quietly disappears, which reads as "the app
  // is broken" rather than "that id doesn't exist".
  if (d.console !== undefined) {
    if (typeof d.console !== 'object' || d.console === null || Array.isArray(d.console)) {
      errs.push('console must be an object')
    } else {
      for (const [role, toolId] of Object.entries(d.console as Record<string, unknown>)) {
        if (!CONSOLE_ROLES.has(role)) {
          errs.push(`console: unknown role "${role}"`)
        } else if (typeof toolId !== 'string' || !toolId) {
          errs.push(`console.${role}: must be a tool id`)
        } else if (!ids.has(toolId)) {
          errs.push(`console.${role}: no tool with id "${toolId}"`)
        }
      }
    }
  }
  return errs
}

export interface LoadResult {
  descriptor: TangosDescriptor | null
  descriptorPath: string | null
  errors: string[]
}

export function loadDescriptor(repoPath: string): LoadResult {
  const p = descriptorPathFor(repoPath)
  if (!existsSync(p)) {
    return { descriptor: null, descriptorPath: null, errors: [`no ${DESCRIPTOR_FILENAME} in ${repoPath}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    return { descriptor: null, descriptorPath: p, errors: [`failed to parse ${DESCRIPTOR_FILENAME}: ${(e as Error).message}`] }
  }
  const errors = validateDescriptor(parsed)
  // A descriptor with errors is still returned (so the UI can show + let the user fix it),
  // but callers should refuse to start the MCP server if errors are non-empty.
  return { descriptor: parsed as TangosDescriptor, descriptorPath: p, errors }
}

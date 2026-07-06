import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TangosDescriptor } from '../shared/types'

export const DESCRIPTOR_FILENAME = 'tangos.json'

const ARG_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'enum'])
const ID_RE = /^[a-z0-9_]+$/

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

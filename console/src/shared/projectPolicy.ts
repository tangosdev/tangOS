// What a project's descriptor lets the Console do, in one place.
//
// Two questions are answered here, both from tangos.json and nothing else:
//
//   1. Is the project local only? `project.localOnly: true` means the project never leaves this
//      machine. The Console then makes no network request about it: no fetch, pull, push or pull
//      request, no claims, live stream or hosted data, no GitHub lookup, and no API drive (a drive
//      sends the project's code to a model provider). Its name and paths also stay out of bug
//      reports and debug bundles.
//   2. What is one piece of work? `project.workUnit` says function (the default), class or tu. The
//      flows that land one function per file only make sense for the first.
//
// Everything here is pure (no Electron, no file access) so a script can check it.
import type { TangosDescriptor, TangosProject } from './types'

/** Descriptor fields that name a place on the network. A local-only project may declare none. */
export const LOCAL_ONLY_FORBIDDEN: ReadonlyArray<readonly [section: 'project' | 'data', key: string]> = [
  ['project', 'github'],
  ['project', 'githubClientId'],
  ['data', 'committedDbUrl'],
  ['data', 'claimsApi'],
  ['data', 'projectId'],
  ['data', 'liveApi'],
  ['data', 'claimsMdUrl']
]

/** Shown wherever a network feature is switched off for a local-only project. */
export const LOCAL_ONLY_REASON =
  'This project is local only (project.localOnly in its tangos.json). Console makes no network request for it, so fetching, pulling, pushing, pull requests and API drives are off. Tools still run on the files in this folder.'

function section(desc: unknown, name: string): Record<string, unknown> | undefined {
  if (typeof desc !== 'object' || desc === null) return undefined
  const s = (desc as Record<string, unknown>)[name]
  return typeof s === 'object' && s !== null && !Array.isArray(s) ? (s as Record<string, unknown>) : undefined
}

/** True when the descriptor asks to be local only. Fails closed: any value other than an absent
 *  field or a literal `false` counts, so a mistyped `"localOnly": "yes"` is still local only (and
 *  is reported as a validation error). */
export function isLocalOnly(desc: unknown): boolean {
  const v = section(desc, 'project')?.localOnly
  return v !== undefined && v !== null && v !== false
}

/** The network fields a local-only descriptor declares anyway, as dotted names. Empty when the
 *  descriptor is not local only. */
export function localOnlyConflicts(desc: unknown): string[] {
  if (!isLocalOnly(desc)) return []
  const out: string[] = []
  for (const [sec, key] of LOCAL_ONLY_FORBIDDEN) {
    const v = section(desc, sec)?.[key]
    if (v !== undefined && v !== null && v !== '') out.push(`${sec}.${key}`)
  }
  return out
}

/** A local-only descriptor with every network field removed; any other descriptor unchanged.
 *  Validation reports the conflicts, but a descriptor with errors is still loaded so the user can
 *  see and fix it, so the removal here is the actual guard: the rest of the app never sees an
 *  address to contact. The input is not modified. */
export function enforceLocalOnly<T>(desc: T): T {
  if (!isLocalOnly(desc)) return desc
  const d = { ...(desc as Record<string, unknown>) }
  for (const sec of ['project', 'data'] as const) {
    const s = section(desc, sec)
    if (!s) continue
    const copy = { ...s }
    for (const [fs, key] of LOCAL_ONLY_FORBIDDEN) if (fs === sec) delete copy[key]
    d[sec] = copy
  }
  return d as T
}

/** What one piece of work is in this project. Absent means a single function. */
export function workUnitOf(project: TangosProject | null | undefined): 'function' | 'class' | 'tu' {
  const u = project?.workUnit
  return u === 'class' || u === 'tu' ? u : 'function'
}

/** True when the one-function-per-file flows apply: sweeping loose single-function files into a
 *  harvest branch, auto-landing a matched function, and publishing them one file at a time. A
 *  project whose unit is a class or a whole translation unit builds files by its own rules, so
 *  those flows stay off for it. */
export function singleFunctionFlows(desc: TangosDescriptor | null | undefined): boolean {
  return workUnitOf(desc?.project) === 'function'
}

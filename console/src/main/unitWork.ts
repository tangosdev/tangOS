// Batches for a project whose unit of work is a class or a whole translation unit
// (project.workUnit "class" or "tu" in its tangos.json).
//
// The function-match flow hands an agent one function, a guessed src/<name> path and a ready call
// of the verify tool, and its guide talks about worklists, a near-miss DB and pull requests. None
// of that fits a project that builds whole files: a target there is a file holding every function
// in an address range, it is placed by the project's own path tool, and it only counts after the
// project's gates pass. So for such a project the batch is written from the descriptor instead:
// its unit scheduler picks the targets, and the guide lists the project's own read-first file,
// layout, gates, verify command and unit tools.
//
// Everything here is pure (no Electron, no file access) so a script can check it.
import type { BatchItem, TangosDescriptor, TangosTool } from '../shared/types'
import { isLocalOnly, roleToolOf, workUnitOf } from '../shared/projectPolicy'

/** True when batches are made of classes or whole files instead of single functions. */
export function unitBatches(desc: TangosDescriptor | null | undefined): boolean {
  return workUnitOf(desc?.project) !== 'function'
}

/** The word for one unit of this project, for messages. */
export function unitWord(desc: TangosDescriptor | null | undefined): string {
  return workUnitOf(desc?.project) === 'class' ? 'class' : 'translation unit'
}

const hex = (n: number, pad = 0): string => '0x' + n.toString(16).padStart(pad, '0')

/** The scheduler row fields a unit scheduler writes. `name` is the unit id the project's other
 *  tools take; `label` is a short human note (for example how many functions it holds). */
export interface UnitRow {
  name: string
  module?: string
  addr?: string
  size?: string
  label?: string
}

/** One scheduler row as a batch item, or null when the row has no usable name. */
export function unitItemFromRow(r: UnitRow): BatchItem | null {
  if (!r || typeof r.name !== 'string' || !r.name.trim()) return null
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v !== 'string' || !v.trim()) return undefined
    const n = parseInt(v, 16)
    return Number.isNaN(n) ? undefined : n
  }
  return {
    id: `gen-${r.name}`,
    ref: r.name,
    module: typeof r.module === 'string' && r.module ? r.module : undefined,
    addr: num(r.addr),
    size: num(r.size),
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : undefined
  }
}

/** The line a unit target gets in a next_batch reply. No source path is guessed and no ready
 *  single-function call is offered: where the file goes is the project's path tool's answer. */
export function unitTargetLine(item: BatchItem): string {
  const where: string[] = []
  if (item.module) where.push(`module ${item.module}`)
  if (item.addr != null) {
    where.push(
      item.size != null
        ? `${hex(item.addr, 8)} to ${hex(item.addr + item.size, 8)} (${hex(item.size)} bytes)`
        : `starts ${hex(item.addr, 8)}`
    )
  }
  const tail = [where.join(', '), item.label ?? ''].filter(Boolean).join('; ')
  return `- ${item.ref}${tail ? `  [${tail}]` : ''}`
}

/** The short prompt stored on a generated unit batch. */
export function unitBatchPrompt(desc: TangosDescriptor): string {
  const w = unitWord(desc)
  return (
    `Build these targets. Each one is a whole ${w}: one source file that holds every function in ` +
    `its range, not a single function. Work one target at a time and follow the unit guide in this ` +
    `reply. A target counts only when the project's own gates pass for the whole file.`
  )
}

export function unitBatchTitle(desc: TangosDescriptor, n: number): string {
  return `${workUnitOf(desc.project) === 'class' ? 'Class' : 'Unit'} batch (${n})`
}

const toolLine = (t: TangosTool | undefined, what: string): string | null => {
  if (!t) return null
  const req = (t.args ?? []).filter((a) => a.required).map((a) => a.name)
  return `- ${t.id}: ${what}${req.length ? ` Required args: ${req.join(', ')}.` : ''}`
}

/** The guide appended to a next_batch reply for a unit project. Built only from what the
 *  descriptor declares, so a project never reads about a tool or a flow it does not have. */
export function unitWorkGuide(desc: TangosDescriptor, opts: { allowNearMiss?: boolean } = {}): string {
  const p = desc.project
  const w = unitWord(desc)
  const tool = (id: string | undefined): TangosTool | undefined =>
    id ? desc.tools?.find((t) => t.id === id) : undefined
  const out: string[] = ['', '', `HOW TO WORK EACH TARGET (a target is a whole ${w})`]

  out.push(
    'This is a work turn, not a planning turn: the batch is your go-ahead. Take one target, finish ' +
      'it or say in one line why it is blocked, then take the next. On any tool error, read the ' +
      'message, fix the call and retry in the same turn.'
  )
  if (p.readFirst?.trim()) out.push(`Read first: ${p.readFirst.trim()}`)

  const layout = p.matchConventions?.srcLayout?.trim()
  const pathTool = tool(p.srcPathTool)
  if (layout || pathTool) {
    out.push('', 'WHERE THE FILE GOES')
    if (layout) out.push(layout)
    if (pathTool) {
      out.push(
        `Ask \`${pathTool.id}\` for the path of every new file. Never guess a path and never add a ` +
          'file that holds only part of a unit.'
      )
    }
  }

  const gates = (p.gates ?? []).filter((g) => g && g.name && g.tool)
  if (gates.length) {
    out.push('', 'GATES (all of them, in this order; a target is not done until the last one passes)')
    gates.forEach((g, i) => {
      const when = g.when ? ` [${g.when}]` : ''
      out.push(`${i + 1}. ${g.name}: tool \`${g.tool}\`${when}${g.description ? `. ${g.description}` : ''}`)
    })
  }
  if (p.verifyCommand?.trim()) out.push('', `Verify command: ${p.verifyCommand.trim()}`)

  const lines = [
    toolLine(roleToolOf(desc, 'verify'), 'checks one function of the file while you iterate. A pass here is not a finished target.'),
    toolLine(roleToolOf(desc, 'unitVerify'), `checks the whole ${w} and prints one verdict.`),
    toolLine(
      roleToolOf(desc, 'unitPromote'),
      `enrolls a verified ${w} into the build. It changes the repo, so it previews unless you confirm with apply.`
    ),
    toolLine(roleToolOf(desc, 'unitReview'), 'reviews the source of a finished unit.')
  ].filter((l): l is string => !!l)
  if (lines.length) out.push('', 'TOOLS FOR THIS', ...lines)

  out.push('', 'RULES')
  out.push(
    '- A byte transcription is not a match: an `asm { ... }` body of `dcd 0x...` words, or any raw ' +
      'dump of the disassembly, equals the ROM by construction and is rejected. Write real source.'
  )
  out.push(
    opts.allowNearMiss === false
      ? '- Near-miss drafts are OFF for this batch: do not open the near-miss store or call its tools. Work each target from scratch.'
      : "- Near-miss drafts are ON: a draft that compiles but does not match goes to the project's near-miss store, never into the source tree." +
          (p.nearMissNote ? ` ${p.nearMissNote}` : '')
  )
  out.push('- Stay in your lane: edit only the files of the targets above. Keep scratch files out of the repo.')
  if (isLocalOnly(desc)) {
    out.push(
      '- This project is local only. Do not push, do not open a pull request, and do not send its ' +
        'name, paths or contents to any service. Commit locally only if the project rules ask for it.'
    )
  } else if (p.matchConventions?.autoPr === false) {
    out.push('- Console opens no pull request for this project. Make small local commits and hand them to its integrator.')
  } else {
    out.push("- Do not push. Console opens no pull request for class or unit work; publishing is the project's own flow.")
  }
  out.push(
    '- End every working turn with one line: what you did, where the target stands, and the next ' +
      'action. When this batch is done, call `next_batch` again in the same turn.'
  )
  return out.join('\n')
}

/** The batch item a passing whole-unit check proves: the ref that equals one of the run's string
 *  arguments (the unit id, however the tool names that argument). */
export function unitRefInRun(refs: Iterable<string>, values: Record<string, unknown>): string | undefined {
  const given = new Set(
    Object.values(values)
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean)
  )
  for (const r of refs) if (given.has(r)) return r
  return undefined
}

/** The unit items a single-function run falls inside: same module (when both name one) and an
 *  address within the unit's range. Such a run means the unit is being worked, never that it is done. */
export function unitsContaining(items: BatchItem[], module: string | undefined, addr: number | undefined): BatchItem[] {
  if (addr == null || Number.isNaN(addr)) return []
  return items.filter(
    (it) =>
      it.addr != null &&
      it.size != null &&
      addr >= it.addr &&
      addr < it.addr + it.size &&
      (!module || !it.module || it.module === module)
  )
}

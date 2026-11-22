// Checks the batch flow for a project whose unit of work is a class or a whole translation unit
// (project.workUnit "class" or "tu"): the rows its unit scheduler writes, the target lines and the
// guide a next_batch reply carries, and which batch target a run ticks. Also checks that a project
// that declares no workUnit is still handed single functions. No network, no ROM, no Electron.
//
// Run: npx tsx scripts/verify-unitwork.mts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  unitBatchPrompt, unitBatchTitle, unitBatches, unitItemFromRow, unitRefInRun, unitTargetLine, unitWord,
  unitWorkGuide, unitsContaining
} from '../src/main/unitWork'
import type { BatchItem, TangosDescriptor, TangosProject, TangosTool } from '../src/shared/types'

let failures = 0
function ok(cond: boolean, msg: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

const tool = (id: string, extra: Partial<TangosTool> = {}): TangosTool => ({ id, readOnly: true, command: 'x', ...extra })
const TOOLS: TangosTool[] = [
  tool('check_one', { args: [{ name: 'c', type: 'string', required: true }, { name: 'func', type: 'string', required: true }] }),
  tool('check_unit', { args: [{ name: 'unit', type: 'string', required: true }], successPattern: 'UNIT VERDICT: ok' }),
  tool('enroll_unit', { readOnly: false, previewFlag: '--dry-run' }),
  tool('list_units', { args: [{ name: 'limit', type: 'number' }, { name: 'out', type: 'string' }] }),
  tool('where')
]
const mk = (project: Partial<TangosProject>, roles: TangosDescriptor['console'] = {}): TangosDescriptor =>
  ({ tangosVersion: '1', project: { name: 'x', title: 'X', ...project }, tools: TOOLS, console: roles } as TangosDescriptor)

const ROLES = { verify: 'check_one', unitScheduler: 'list_units', unitVerify: 'check_unit', unitPromote: 'enroll_unit' }
const tu = mk(
  {
    workUnit: 'tu',
    readFirst: 'RULES.md',
    srcPathTool: 'where',
    verifyCommand: 'python tools/all_gates.py',
    nearMissNote: 'Drafts live in the draft store.',
    gates: [
      { name: 'bytes', tool: 'check_one', when: 'pre-push', description: 'Bytes and destinations' },
      { name: 'link', tool: 'check_unit' },
      { name: 'build', tool: 'enroll_unit', when: 'pre-merge' }
    ],
    matchConventions: { srcLayout: 'src/<module>/<module>_<start>.cpp, one file per unit' }
  },
  ROLES
)

// ---- which projects get units --------------------------------------------------------------------
ok(!unitBatches(mk({})) && !unitBatches(mk({ workUnit: 'function' })), 'no workUnit, or function: single functions')
ok(unitBatches(tu) && unitBatches(mk({ workUnit: 'class' })), 'workUnit tu or class: units')
ok(!unitBatches(null) && !unitBatches(undefined), 'no descriptor: not a unit project')
ok(unitWord(tu) === 'translation unit' && unitWord(mk({ workUnit: 'class' })) === 'class', 'the unit word follows workUnit')

// ---- scheduler rows --------------------------------------------------------------------------------
const row = unitItemFromRow({ name: 'mod_02001000', module: 'mod', addr: '0x02001000', size: '0x340', label: '12 functions' })
ok(
  !!row && row.ref === 'mod_02001000' && row.id === 'gen-mod_02001000' && row.module === 'mod' &&
    row.addr === 0x02001000 && row.size === 0x340 && row.label === '12 functions',
  'a unit row becomes a batch item with its id, module, range and label'
)
ok(unitItemFromRow({ name: 'u' })?.addr === undefined && unitItemFromRow({ name: 'u' })?.label === undefined, 'a bare row is still an item')
ok(unitItemFromRow({ name: '' }) === null && unitItemFromRow({} as never) === null, 'a row without a name is dropped')
ok(unitItemFromRow({ name: 'u', addr: 'zz' })?.addr === undefined, 'an unreadable address is left out, not NaN')

// ---- target lines ------------------------------------------------------------------------------------
const line = unitTargetLine(row!)
ok(line.startsWith('- mod_02001000') && line.includes('module mod'), 'the target line names the unit and its module')
ok(line.includes('0x02001000 to 0x02001340') && line.includes('0x340 bytes'), 'the target line gives the address range')
ok(line.includes('12 functions'), 'the target line carries the scheduler label')
ok(!/src\//.test(line) && !line.includes('{') && !line.includes('->'), 'no guessed source path and no ready single-function call')
ok(unitTargetLine({ id: 'a', ref: 'only' }) === '- only', 'a target with nothing but a name is just the name')

// ---- prompt and title ------------------------------------------------------------------------------
ok(/whole translation unit/.test(unitBatchPrompt(tu)) && !/opcode similarity|near-miss DB|sibling/.test(unitBatchPrompt(tu)), 'the batch prompt is about whole units')
ok(unitBatchTitle(tu, 4) === 'Unit batch (4)' && unitBatchTitle(mk({ workUnit: 'class' }), 2) === 'Class batch (2)', 'the batch title names the unit kind')

// ---- the guide ---------------------------------------------------------------------------------------
const g = unitWorkGuide(tu)
ok(g.includes('a target is a whole translation unit'), 'the guide says what a target is')
ok(g.includes('Read first: RULES.md'), 'the guide points at the read-first file')
ok(g.includes('src/<module>/<module>_<start>.cpp, one file per unit') && g.includes('`where`'), 'the guide gives the layout and the path tool')
const iB = g.indexOf('1. bytes'), iL = g.indexOf('2. link'), iR = g.indexOf('3. build')
ok(iB > 0 && iL > iB && iR > iL, 'the gates are listed in the declared order')
ok(g.includes('tool `check_one` [pre-push]. Bytes and destinations') && g.includes('tool `enroll_unit` [pre-merge]'), 'each gate names its tool and when it applies')
ok(g.includes('Verify command: python tools/all_gates.py'), 'the guide gives the verify command')
ok(g.includes('- check_one:') && g.includes('Required args: c, func.'), 'the function check is offered with its required args')
ok(g.includes('- check_unit:') && g.includes('- enroll_unit:'), 'the unit check and the enroll tool are named')
ok(/A pass here is not a finished target/.test(g), 'a single-function pass is said not to finish a target')
ok(g.includes('Near-miss drafts are ON') && g.includes('Drafts live in the draft store.'), 'near-miss on: the store and the project note')
const gOff = unitWorkGuide(tu, { allowNearMiss: false })
ok(gOff.includes('Near-miss drafts are OFF') && !gOff.includes('Drafts live in the draft store.'), 'near-miss off: told to work from scratch')
ok(/byte transcription is not a match/i.test(g), 'the transcription rule is stated')
ok(g.includes('call `next_batch` again'), 'the guide ends on next_batch')
ok(!/worklist|coddog|CLAIMS\.md|per-agent PR|auto-collects|tubuild_verify|nearmiss\/db\.jsonl/.test(g), 'nothing from the one-function guide leaks in')
ok(g.includes('Console opens no pull request for class or unit work'), 'an ordinary unit project: no pull request from Console')
ok(unitWorkGuide(mk({ workUnit: 'tu', matchConventions: { autoPr: false } }, ROLES)).includes('hand them to its integrator'), 'autoPr false: hand over to the integrator')
const gLocal = unitWorkGuide(mk({ workUnit: 'tu', localOnly: true }, ROLES))
ok(/local only\. Do not push, do not open a pull request/.test(gLocal), 'a local-only project: never push, never a pull request')
const bare = unitWorkGuide(mk({ workUnit: 'class' }))
ok(!bare.includes('GATES') && !bare.includes('WHERE THE FILE GOES') && !bare.includes('Verify command'), 'a section the descriptor does not declare is left out')
ok(!bare.includes('check_unit') && !bare.includes('enroll_unit'), 'an undeclared unit role names no tool')

// ---- which target a run ticks ------------------------------------------------------------------------
const refs = ['mod_02001000', 'mod_02002000']
ok(unitRefInRun(refs, { unit: 'mod_02002000' }) === 'mod_02002000', 'a unit check names its target by argument value')
ok(unitRefInRun(refs, { id: ' mod_02001000 ', brief: true }) === 'mod_02001000', 'whatever the argument is called, spaces trimmed')
ok(unitRefInRun(refs, { unit: 'other', n: 3 }) === undefined, 'a run that names no open target ticks nothing')
const items: BatchItem[] = [
  { id: '1', ref: 'mod_02001000', module: 'mod', addr: 0x02001000, size: 0x340 },
  { id: '2', ref: 'other_02001000', module: 'other', addr: 0x02001000, size: 0x100 },
  { id: '3', ref: 'loose' }
]
const inside = (m: string | undefined, a: number | undefined): string => unitsContaining(items, m, a).map((i) => i.ref).join(',')
ok(inside('mod', 0x02001000) === 'mod_02001000' && inside('mod', 0x0200133c) === 'mod_02001000', 'a function inside a unit finds that unit (first and last word)')
ok(inside('mod', 0x02001340) === '' && inside('mod', 0x02000ffc) === '', 'the end address and the word before the start are outside')
ok(inside('other', 0x02001010) === 'other_02001000', 'the same address in another module finds the other unit')
ok(inside(undefined, 0x02001010) === 'mod_02001000,other_02001000', 'with no module given every unit holding the address is found')
ok(inside('mod', undefined) === '' && inside('mod', NaN) === '', 'no address: nothing')

// ---- the callers -----------------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(here, '..', 'src', 'main', p), 'utf8')
const index = read('index.ts')
const mcp = read('mcpServer.ts')
ok(/role: 'unitScheduler' as keyof TangosConsoleRoles/.test(index), 'batch generation asks the unit scheduler for a unit project')
ok(/if \(!units && items\.length < count && role !== 'Hard matcher'/.test(index), 'no random single-function top-up in a unit batch')
ok(/prompt: unitBatchPrompt\(state\.descriptor\)/.test(index) && /title: unitBatchTitle\(state\.descriptor, items\.length\)/.test(index), 'a unit batch gets the unit prompt and title')
ok(/if \(units && tool\.id === roleTool\('unitVerify'\)\?\.id\)/.test(index), 'afterRun scores the unit check for a unit project')
ok(/for \(const it of unitsContaining\(open, mod, parseHexish\(values\.addr\)\)\) markItemWorked\(it\.ref\)/.test(index), 'a function check inside a unit marks the unit worked, not done')
ok(/if \(!singleFunctionFlows\(state\.descriptor\)\)\s+return 'Auto-PR is off for this project/.test(index), 'the Push toggle is locked for a unit project')
ok(/if \(units\) return unitTargetLine\(i\)/.test(mcp), 'next_batch lists unit targets without a guessed call')
ok(/const guide = units\s+\? unitWorkGuide\(desc, \{ allowNearMiss: prefs\.allowNearMiss !== false \}\)/.test(mcp), 'next_batch sends the unit guide')
ok(/const loggingNote = units \? '' : matchConventionsGuide\(/.test(mcp), 'the one-function draft-source block is left out of a unit batch')

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)

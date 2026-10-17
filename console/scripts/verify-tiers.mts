// Checks the Console pieces behind the Atlas tier views and the optional descriptor fields that came
// with them: the new schema-backed fields in validateDescriptor, the previewFlag argv, the explicit
// compiler pin and language mode, the tier detection, the colour of a tile in each view and the By
// file layout. No network, no ROM, no Electron.
//
// Run: npx tsx scripts/verify-tiers.mts [path/to/a/real/chaos-db.json]
// With a real chaos-db it also checks the published columns end to end.
import { readFileSync } from 'node:fs'
import { validateDescriptor } from '../src/main/descriptor'
import { renderArgv } from '../src/main/runTool'
import { pinnedCompilerVersion } from '../src/main/preflight'
import { prefersCpp } from '../src/main/matchConventions'
import { tierSupport, tuKeyOf, tuLabel, tuMembers } from '../src/renderer/src/chaos/tiers'
import { buildWorld } from '../src/renderer/src/chaos/layout'
import { fnColor } from '../src/renderer/src/chaos/engine/render/classic'
import type { PaintView } from '../src/renderer/src/chaos/engine/render/classic'
import { classic } from '../src/renderer/src/chaos/themes/classic'
import type { AtlasDb, AtlasFunction, TangosDescriptor, TangosTool } from '../src/shared/types'

let failures = 0
function ok(cond: boolean, msg: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

// ---- descriptor fields -----------------------------------------------------------------------
const tool = (id: string, extra: Partial<TangosTool> = {}): TangosTool => ({
  id,
  readOnly: true,
  command: '{python} tools/x.py {flags}',
  ...extra
})
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tangosVersion: '1',
  project: { name: 'p', title: 'P' },
  tools: [tool('srcpath'), tool('tubuild_verify'), tool('promote', { readOnly: false, previewFlag: '--dry-run' })],
  ...over
})
const withProject = (p: Record<string, unknown>): Record<string, unknown> =>
  base({ project: { name: 'p', title: 'P', ...p } })

ok(validateDescriptor(base()).length === 0, 'a descriptor without any of the new fields is still valid')
ok(
  validateDescriptor(
    withProject({
      workUnit: 'tu',
      languageMode: 'cpp',
      compilerPin: '2004/b56',
      srcPathTool: 'srcpath',
      gates: [{ name: 'verify', tool: 'tubuild_verify', when: 'pre-pr' }, { name: 'srcpath', tool: 'srcpath' }],
      pr: { titleTemplate: '{classes}', bodyTemplate: 'proof' }
    })
  ).length === 0,
  'every new project field, used correctly, validates'
)
ok(validateDescriptor(withProject({ workUnit: 'file' })).some((e) => /workUnit/.test(e)), 'workUnit outside function/class/tu is rejected')
ok(validateDescriptor(withProject({ languageMode: 'rust' })).some((e) => /languageMode/.test(e)), 'languageMode outside c/cpp/mixed is rejected')
ok(validateDescriptor(withProject({ compilerPin: '  ' })).some((e) => /compilerPin/.test(e)), 'a blank compilerPin is rejected')
ok(validateDescriptor(withProject({ srcPathTool: 'nope' })).some((e) => /srcPathTool/.test(e)), 'srcPathTool naming no tool is rejected')
ok(
  validateDescriptor(withProject({ gates: [{ name: 'g', tool: 'nope' }] })).some((e) => /gates\[0\]/.test(e)),
  'a gate naming no tool is rejected'
)
ok(
  validateDescriptor(withProject({ gates: [{ name: 'g', tool: 'srcpath', when: 'never' }] })).some((e) => /when/.test(e)),
  'a gate with an unknown `when` is rejected'
)
ok(validateDescriptor(base({ data: { tiers: { converted: true, linked: false, units: true } } })).length === 0, 'data.tiers booleans validate')
ok(validateDescriptor(base({ data: { tiers: { converted: 'yes' } } })).some((e) => /data\.tiers\.converted/.test(e)), 'a non-boolean data.tiers value is rejected')
ok(validateDescriptor(base({ data: { tiers: { shiny: true } } })).some((e) => /unknown key/.test(e)), 'an unknown data.tiers key is rejected')
ok(
  validateDescriptor(base({ console: { unitScheduler: 'srcpath', unitVerify: 'tubuild_verify', unitPromote: 'promote' } })).length === 0,
  'the unit roles are accepted in console'
)
ok(validateDescriptor(base({ console: { unitReview: 'nope' } })).some((e) => /unitReview/.test(e)), 'a unit role naming no tool is rejected')
ok(
  validateDescriptor(base({ tools: [tool('a', { successPattern: '(' })] })).some((e) => /successPattern/.test(e)),
  'a successPattern that is not a regular expression is rejected'
)
ok(
  validateDescriptor(base({ tools: [tool('a', { successPattern: 'UNIT VERDICT: bytes=ok' })] })).length === 0,
  'a valid successPattern passes'
)
ok(
  validateDescriptor(base({ tools: [tool('a', { previewFlag: '--dry-run' })] })).some((e) => /readOnly/.test(e)),
  'a read-only tool cannot declare a previewFlag'
)
ok(
  validateDescriptor(base({ tools: [tool('a', { readOnly: false, previewFlag: '--p', apply: '--apply' })] })).some((e) => /both/.test(e)),
  'a tool cannot declare both apply and previewFlag'
)

// ---- previewFlag argv ------------------------------------------------------------------------
const promote = tool('promote', { readOnly: false, previewFlag: '--dry-run', command: '{python} tools/tu_promote.py {flags}' })
const preview = renderArgv(promote, {}, { python: 'python' }, false).argv
ok(preview.includes('--dry-run'), 'a previewFlag tool previews unless a real run is confirmed')
const real = renderArgv(promote, {}, { python: 'python' }, true).argv
ok(!real.includes('--dry-run'), 'a confirmed run drops the previewFlag')
const applyTool = tool('w', { readOnly: false, apply: '--apply', command: '{python} tools/w.py {flags}' })
ok(
  !renderArgv(applyTool, {}, { python: 'python' }, false).argv.includes('--apply') &&
    renderArgv(applyTool, {}, { python: 'python' }, true).argv.includes('--apply'),
  'an `apply` tool still behaves as before'
)

// ---- compiler pin and language mode ----------------------------------------------------------
const desc = (project: Record<string, unknown>, tools: TangosTool[] = []): TangosDescriptor =>
  ({ tangosVersion: '1', project: { name: 'p', title: 'P', ...project }, tools }) as TangosDescriptor
const matchTool = tool('match', { args: [{ name: 'version', type: 'string', default: '1.2/sp2p3' }] })
ok(pinnedCompilerVersion(desc({}, [matchTool])) === '1.2/sp2p3', 'without compilerPin the match tool default is still the pin')
ok(pinnedCompilerVersion(desc({ compilerPin: '2004/b56' }, [matchTool])) === '2004/b56', 'project.compilerPin wins over the match default')
ok(prefersCpp(desc({ language: 'C' }).project) === false, 'language C is plain C')
ok(prefersCpp(desc({ language: 'C++' }).project) === true, 'language C++ is class-first')
ok(prefersCpp(desc({ language: 'C', languageMode: 'cpp' }).project) === true, 'languageMode cpp overrides the text')
ok(prefersCpp(desc({ language: 'C++', languageMode: 'c' }).project) === false, 'languageMode c overrides the text')
ok(prefersCpp(desc({ language: 'C++', languageMode: 'mixed' }).project) === true, 'languageMode mixed reads the text')

// ---- tier detection, colours, layout ---------------------------------------------------------
const fn = (id: string, extra: Partial<AtlasFunction> = {}): AtlasFunction => ({
  id,
  module: 'arm9',
  name: id,
  addr: 0x02000000 + id.length,
  size: 0x20,
  matched: true,
  ...extra
})
const db = (functions: AtlasFunction[]): AtlasDb => ({
  stats: { totalFunctions: functions.length, matchedFunctions: functions.filter((f) => f.matched).length, totalBytes: 0, matchedBytes: 0, moduleCount: 1 },
  functions
})
const sample = db([
  fn('a1', { srcPath: 'src/a.cpp', converted: true, linked: true, class: 'A', tuId: 'arm9/A', tuState: 'promoted' }),
  fn('a2', { srcPath: 'src/a.cpp', linked: true, class: 'A', tuId: 'arm9/A', tuState: 'promoted' }),
  fn('b1', { srcPath: 'src/b.c' }),
  fn('u1', { matched: false })
])
const sup = tierSupport(sample)
ok(sup.converted && sup.linked && sup.units, 'tierSupport detects converted, linked and units from the records')
const plain = tierSupport(db([fn('x1', { srcPath: 'src/x.c' }), fn('x2', { srcPath: 'src/y.c' })]))
ok(!plain.converted && !plain.linked && !plain.units, 'a db without the columns offers no tier views and no By file')
ok(tierSupport(db([fn('x1', { srcPath: 'src/x.c' })]), { linked: true }).linked, 'a declared tier turns the view on before the data has it')
ok(!tierSupport(sample, { converted: false }).converted, 'a declared false turns a detected view off')
ok(tierSupport(db([fn('x1', { srcPath: 'src/x.c' }), fn('x2', { srcPath: 'src/x.c' })])).units, 'two functions in one file are enough for By file')
ok(tuKeyOf(fn('z', { tuId: 'arm9/Z' })) === 'arm9/Z' && tuKeyOf(fn('z')) === null, 'tuKeyOf falls back to tuId and is null with neither')
ok(tuLabel('src/game/actors/d_a_foo.cpp') === 'd_a_foo.cpp' && tuLabel('src\\x\\y.cpp') === 'y.cpp', 'tuLabel is the last path segment')
const members = tuMembers(sample)
ok(members.size === 1 && members.get('src/a.cpp')?.length === 2, 'tuMembers keeps only files with more than one function')

const view = (colorBy: PaintView['colorBy']): PaintView => ({
  theme: classic,
  colorBy,
  authorFilter: null,
  moduleFilter: null,
  showNearMiss: true
})
const c = classic.colors
const [a1, a2, b1, u1] = sample.functions
ok(fnColor(a1, view('status')) === c.matched && fnColor(a2, view('status')) === c.matched, 'Matched view is unchanged')
ok(fnColor(a1, view('converted')) === c.converted, 'Converted view: a converted function takes the converted colour')
ok(fnColor(a2, view('converted')) === c.pending, 'Converted view: matched but not converted is pale')
ok(fnColor(a2, view('linked')) === c.linked && fnColor(b1, view('linked')) === c.pending, 'Linked view follows `linked`')
ok(fnColor(u1, view('converted')) === c.unmatched, 'Converted view leaves an unmatched function its status colour')
ok(fnColor(fn('r', { noMatch: { bucket: 'asm-primitive', reason: 'x' } }), view('linked')) === c.noMatch, 'a needs-no-match function stays red in every view')

const world = buildWorld(sample, 800, 600, 'tu')
ok(world.mods.length === 3, 'By file makes one section per source file (a.cpp, b.c, and the unmatched function with no file)')
ok(world.mods.some((m) => m.module === 'src/a.cpp' && m.label === 'a.cpp'), 'a By file section is keyed by path and labelled by file name')
ok(world.fns.length === sample.functions.length, 'By file lays out every function exactly once')

// ---- a real published chaos-db ---------------------------------------------------------------
const realPath = process.argv[2]
if (realPath) {
  const real = JSON.parse(readFileSync(realPath, 'utf8')) as AtlasDb
  const s = tierSupport(real)
  ok(s.converted && s.linked && s.units, `real chaos-db: all three tier views are offered`)
  const conv = real.functions.filter((f) => f.converted).length
  const lnk = real.functions.filter((f) => f.linked).length
  console.log(`      converted ${conv}, linked ${lnk}, with class ${real.functions.filter((f) => f.class).length}, with tuId ${real.functions.filter((f) => f.tuId).length}`)
  ok(conv > 0 && lnk > 0, 'real chaos-db: both tier columns have records')
  ok(
    real.functions.every((f) => !f.converted || f.matched) && real.functions.every((f) => !f.linked || f.matched),
    'real chaos-db: only matched functions carry a tier flag'
  )
  const w = buildWorld(real, 1600, 1000, 'tu')
  const files = new Set(real.functions.map((f) => f.srcPath ?? f.tuId ?? 'no source'))
  ok(w.mods.length === files.size, `real chaos-db: By file has one section per file (${w.mods.length})`)
  ok(w.fns.length === real.functions.length, 'real chaos-db: By file lays out every function')
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)

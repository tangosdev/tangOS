// Checks the Console pieces that understand folded translation units and a class-first project:
// the source-file map, the ready-made verify call, the work guide wording, the PR lock and the
// pinned-compiler preflight. No network, no ROM, no Electron; temp dirs only.
//
// Run: npx tsx scripts/verify-unitfiles.mts [path/to/a/real/tangos.json] [path/to/a/real/chaos-db.json]
// With the two optional paths it also loads a real descriptor and a real atlas and checks them.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSrcFileIndex,
  classifySrcFile,
  fileOwnsFunction,
  singleFunctionOf
} from '../src/main/srcFiles'
import { verifyCallFor, workGuideFor } from '../src/main/mcpServer'
import { autoPrAllowed, prefersCpp, matchConventionsGuide } from '../src/main/matchConventions'
import { compilerPinStatus, pinnedCompilerVersion } from '../src/main/preflight'
import { validateDescriptor } from '../src/main/descriptor'
import type { AtlasDb, BatchItem, TangosDescriptor } from '../src/shared/types'

let failures = 0
function ok(cond: boolean, msg: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

const fn = (name: string, srcPath: string, extra: object = {}) => ({
  id: `arm9:${name}`, module: 'arm9', name, addr: 0x02000000, size: 0x20, matched: true, srcPath, ...extra
})
const db: AtlasDb = {
  stats: { totalFunctions: 5, matchedFunctions: 5, totalBytes: 0, matchedBytes: 0, moduleCount: 1 },
  functions: [
    fn('AngleDiff', 'src/AngleDiff.c'),
    fn('_ZN8dActor_c4DrawEv', 'src/runtime/actor/d_actor.cpp'),
    fn('_ZN8dActor_c6RenderEv', 'src/runtime/actor/d_actor.cpp'),
    fn('_ZN8dActor_c8BehaviorEv', 'src/runtime/actor/d_actor.cpp'),
    fn('Solo', 'src/game/actors/d_a_solo.cpp'),
    { ...fn('NoFile', ''), srcPath: undefined }
  ] as AtlasDb['functions']
}
const idx = buildSrcFileIndex(db)

// ---- the source-file map ---------------------------------------------------------------------
ok(classifySrcFile(idx, 'src/runtime/actor/d_actor.cpp').kind === 'unit', 'a file with three functions is a unit')
ok(classifySrcFile(idx, 'src\\runtime\\actor\\d_actor.cpp').kind === 'unit', 'backslash paths classify the same')
ok(classifySrcFile(idx, 'src/AngleDiff.c').kind === 'function', 'a one-function file is a function file')
ok(classifySrcFile(idx, 'src/game/actors/d_a_solo.cpp').kind === 'function', 'a bucketed single-function file is found by its real path, not its name')
ok(classifySrcFile(idx, 'src/never_heard_of_it.c').kind === 'unknown', 'a file the atlas does not know is unknown')
ok(classifySrcFile(null, 'src/AngleDiff.c').kind === 'unknown', 'no atlas at all is unknown, not a crash')
ok(fileOwnsFunction(idx, 'src/runtime/actor/d_actor.cpp', '_ZN8dActor_c6RenderEv'), 'a unit file owns each of its members')
ok(!fileOwnsFunction(idx, 'src/runtime/actor/d_actor.cpp', 'AngleDiff'), 'a unit file does not own a stranger')
ok(fileOwnsFunction(idx, 'src/arm9/Foo.c', 'Foo') && fileOwnsFunction(null, 'src/Foo.cpp', 'Foo'), 'unknown files fall back to the basename rule')
ok(!fileOwnsFunction(null, 'src/Foo.cpp', 'Bar'), 'the basename rule still refuses a different name')
const su = singleFunctionOf(idx, 'src/runtime/actor/d_actor.cpp')
ok(su.kind === 'unit' && 'members' in su && su.members.length === 3, 'singleFunctionOf reports a unit with its members')
const sf = singleFunctionOf(idx, 'src/game/actors/d_a_solo.cpp')
ok(sf.kind === 'function' && 'name' in sf && sf.name === 'Solo', 'singleFunctionOf names the function behind a bucketed file')
const sk = singleFunctionOf(idx, 'src/arm9/Bar.c')
ok(sk.kind === 'unknown' && 'name' in sk && sk.name === 'Bar', 'singleFunctionOf falls back to the basename')

// ---- project policy --------------------------------------------------------------------------
const baseProject = { name: 'x', title: 'X' }
ok(autoPrAllowed(baseProject), 'no matchConventions: auto-PR stays allowed (old flow)')
ok(autoPrAllowed({ ...baseProject, matchConventions: { attemptTree: true } }), 'matchConventions without autoPr: allowed')
ok(!autoPrAllowed({ ...baseProject, matchConventions: { autoPr: false } }), 'autoPr false: not allowed')
ok(prefersCpp({ ...baseProject, language: 'C++ (real classes)' }), 'a C++ language descriptor is class-first')
ok(!prefersCpp({ ...baseProject, language: 'C' }) && !prefersCpp(baseProject), 'a C or silent descriptor keeps the C wording')

// ---- ready-made verify call -------------------------------------------------------------------
const matchTool = (def: string | undefined) => ({
  id: 'match', readOnly: true, command: 'x',
  args: [{ name: 'version', type: 'string' as const, ...(def ? { default: def } : {}) }]
})
const mk = (language: string, def: string | undefined, extraTools: string[] = []): TangosDescriptor => ({
  tangosVersion: '1',
  project: { name: 'x', title: 'X', language },
  tools: [matchTool(def), ...extraTools.map((id) => ({ id, readOnly: true, command: 'x' }))]
} as TangosDescriptor)
const item = (ref: string): BatchItem => ({ ref, addr: 0x02000000, size: 0x20, module: 'arm9' } as BatchItem)
const parse = (s: string | null): Record<string, unknown> => JSON.parse((s ?? '{}').split('   (')[0])

const d = mk('C++ (class form)', '2004/b56', ['tubuild_verify', 'srcpath'])
const unitCall = verifyCallFor(item('_ZN8dActor_c4DrawEv'), d, idx)
ok(parse(unitCall).version === '2004/b56', 'the ready call carries the descriptor default compiler (2004/b56)')
ok(parse(unitCall).c === 'src/runtime/actor/d_actor.cpp', 'the ready call points at the unit file the atlas names')
ok(/translation unit.*tubuild_verify/.test(unitCall ?? ''), 'a unit member is told to prove the whole unit')
const soloCall = verifyCallFor(item('Solo'), d, idx)
ok(parse(soloCall).c === 'src/game/actors/d_a_solo.cpp' && !/translation unit/.test(soloCall ?? ''), 'a bucketed single function gets its real path and no unit note')
const newCall = verifyCallFor(item('BrandNew'), d, idx)
ok(parse(newCall).c === 'src/BrandNew.cpp' && /srcpath/.test(newCall ?? ''), 'an unknown function in a class-first repo guesses .cpp and points at srcpath')
const oldCall = verifyCallFor(item('Plain'), mk('C', '1.2/sp2p3'), null)
ok(parse(oldCall).c === 'src/Plain.c' && parse(oldCall).version === '1.2/sp2p3' && !/srcpath/.test(oldCall ?? ''), 'a plain-C descriptor is unchanged (.c, its own version, no srcpath note)')
ok(parse(verifyCallFor(item('_ZN1A1fEv'), mk('C', undefined), null)).c === 'src/_ZN1A1fEv.cpp', 'a mangled name is still C++ in a C repo')

// ---- work guide ------------------------------------------------------------------------------
const gOld = workGuideFor('Claude', true)
ok(/write C,/.test(gOld) && /opens a per-agent PR/.test(gOld) && !/Class-first/.test(gOld), 'default guide is the old text for a project that says nothing')
ok(!/@\w+@/.test(gOld), 'no template token leaks into the default guide')
const gNew = workGuideFor('Claude', true, { cpp: true, autoPr: false, unitTools: true })
ok(/write C\+\+,/.test(gNew) && /Write real C\+\+/.test(gNew), 'class-first guide says C++')
ok(!/opens a per-agent PR/.test(gNew) && /integrator/.test(gNew), 'autoPr off: no per-agent PR promise, the integrator is named')
ok(/\n11\. Class-first C\+\+/.test(gNew) && gNew.indexOf('Class-first') < gNew.indexOf('Fallback if native MCP'), 'class step is added as item 11 before the fallback paragraph')
const gGrok = workGuideFor('Grok', true, { cpp: true, autoPr: false, unitTools: true })
ok(/\n10\. Class-first C\+\+/.test(gGrok) && !/opens your PR/.test(gGrok) && !/@\w+@/.test(gGrok), 'the Grok profile gets the same treatment (numbered after its 9 items)')
ok(workGuideFor('Claude', false) === '', 'no match tool: no guide')
ok(!/Class-first/.test(workGuideFor('Claude', true, { cpp: true, unitTools: false })), 'no unit tools: the class step is not shown')

const conv = matchConventionsGuide({ ...mk('C++', '2004/b56'), project: { name: 'x', title: 'X', language: 'C++' } } as TangosDescriptor, 1)
ok(/real C\+\+ or bank/.test(conv), 'the draft-source policy says real C++ for a class-first repo')

// ---- pinned compiler preflight -----------------------------------------------------------------
const repo = mkdtempSync(join(tmpdir(), 'tangos-pin-'))
try {
  const desc = { ...mk('C++', '2004/b56'), requirements: { compiler: 'mwccarm' } } as TangosDescriptor
  ok(pinnedCompilerVersion(desc) === '2004/b56', 'the pin is the match tool version default')
  ok(compilerPinStatus(repo, desc) === null, 'no tools/mwccarm folder: nothing to check (PATH or another layout)')
  mkdirSync(join(repo, 'tools', 'mwccarm', '1.2', 'sp2p3'), { recursive: true })
  writeFileSync(join(repo, 'tools', 'mwccarm', '1.2', 'sp2p3', 'mwccarm.exe'), '')
  const miss = compilerPinStatus(repo, desc)
  ok(!!miss && !miss.ok && miss.installed.join(',') === '1.2/sp2p3', 'only the 1.2 build present: the pin is reported missing, installed list names 1.2/sp2p3')
  mkdirSync(join(repo, 'tools', 'mwccarm', '2004', 'b56'), { recursive: true })
  writeFileSync(join(repo, 'tools', 'mwccarm', '2004', 'b56', 'mwccarm.exe'), '')
  const have = compilerPinStatus(repo, desc)
  ok(!!have && have.ok && have.installed.includes('2004/b56'), 'with 2004/b56 installed the pin passes')
  ok(compilerPinStatus(repo, { ...desc, tools: [{ id: 'match', readOnly: true, command: 'x', args: [{ name: 'version', type: 'string' }] }] } as TangosDescriptor) === null,
    'a descriptor with no version default (PictoChat style) skips the pin check')
} finally {
  rmSync(repo, { recursive: true, force: true })
}

// ---- optional: a real descriptor and a real atlas -------------------------------------------------
const [descPath, dbPath] = process.argv.slice(2)
if (descPath) {
  const real = JSON.parse(readFileSync(descPath, 'utf8')) as TangosDescriptor
  const errs = validateDescriptor(real)
  ok(errs.length === 0, `real descriptor passes Console's own validator${errs.length ? ': ' + errs.join('; ') : ''}`)
  ok(pinnedCompilerVersion(real) === '2004/b56', 'real descriptor: default compiler is 2004/b56')
  ok(prefersCpp(real.project), 'real descriptor: class-first')
  ok(!autoPrAllowed(real.project), 'real descriptor: auto-PR locked')
  const ids = new Set(real.tools.map((t) => t.id))
  for (const need of ['srcpath', 'tubuild_verify', 'tu_promote_plan', 'mangle', 'rtti_extract', 'match', 'prepush_linkcheck', 'port_refcheck', 'tiers']) {
    ok(ids.has(need), `real descriptor lists the ${need} tool`)
  }
  const mutating = real.tools.filter((t) => !t.readOnly).map((t) => t.id)
  console.log('      mutating tools in the real descriptor:', mutating.join(', '))
  ok(!real.tools.some((t) => t.id.startsWith('tu_promote') && !t.readOnly), 'no tool applies tu_promote')
}
if (dbPath) {
  const real = JSON.parse(readFileSync(dbPath, 'utf8')) as AtlasDb
  const ridx = buildSrcFileIndex(real)
  const units = [...ridx.byFile.values()].filter((m) => m.length > 1).length
  ok(units > 100, `real atlas: ${units} multi-function unit files found`)
  const first = [...ridx.byFile.entries()].find(([, m]) => m.length > 1)!
  ok(classifySrcFile(ridx, first[0]).kind === 'unit', `real atlas: ${first[0]} classifies as a unit`)
  ok(!!real.stats.tiers && typeof real.stats.tiers.converted === 'number', 'real atlas: stats.tiers is present')
  if (real.stats.tiers) console.log('      tiers:', JSON.stringify(real.stats.tiers))
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)

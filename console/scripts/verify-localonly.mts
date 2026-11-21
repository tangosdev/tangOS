// Checks the local-only project rule (src/shared/projectPolicy.ts): a descriptor that says
// `project.localOnly: true` names no place on the network, the validator and the schema both say
// so, and the loader removes any such field before the rest of the app sees the descriptor.
// No network, no ROM, no Electron. Uses a throwaway folder under the system temp directory.
//
// Run: npx tsx scripts/verify-localonly.mts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  LOCAL_ONLY_FORBIDDEN,
  LOCAL_ONLY_REASON,
  enforceLocalOnly,
  isLocalOnly,
  localOnlyConflicts,
  singleFunctionFlows,
  workUnitOf
} from '../src/shared/projectPolicy'
import { loadDescriptor, validateDescriptor } from '../src/main/descriptor'
import type { TangosDescriptor } from '../src/shared/types'

let failures = 0
function ok(cond: boolean, msg: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// A small local-only descriptor, and the same one with every network field filled in.
const clean = {
  tangosVersion: '1',
  project: { name: 'local-example', title: 'Local example', localOnly: true, workUnit: 'tu' },
  data: { generate: '{python} tools/make_db.py --out {out}', dbPath: 'atlas-db.json' },
  tools: [{ id: 'check', label: 'Check', description: 'Runs the check.', readOnly: true, command: '{python} tools/check.py' }]
}
const loud = {
  ...clean,
  project: { ...clean.project, github: 'https://example.invalid/someone/repo', githubClientId: 'abc123' },
  data: {
    ...clean.data,
    committedDbUrl: 'https://example.invalid/db.json',
    claimsApi: 'https://example.invalid/api/claims',
    projectId: 'example',
    liveApi: 'wss://example.invalid/live',
    claimsMdUrl: 'https://example.invalid/CLAIMS.md'
  }
}
const ALL = LOCAL_ONLY_FORBIDDEN.map(([s, k]) => `${s}.${k}`)

// ---- reading the flag ------------------------------------------------------------------------
ok(isLocalOnly(clean), 'localOnly: true is local only')
ok(!isLocalOnly({ ...clean, project: { name: 'x', title: 'X' } }), 'an absent flag is not local only')
ok(!isLocalOnly({ ...clean, project: { ...clean.project, localOnly: false } }), 'localOnly: false is not local only')
ok(isLocalOnly({ ...clean, project: { ...clean.project, localOnly: 'yes' } }), 'a mistyped flag fails closed (still local only)')
ok(!isLocalOnly(null) && !isLocalOnly('text') && !isLocalOnly({}), 'something that is not a descriptor is not local only')

// ---- conflicts and removal -------------------------------------------------------------------
ok(same(localOnlyConflicts(clean), []), 'a clean local-only descriptor has no conflicts')
ok(same(localOnlyConflicts(loud), ALL), `every network field is reported (${ALL.join(', ')})`)
ok(
  same(localOnlyConflicts({ ...loud, project: { ...loud.project, localOnly: false } }), []),
  'the same fields are fine on a project that is not local only'
)
const before = JSON.stringify(loud)
const stripped = enforceLocalOnly(loud) as unknown as Record<string, Record<string, unknown>>
ok(JSON.stringify(loud) === before, 'removal does not modify the descriptor it was given')
ok(
  LOCAL_ONLY_FORBIDDEN.every(([s, k]) => !(k in stripped[s])),
  'after removal no network field is left'
)
ok(same(stripped, clean), 'after removal the descriptor equals the clean one (nothing else is touched)')
const shared = { ...loud, project: { ...loud.project, localOnly: false } }
ok(enforceLocalOnly(shared) === shared, 'a descriptor that is not local only is passed through untouched')
ok(!/https?:|wss?:|example\.invalid/.test(JSON.stringify(stripped)), 'no address survives anywhere in the result')

// ---- the validator ---------------------------------------------------------------------------
ok(same(validateDescriptor(clean), []), 'the validator accepts the clean local-only descriptor')
const errs = validateDescriptor(loud)
ok(
  ALL.every((f) => errs.some((e) => e.startsWith(`${f} is not allowed when project.localOnly is true`))) && errs.length === ALL.length,
  'the validator reports each network field of a local-only descriptor, and nothing else'
)
ok(
  validateDescriptor({ ...clean, project: { ...clean.project, localOnly: 'yes' } }).includes('project.localOnly must be true or false'),
  'the validator rejects a flag that is not a boolean'
)

// ---- the schema says the same ----------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, '..', '..', 'schema', 'tangos.schema.json'), 'utf8'))
const Ajv = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020
const check = new Ajv({ allErrors: true }).compile(schema)
ok(check(clean) === true, 'the schema accepts the clean local-only descriptor')
ok(check(loud) === false, 'the schema rejects a local-only descriptor that names a place on the network')
for (const [s, k] of LOCAL_ONLY_FORBIDDEN) {
  const one = JSON.parse(JSON.stringify(clean)) as Record<string, Record<string, unknown>>
  one[s][k] = (loud as unknown as Record<string, Record<string, unknown>>)[s][k]
  ok(check(one) === false, `the schema rejects local only plus ${s}.${k} on its own`)
}
ok(check(shared) === true, 'the schema accepts the same fields on a project that is not local only')

// ---- the loader ------------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'tangos-localonly-'))
try {
  writeFileSync(join(dir, 'tangos.json'), JSON.stringify(loud, null, 2))
  const res = loadDescriptor(dir)
  ok(res.errors.length === ALL.length, 'loading a conflicting local-only descriptor reports the conflicts')
  ok(same(res.descriptor, clean), 'and the descriptor it hands the app has the network fields removed')
  writeFileSync(join(dir, 'tangos.json'), JSON.stringify(shared, null, 2))
  ok(same(loadDescriptor(dir).descriptor, shared), 'a project that is not local only loads exactly as written')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ---- work unit -------------------------------------------------------------------------------
ok(workUnitOf(undefined) === 'function' && workUnitOf({ name: 'x', title: 'X' }) === 'function', 'no workUnit means a single function')
ok(workUnitOf({ name: 'x', title: 'X', workUnit: 'tu' }) === 'tu' && workUnitOf({ name: 'x', title: 'X', workUnit: 'class' }) === 'class', 'a declared class or tu unit is read back')
ok(singleFunctionFlows(null) && singleFunctionFlows(shared as unknown as TangosDescriptor) === false, 'the one-function-per-file flows apply only to a function unit')
ok(LOCAL_ONLY_REASON.length > 40 && !/—|–/.test(LOCAL_ONLY_REASON), 'the reason shown to the user is a plain sentence')

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)

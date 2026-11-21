// Checks the local-only project rule (src/shared/projectPolicy.ts): a descriptor that says
// `project.localOnly: true` names no place on the network, the validator and the schema both say
// so, and the loader removes any such field before the rest of the app sees the descriptor.
// It then checks the app side: the requests that depend on those fields stay silent, the list of
// places that can open a connection is the reviewed one, and every git or GitHub call in the main
// process sits behind the local-only check.
// No network, no ROM, no Electron. Uses a throwaway folder under the system temp directory.
//
// Run: npx tsx scripts/verify-localonly.mts
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { fetchLiveHolds } from '../src/main/claims'
import { connectAtlasLive, fetchAtlas, fetchCosmetics, fetchCounts, fetchProgress } from '../src/main/cosmetics'
import { githubCredits } from '../src/main/github'
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

// ---- the address-driven requests stay silent -------------------------------------------------
// These functions decide whether to contact a server from the descriptor fields alone. With the
// real fetch swapped for a counter, a local-only descriptor (as the loader hands it over) must
// produce no request at all, and the same descriptor with its fields left in must produce some:
// the second half proves the counter would have seen a request. Nothing here reaches a network.
const realFetch = globalThis.fetch
const seen: string[] = []
globalThis.fetch = (async (input: unknown) => {
  seen.push(String(input))
  throw new Error('offline (verify-localonly counts requests, it never sends one)')
}) as typeof fetch
type Fields = { project: { github?: string }; data: { claimsApi?: string; liveApi?: string; committedDbUrl?: string; projectId?: string; claimsMdUrl?: string } }
async function addressDriven(d: Fields): Promise<number> {
  seen.length = 0
  await fetchLiveHolds(d.data, d.data.committedDbUrl)
  await fetchAtlas(d.data.claimsApi, d.data.liveApi)
  await fetchCosmetics(d.data.claimsApi, d.data.liveApi)
  await fetchCounts(d.data.claimsApi, d.data.liveApi)
  await fetchProgress(d.data.claimsApi, d.data.liveApi)
  await githubCredits(d.project.github ?? '', undefined)
  const stop = connectAtlasLive(() => d.data.claimsApi, () => d.data.liveApi, () => {})
  await new Promise((r) => setTimeout(r, 60))
  stop()
  return seen.length
}
const quiet = await addressDriven(enforceLocalOnly(loud) as unknown as Fields)
ok(quiet === 0, `a local-only project makes no claims, atlas, cosmetics, counts, progress, credits or live-stream request (${quiet} seen)`)
const noisy = await addressDriven(loud as unknown as Fields)
ok(noisy >= 6, `control: with the fields left in, the same calls do reach for the network (${noisy} seen by the counter)`)
globalThis.fetch = realFetch

// ---- every place the app can reach the network is on the reviewed list -----------------------
// A count per file of the calls that open a connection. Adding one anywhere changes a count and
// fails here until someone decides what it does for a local-only project and updates the list.
// What each one does with a local-only project loaded:
//   claims.ts, cosmetics.ts   need data.claimsApi / liveApi / claimsMdUrl / committedDbUrl: removed by the loader
//   github.ts                 needs project.github: removed by the loader, and github:credits passes ''
//   githubAuth.ts             the user's own "Sign into GitHub": sends the OAuth client id, nothing about a project
//   pullRequests.ts           reached only from the push flows, all behind the Push lock or a refusal
//   gitsafe.ts                fetch and push helpers, every caller in index.ts is guarded (checked below)
//   index.ts fetch            live atlas file and atlas-file download (need data.committedDbUrl), a registered
//                             project's published descriptor and the public registry (neither mentions the open
//                             project), the local model server on localhost (drive only, and drives are refused)
//   index.ts git clone        a clone of an address the user typed or a registered project's address
//   index.ts openExternal     the GitHub sign-in page, and a link the user clicked
//   updater.ts                the app's own update check against its public releases, packaged builds only
const PRIMITIVES: Array<[label: string, re: RegExp]> = [
  ['fetch', /(?<![\w.])fetch\(/],
  ['git fetch', /\[\s*'fetch'/],
  ['git push', /\[\s*'push'/],
  ['git clone', /\[\s*'clone'/],
  ['git pull', /\[\s*'pull'/],
  ['git ls-remote', /'ls-remote'/],
  ['openExternal', /shell\.openExternal\(/],
  ['update check', /autoUpdater\.checkForUpdates\(/],
  ['socket', /new WebSocket|new EventSource|XMLHttpRequest|sendBeacon|https?\.(request|get)\(|net\.(request|fetch|connect)\(|tls\.connect\(/]
]
const REVIEWED: Record<string, Record<string, number>> = {
  'main/claims.ts': { fetch: 2 },
  'main/cosmetics.ts': { fetch: 5 },
  'main/github.ts': { fetch: 1 },
  'main/githubAuth.ts': { fetch: 2 },
  'main/gitsafe.ts': { 'git fetch': 3, 'git push': 1 },
  'main/index.ts': { fetch: 5, 'git clone': 2, openExternal: 2 },
  'main/pullRequests.ts': { fetch: 1 },
  'main/updater.ts': { 'update check': 2 }
}
const srcRoot = join(here, '..', 'src')
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
const codeLines = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
const found: Record<string, Record<string, number>> = {}
for (const file of sourceFiles(srcRoot)) {
  const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/')
  for (const line of codeLines(file)) {
    for (const [label, re] of PRIMITIVES) {
      if (re.test(line)) ((found[rel] ??= {})[label] = (found[rel][label] ?? 0) + 1)
    }
  }
}
// One line per file and kind, sorted, so the comparison does not depend on the order found.
const flat = (m: Record<string, Record<string, number>>): string[] =>
  Object.entries(m)
    .flatMap(([file, kinds]) => Object.entries(kinds).map(([kind, n]) => `${file} ${kind} x${n}`))
    .sort()
const listsAgree = same(flat(found), flat(REVIEWED))
ok(listsAgree, `the places that can open a connection are exactly the reviewed ones (${flat(found).length} kinds in ${Object.keys(found).length} files)`)
if (!listsAgree) {
  console.log('      found:    ' + JSON.stringify(found))
  console.log('      reviewed: ' + JSON.stringify(REVIEWED))
}
ok(!Object.keys(found).some((f) => f.startsWith('renderer/') || f.startsWith('preload/')), 'the window itself makes no request (renderer and preload have none)')
const html = readFileSync(join(srcRoot, 'renderer', 'index.html'), 'utf8')
ok(/connect-src 'self'/.test(html) && /default-src 'self'/.test(html), "the window's content policy allows connections to itself only")

// ---- every git and GitHub call in index.ts sits behind the local-only check ------------------
// For each call of a helper that fetches, pulls, pushes, opens a pull request or looks a repo up,
// the enclosing top-level function must ask localOnlyReason() (or autoPushActive(), which asks it
// through the Push lock) before the call.
const index = codeLines(join(srcRoot, 'main', 'index.ts'))
const TOP = /^(export )?(async )?function \w+|^ipcMain\.(handle|on)\(|^app\.\w+\(/
function enclosing(lineNo: number): { start: number; head: string } {
  let j = lineNo
  while (j > 0 && !TOP.test(index[j])) j--
  return { start: j, head: index[j].slice(0, 60) }
}
function guardedBefore(lineNo: number): boolean {
  const { start } = enclosing(lineNo)
  const body = index.slice(start, lineNo + 1).join('\n')
  return body.includes('localOnlyReason()') || body.includes('autoPushActive()')
}
function bodyOf(name: string): string {
  const start = index.findIndex((l) => new RegExp(`^(async )?function ${name}\\(`).test(l))
  if (start < 0) return ''
  let end = start + 1
  while (end < index.length && !/^}/.test(index[end])) end++
  return index.slice(start, end + 1).join('\n')
}
const GUARDED_HELPERS = [
  'fetchRemote', 'rebasePull', 'fetchBase', 'syncPreview', 'syncToOrigin',
  'pushSubsetToBranch', 'ensurePullRequest', 'getPushTarget', 'githubCredits', 'nemotronModelId'
]
let helperCalls = 0
for (const name of GUARDED_HELPERS) {
  const call = new RegExp(`(?<![\\w.])${name}\\(`)
  index.forEach((line, i) => {
    if (!call.test(line) || new RegExp(`function ${name}\\(`).test(line)) return
    helperCalls++
    if (!guardedBefore(i)) ok(false, `${name}() at index.ts:${i + 1} (${enclosing(i).head}) is not behind the local-only check`)
  })
}
ok(helperCalls >= 15, `all ${helperCalls} fetch, pull, push, pull-request, credits and local-model calls in index.ts are behind the local-only check`)
ok(bodyOf('autoPushActive').includes('autoPushLockedReason()'), 'auto-push is active only when the Push lock is free')
ok(bodyOf('autoPushLockedReason').includes('localOnlyReason()'), 'the Push lock is held for a local-only project')
ok(bodyOf('localOnlyReason').includes('isLocalOnly(state.descriptor)'), 'the check reads the open descriptor')
for (const fn of ['driveBatchInner', 'startDriveLoop', 'runStrandedSweep', 'startSweepCadence', 'surfacePriorHarvests']) {
  ok(bodyOf(fn).includes('localOnlyReason()'), `${fn} asks the local-only check`)
}
// The open descriptor only ever comes from the loader (which removes the network fields) or
// through enforceLocalOnly directly.
const assigns = index.filter((l) => /state\.descriptor = /.test(l)).map((l) => l.trim())
ok(
  assigns.length > 0 && assigns.every((l) => /= (descriptor|null|enforceLocalOnly\(remote\))$/.test(l)),
  `every assignment of the open descriptor is the loader's result, enforceLocalOnly(...) or null (${assigns.length} found)`
)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)

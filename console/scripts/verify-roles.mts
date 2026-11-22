// Checks how the Console finds a project's verify tool and how it scores a run of it:
// the role lookup (descriptor.console, else the historical ids), the pass rule (the tool's own
// successPattern, else the historical verdict line), the divergence parser, and the places that
// used to look for a tool literally called `match`. No network, no ROM, no Electron.
//
// Run: npx tsx scripts/verify-roles.mts
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { outputIsMatch, matchDivergence } from '../src/main/aiStats'
import { verifyCallFor } from '../src/main/mcpServer'
import { pinnedCompilerVersion } from '../src/main/preflight'
import { LEGACY_ROLE_IDS, roleToolOf } from '../src/shared/projectPolicy'
import type { BatchItem, TangosDescriptor, TangosTool } from '../src/shared/types'

let failures = 0
function ok(cond: boolean, msg: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

// ---- the pass rule -----------------------------------------------------------------------------
ok(outputIsMatch('x\nMATCHING VERSIONS: 1.2/sp2p3\n'), 'no pattern: the historical hit line passes')
ok(!outputIsMatch('x\nMATCHING VERSIONS: none\n'), 'no pattern: the historical miss line fails')
ok(outputIsMatch('MATCHING VERSIONS: 2004/b56', ''), 'an empty pattern is no pattern')
const PAT = String.raw`RESULT:\s*PASS\b`
ok(outputIsMatch('built ok\nRESULT: PASS\n', PAT), 'a declared pattern scores a run that prints it')
ok(!outputIsMatch('built ok\nRESULT: FAIL\n', PAT), 'a declared pattern fails a run that does not')
ok(!outputIsMatch('MATCHING VERSIONS: 1.2/sp2p3', PAT), 'with a pattern declared the historical line no longer counts')
ok(!outputIsMatch('MATCHING VERSIONS: 1.2/sp2p3\nRESULT: PASS', '(unclosed'), 'a pattern that does not compile scores nothing')
ok(!outputIsMatch('', PAT) && !outputIsMatch(undefined as unknown as string, PAT), 'empty output never passes')

// ---- the divergence parser -----------------------------------------------------------------------
ok(matchDivergence('  1.2: MISMATCH (3 word(s) differ)') === 3, 'N word(s) differ parses')
ok(matchDivergence('  1.2: MISMATCH (7 unit(s) differ)') === 7, 'N unit(s) differ parses')
ok(matchDivergence('divergences=12 then 4 unit(s) differ') === 4, 'the smallest reported diff wins')
ok(matchDivergence('no numbers here') === null, 'nothing to parse is null')

// ---- the role lookup -------------------------------------------------------------------------------
const tool = (id: string, extra: Partial<TangosTool> = {}): TangosTool => ({ id, readOnly: true, command: 'x', ...extra })
const desc = (tools: TangosTool[], roles?: TangosDescriptor['console']): TangosDescriptor =>
  ({ tangosVersion: '1', project: { name: 'x', title: 'X' }, tools, ...(roles ? { console: roles } : {}) } as TangosDescriptor)

ok(LEGACY_ROLE_IDS.verify === 'match' && LEGACY_ROLE_IDS.scheduler === 'coddog', 'the historical ids are unchanged')
ok(roleToolOf(desc([tool('match'), tool('other')]), 'verify')?.id === 'match', 'no console block: verify is the tool called match')
ok(roleToolOf(desc([tool('match'), tool('check_one')], { verify: 'check_one' }), 'verify')?.id === 'check_one', 'console.verify names the verify tool')
ok(roleToolOf(desc([tool('match')], { verify: 'gone' }), 'verify') === undefined, 'a declared id that names no tool does not fall back to match')
ok(roleToolOf(desc([tool('unit_list')]), 'unitScheduler') === undefined, 'a unit role resolves only when declared')
ok(roleToolOf(desc([tool('unit_list')], { unitScheduler: 'unit_list' }), 'unitScheduler')?.id === 'unit_list', 'a declared unit role resolves')
ok(roleToolOf(null, 'verify') === undefined && roleToolOf(desc([]), 'verify') === undefined, 'no descriptor or no tools: nothing')

// ---- callers that used to look for a tool literally called `match` ---------------------------------
const item = { ref: 'Thing', addr: 0x02000000, size: 0x20, module: 'arm9' } as BatchItem
const named = desc(
  [tool('check_one', { args: [{ name: 'version', type: 'string', default: '9.9/x' }] })],
  { verify: 'check_one' }
)
ok(verifyCallFor(item, named, null) !== null, 'the ready verify call is built for a verify tool with another name')
ok(verifyCallFor(item, desc([tool('other')]), null) === null, 'no verify tool: no ready call')
ok(pinnedCompilerVersion(named) === '9.9/x', 'the pinned build falls back to the verify tool version default')

const here = dirname(fileURLToPath(import.meta.url))
const mainDir = join(here, '..', 'src', 'main')
const literal = /\.id\s*[!=]==\s*'match'/
const hits = readdirSync(mainDir)
  .filter((f) => f.endsWith('.ts'))
  .flatMap((f) =>
    readFileSync(join(mainDir, f), 'utf8')
      .split(/\r?\n/)
      .map((line, i) => (literal.test(line) && !line.trim().startsWith('//') ? `${f}:${i + 1}` : ''))
      .filter(Boolean)
  )
ok(hits.length === 0, `no code in src/main compares a tool id with the literal 'match'${hits.length ? ': ' + hits.join(', ') : ''}`)
const index = readFileSync(join(mainDir, 'index.ts'), 'utf8')
ok(/if \(tool\.id !== roleTool\('verify'\)\?\.id\) return/.test(index), 'afterRun scores the verify role')
ok(/outputIsMatch\(res\.output, tool\.successPattern\)/.test(index), 'afterRun passes the tool pattern to the pass rule')
ok(/outputIsMatch\(res\.output, matchTool\.successPattern\)/.test(index), 'the sweep passes the tool pattern too')

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)

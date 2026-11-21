// Checks the model table (src/shared/models.ts): every box name that has shipped is still there
// under the same key, each box resolves to the driver settings it should, and the effort rules the
// dropdown and the driver use are the same. No network, no ROM, no Electron.
//
// Run: npx tsx scripts/verify-models.mts
import {
  MODEL_BOXES,
  EFFORT_CATALOG,
  REQUESTY_FREE_MODELS,
  boxesForKey,
  driveSettings,
  effortInForce,
  modelBox,
  modelLabel
} from '../src/shared/models'
import { familyOf, effortSpec, currentEffort } from '../src/renderer/src/efforts'
import { ROLE_FIT } from '../src/shared/types'

let failures = 0
function ok(cond: boolean, msg: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ---- shipped names keep their meaning --------------------------------------------------------
// Stored roles, efforts and stats are keyed by box name. This list only ever grows.
const SHIPPED: Record<string, string> = {
  Opus: 'ANTHROPIC_API_KEY',
  Fable: 'ANTHROPIC_API_KEY',
  Sonnet: 'ANTHROPIC_API_KEY',
  GLM: 'GLM_API_KEY',
  DeepSeek: 'DEEPSEEK_API_KEY',
  Grok: 'GROK_API_KEY',
  GPT: 'OPENAI_API_KEY',
  Nemotron: 'NEMOTRON_API_KEY',
  Requesty: 'REQUESTY_API_KEY',
  Kimi: 'MOONSHOT_API_KEY'
}
for (const [box, key] of Object.entries(SHIPPED)) {
  ok(modelBox(box)?.key === key, `${box} is still a box behind ${key}`)
}
ok(new Set(MODEL_BOXES.map((b) => b.box)).size === MODEL_BOXES.length, 'no box name appears twice')
ok(
  MODEL_BOXES.every((b) => EFFORT_CATALOG[b.family] !== undefined),
  'every box belongs to a family that has an effort dropdown'
)
ok(
  same(boxesForKey('ANTHROPIC_API_KEY'), ['Opus', 'Fable', 'Sonnet', 'Haiku']),
  'the Anthropic key backs one box per Claude model, the shipped three first'
)
ok(same(boxesForKey('NOT_A_KEY'), []), 'an unknown key backs no box')

// ---- Claude boxes ----------------------------------------------------------------------------
for (const box of ['Opus', 'Fable', 'Sonnet', 'Haiku']) {
  const d = driveSettings(box, undefined)
  ok(
    !!d && new RegExp(`^claude-${box.toLowerCase()}-\\d+-\\d+$`).test(d.model ?? ''),
    `${box} drives a ${box.toLowerCase()} model id (${d?.model})`
  )
  ok(d?.baseUrl === 'https://api.anthropic.com' && d?.dialect === undefined, `${box} uses the Anthropic endpoint and dialect`)
  ok(d?.effort === 'high', `${box} defaults to high effort when nothing is stored`)
  ok(driveSettings(box, 'max')?.effort === 'max', `${box} passes a stored effort through`)
  ok(driveSettings(box, 'bogus')?.effort === 'high', `${box} ignores a stored effort that is not an option`)
}
ok(modelLabel('Fable') === modelBox('Fable')!.label && modelLabel('Nobody') === 'Nobody', 'modelLabel falls back to the name')

// ---- the other boxes -------------------------------------------------------------------------
const glm = driveSettings('GLM', undefined)
ok(!!glm && glm.modelFrom === 'driver' && !glm.baseUrl && !glm.model && glm.effort === 'off', 'GLM leaves endpoint and model to the driver, effort off')

const ds = driveSettings('DeepSeek', undefined)
ok(ds?.dialect === 'openai' && ds?.effort === 'off', 'DeepSeek uses the OpenAI dialect with effort off')
ok(
  ds?.model === modelBox('DeepSeek')!.drive!.models!.reasoner,
  'DeepSeek with nothing stored drives the reasoner model (what the dropdown displays)'
)
ok(driveSettings('DeepSeek', 'chat')?.model === modelBox('DeepSeek')!.drive!.models!.chat, 'DeepSeek "chat" drives the chat model')

const nemo = driveSettings('Nemotron', undefined)
ok(
  nemo?.modelFrom === 'runtime' && nemo.model === undefined && nemo.keyFallback === 'lm-studio' && nemo.effort === 'off',
  'Nemotron asks the local server for its model and has a nominal key'
)

const rq = driveSettings('Requesty', undefined)
ok(rq?.model === REQUESTY_FREE_MODELS[0] && rq.effort === 'off', 'Requesty with nothing stored drives the default free model')
ok(driveSettings('Requesty', REQUESTY_FREE_MODELS[2])?.model === REQUESTY_FREE_MODELS[2], 'Requesty drives the model picked in the dropdown')
ok(
  driveSettings('Requesty', 'vendor/a-model-that-was-retired')?.model === REQUESTY_FREE_MODELS[0],
  'Requesty falls back to the default when the stored pick is no longer offered'
)

const gpt = driveSettings('GPT', undefined)
ok(gpt?.dialect === 'openai' && !!gpt.model && gpt.effort === 'high', 'GPT uses the OpenAI dialect and passes effort')
ok(driveSettings('GPT', 'minimal')?.effort === 'minimal', 'GPT passes a stored effort through')
ok(driveSettings('Kimi', undefined)?.effort === 'off' && !!driveSettings('Kimi', undefined)?.model, 'Kimi has a model and effort off')

ok(driveSettings('Grok', undefined) === null, 'Grok has a box but no console driver')
ok(driveSettings('SomeMcpClient', undefined) === null, 'an unknown name has no console driver')

// ---- the dropdown and the driver agree -------------------------------------------------------
for (const b of MODEL_BOXES) {
  const agent = { name: b.box, provider: b.box }
  ok(familyOf(agent) === b.family, `${b.box}: the dropdown resolves the same family as the table`)
  ok(
    currentEffort({ ...agent, effort: undefined }) === effortInForce(b.family, undefined) &&
      effortSpec(agent).options.includes(currentEffort({ ...agent, effort: undefined })),
    `${b.box}: the displayed default is the default the driver is given`
  )
}
ok(familyOf({ name: 'claude-code', provider: undefined }) === 'Claude', 'an MCP client named after Claude is in the Claude family')
ok(familyOf({ name: 'mystery', provider: undefined }) === 'default', 'an unrecognised MCP client gets the fallback dropdown')

// ---- role recommendations still recognise the names ------------------------------------------
const hard = ROLE_FIT['Hard matcher'].names!
ok(hard.test('fable') && hard.test('opus') && hard.test('gpt-5.6') && hard.test('gpt-6'), 'Hard matcher recognises the strongest models, including a GPT after 5')
ok(!hard.test('sonnet') && !hard.test('haiku') && !hard.test('gpt-4'), 'Hard matcher does not claim the mid and small models')
ok(ROLE_FIT['Hard matcher'].strength.includes(modelLabel('Fable')), 'the Hard matcher label names the current Fable')
ok(ROLE_FIT['Random'].strength.includes(modelLabel('Sonnet')), 'the Random label names the current Sonnet')

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)

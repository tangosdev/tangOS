// The one place that says which model sits behind each AI box.
//
// A box name (Opus, Fable, GLM, ...) is permanent: stored roles, effort picks, attempt limits and
// lifetime stats are all keyed by it, so a name that has shipped must keep meaning the same box.
// What CHANGES is the model behind the box. Moving a box to a newer model is a one-line edit of
// `model` and `label` in MODEL_BOXES below; nothing else in the app spells a model id.
//
// Last checked against each provider's published model list on 2026-11-21. Rows marked "not
// re-verified" were left as they were rather than guessed at.

export type Dialect = 'anthropic' | 'openai'

/** The choices in a box's effort dropdown. */
export interface EffortSpec {
  options: string[]
  default: string
  /** Shown in the dropdown's tooltip so people know what the knob is. */
  note?: string
}

/** Requesty models that cost nothing per token (checked against the router's public model list).
 *  The Requesty box's dropdown picks which one of these the single box runs. */
export const REQUESTY_FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-nano-30b-a3b',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nvidia/muse-glimmer-30b',
  'google/gemma-4-31b-it',
  'mistral/leanstral-1-5',
  'novita/ling-3.1-flash'
]

/** Effort dropdown per model family. These mirror the knob each provider actually exposes. */
export const EFFORT_CATALOG: Record<string, EffortSpec> = {
  Claude: { options: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high', note: 'Claude effort level' },
  GLM: {
    options: ['off'],
    default: 'off',
    note: 'thinking off: the refine driver emits code directly, and reasoning starves its token budget'
  },
  GPT: { options: ['minimal', 'low', 'medium', 'high'], default: 'high', note: 'reasoning_effort' },
  Grok: { options: ['low', 'high'], default: 'high', note: 'grok reasoning_effort' },
  DeepSeek: { options: ['chat', 'reasoner'], default: 'reasoner', note: 'picks the model: chat or reasoner' },
  Nemotron: {
    options: ['off'],
    default: 'off',
    note: 'local LM Studio (model nemo): reasons internally, the driver reads the answer'
  },
  // Requesty is a gateway; the "effort" box picks WHICH free model this single agent runs (one at
  // a time, not a fan-out: run together they share one key's quota and rate-limit each other).
  Requesty: {
    options: REQUESTY_FREE_MODELS,
    default: REQUESTY_FREE_MODELS[0],
    note: 'which free Requesty model to run'
  },
  Kimi: { options: ['off'], default: 'off', note: 'Moonshot Kimi: the driver reads the answer (OpenAI-compatible)' }
}

/** Used for a box whose family is not in the catalog (an MCP client we do not recognise). */
export const EFFORT_FALLBACK: EffortSpec = { options: ['low', 'medium', 'high'], default: 'medium' }

/** How the Console's own driver reaches a box's model. */
export interface DriveSpec {
  /** Provider endpoint. Absent = the driver's built-in default endpoint. */
  baseUrl?: string
  /** Wire format. Absent = the driver's default (Anthropic messages). */
  dialect?: Dialect
  /** The model id sent to the provider, when it is one fixed id. */
  model?: string
  /** Where the model id comes from when it is not one fixed id:
   *  'choice'  - `models[<dropdown value>]` (the dropdown picks between named models)
   *  'effort'  - the dropdown value IS the model id (a gateway box)
   *  'runtime' - asked from the local server when a drive starts
   *  'driver'  - left to the driver's own default */
  modelFrom?: 'choice' | 'effort' | 'runtime' | 'driver'
  /** For modelFrom 'choice': dropdown value -> model id. */
  models?: Record<string, string>
  /** What the driver is told about reasoning effort: 'box' = the dropdown value, 'off' = always off
   *  (the dropdown means something else for this box, or the model reasons on its own). */
  effort: 'box' | 'off'
  /** The stored key may be empty (a local server ignores it); this value is sent instead. */
  keyFallback?: string
}

export interface ModelBox {
  /** Box name. Permanent, see the note at the top of this file. */
  box: string
  /** Effort family, a key of EFFORT_CATALOG. */
  family: string
  /** The stored API key that makes the box appear. One key can back several boxes. */
  key: string
  /** What the box runs, in words, for tooltips and guides. */
  label: string
  /** Absent = the box appears (and can connect over MCP) but the Console cannot drive it. */
  drive?: DriveSpec
}

const ANTHROPIC = 'https://api.anthropic.com'

export const MODEL_BOXES: ModelBox[] = [
  // Claude: one Anthropic key, one box per model. Ids from Anthropic's models overview.
  // (Fable 5.1, `claude-fable-5-1`, is the previous Fable and is still served.)
  { box: 'Opus', family: 'Claude', key: 'ANTHROPIC_API_KEY', label: 'Opus 5.5', drive: { baseUrl: ANTHROPIC, model: 'claude-opus-5-5', effort: 'box' } },
  { box: 'Fable', family: 'Claude', key: 'ANTHROPIC_API_KEY', label: 'Fable 5.2', drive: { baseUrl: ANTHROPIC, model: 'claude-fable-5-2', effort: 'box' } },
  { box: 'Sonnet', family: 'Claude', key: 'ANTHROPIC_API_KEY', label: 'Sonnet 5.5', drive: { baseUrl: ANTHROPIC, model: 'claude-sonnet-5-5', effort: 'box' } },
  { box: 'Haiku', family: 'Claude', key: 'ANTHROPIC_API_KEY', label: 'Haiku 5.5', drive: { baseUrl: ANTHROPIC, model: 'claude-haiku-5-5', effort: 'box' } },
  // GLM: the driver's native provider, so endpoint, key and model are the driver's own defaults.
  { box: 'GLM', family: 'GLM', key: 'GLM_API_KEY', label: 'GLM', drive: { modelFrom: 'driver', effort: 'off' } },
  // DeepSeek: the dropdown picks the model. Not re-verified: DeepSeek announced both names for
  // retirement and now documents `deepseek-flash` and `deepseek-v4-pro`, but the driver sizes its
  // token budget from the word "reason" in the name, so the two sides must change together.
  {
    box: 'DeepSeek',
    family: 'DeepSeek',
    key: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    drive: {
      baseUrl: 'https://api.deepseek.com',
      dialect: 'openai',
      modelFrom: 'choice',
      models: { chat: 'deepseek-chat', reasoner: 'deepseek-reasoner' },
      effort: 'off'
    }
  },
  // Grok connects over MCP only; a stored key just makes its box appear.
  { box: 'Grok', family: 'Grok', key: 'GROK_API_KEY', label: 'Grok' },
  // 'GPT', not 'ChatGPT': MCP clients named gpt/codex/chatgpt fold to 'GPT', and a second name
  // would split one agent into two boxes. Not re-verified: OpenAI lists newer ids, but the driver
  // only sends reasoning effort to names starting "gpt-5" or "o1" to "o4".
  { box: 'GPT', family: 'GPT', key: 'OPENAI_API_KEY', label: 'GPT-5.6 Luna', drive: { baseUrl: 'https://api.openai.com/v1', dialect: 'openai', model: 'gpt-5.6-luna', effort: 'box' } },
  // Nemotron: a local LM Studio server. It ignores the key, so the stored value is only the box's
  // on/off switch, and the loaded model's id is asked from the server when a drive starts.
  {
    box: 'Nemotron',
    family: 'Nemotron',
    key: 'NEMOTRON_API_KEY',
    label: 'Nemotron (local)',
    drive: { baseUrl: 'http://localhost:1234/v1', dialect: 'openai', modelFrom: 'runtime', effort: 'off', keyFallback: 'lm-studio' }
  },
  // Requesty: one box that runs a single free gateway model, picked in the box's dropdown.
  {
    box: 'Requesty',
    family: 'Requesty',
    key: 'REQUESTY_API_KEY',
    label: 'Requesty (free models)',
    drive: { baseUrl: 'https://router.requesty.ai/v1', dialect: 'openai', modelFrom: 'effort', effort: 'off' }
  },
  // Kimi: Moonshot AI, OpenAI-compatible.
  { box: 'Kimi', family: 'Kimi', key: 'MOONSHOT_API_KEY', label: 'Kimi K3', drive: { baseUrl: 'https://api.moonshot.ai/v1', dialect: 'openai', model: 'kimi-k3', effort: 'off' } }
]

const BY_BOX = new Map(MODEL_BOXES.map((b) => [b.box, b]))

/** The table row for a box name, or undefined for a name the table does not know. */
export function modelBox(name: string): ModelBox | undefined {
  return BY_BOX.get(name)
}

/** What the box runs, in words ("Fable 5.2"). Falls back to the box name. */
export function modelLabel(name: string): string {
  return BY_BOX.get(name)?.label ?? name
}

/** Box names a stored key switches on, in table order. */
export function boxesForKey(key: string): string[] {
  return MODEL_BOXES.filter((b) => b.key === key).map((b) => b.box)
}

/** The effort in force for a box of this family: the stored pick when it is still one of the
 *  family's options, else the family default. A stored pick can go stale when an option is
 *  retired (a gateway model that no longer exists), so it is never passed through unchecked. */
export function effortInForce(family: string, stored: string | undefined): string {
  const spec = EFFORT_CATALOG[family] ?? EFFORT_FALLBACK
  return stored && spec.options.includes(stored) ? stored : spec.default
}

/** Everything the driver needs to be told for one box. `model` is undefined when the id is
 *  decided at run time ('runtime') or by the driver itself ('driver'). */
export interface DriveSettings {
  key: string
  keyFallback?: string
  baseUrl?: string
  dialect?: Dialect
  model?: string
  modelFrom: 'fixed' | 'choice' | 'effort' | 'runtime' | 'driver'
  /** The reasoning-effort value handed to the driver. */
  effort: string
}

/** Resolve a box name plus its stored dropdown pick into driver settings. Returns null for a box
 *  the Console cannot drive (unknown name, or a table row with no `drive`). */
export function driveSettings(name: string, storedEffort: string | undefined): DriveSettings | null {
  const row = BY_BOX.get(name)
  if (!row?.drive) return null
  const d = row.drive
  const pick = effortInForce(row.family, storedEffort)
  const modelFrom = d.modelFrom ?? 'fixed'
  let model: string | undefined
  if (modelFrom === 'fixed') model = d.model
  else if (modelFrom === 'choice') model = d.models?.[pick]
  else if (modelFrom === 'effort') model = pick
  return {
    key: row.key,
    keyFallback: d.keyFallback,
    baseUrl: d.baseUrl,
    dialect: d.dialect,
    model,
    modelFrom,
    effort: d.effort === 'box' ? pick : 'off'
  }
}

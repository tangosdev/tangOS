import type { AiAgent } from '../../shared/types'

// Reasoning-effort options per model family. These mirror the knob each provider actually exposes,
// so a box prefills to the right choices for whatever model is behind it:
//   Claude   - effort tiers (low..max), map to the extended-thinking budget
//   GLM      - GLM-4.6 hybrid reasoning is a toggle (thinking disabled/enabled)
//   GPT      - reasoning_effort: minimal | low | medium | high
//   Grok     - grok reasoning_effort (low | high); grok-4 reasons by default
//   DeepSeek - deepseek-chat (V3) vs deepseek-reasoner (R1)
export interface EffortSpec {
  options: string[]
  default: string
  note?: string // shown in the tooltip so people know what the knob is
}

const CATALOG: Record<string, EffortSpec> = {
  Claude: { options: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high', note: 'extended-thinking budget' },
  GLM: { options: ['off'], default: 'off', note: 'thinking off: the refine driver emits code directly, and reasoning starves its token budget' },
  GPT: { options: ['minimal', 'low', 'medium', 'high'], default: 'medium', note: 'reasoning_effort' },
  Grok: { options: ['low', 'high'], default: 'high', note: 'grok reasoning_effort' },
  DeepSeek: { options: ['chat', 'reasoner'], default: 'reasoner', note: 'V3 chat vs R1 reasoner' },
  Nemotron: { options: ['off'], default: 'off', note: 'local LM Studio (model nemo): reasons internally, the driver reads the answer' }
}

const FALLBACK: EffortSpec = { options: ['low', 'medium', 'high'], default: 'medium' }

/** Model family for an agent: its provider if we key it, else inferred from the name. */
export function familyOf(a: Pick<AiAgent, 'provider' | 'name'>): string {
  if (a.provider && CATALOG[a.provider]) return a.provider
  const n = (a.name || '').toLowerCase()
  if (/claude|opus|sonnet|haiku|fable/.test(n)) return 'Claude'
  if (/glm|zhipu/.test(n)) return 'GLM'
  if (/grok/.test(n)) return 'Grok'
  if (/deepseek/.test(n)) return 'DeepSeek'
  if (/nemotron|nemo/.test(n)) return 'Nemotron'
  if (/gpt|o1|o3|o4|chatgpt|openai/.test(n)) return 'GPT'
  return 'default'
}

/** Effort options + default for whatever model is behind this box. */
export function effortSpec(a: Pick<AiAgent, 'provider' | 'name'>): EffortSpec {
  return CATALOG[familyOf(a)] ?? FALLBACK
}

/** The effort currently in force for an agent: its saved choice if valid, else the family default. */
export function currentEffort(a: Pick<AiAgent, 'provider' | 'name' | 'effort'>): string {
  const spec = effortSpec(a)
  return a.effort && spec.options.includes(a.effort) ? a.effort : spec.default
}

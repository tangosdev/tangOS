import type { AiAgent } from '../../shared/types'
import { EFFORT_CATALOG, EFFORT_FALLBACK, effortInForce, modelBox, type EffortSpec } from '../../shared/models'

// Reasoning-effort options per model family. The catalog itself lives in shared/models.ts, next
// to the table of which model sits behind each box, so the main process (which hands the effort
// to the driver) and this dropdown read the same list.
export type { EffortSpec }

/** Model family for an agent: its row in the model table if it has one, else inferred from the name. */
export function familyOf(a: Pick<AiAgent, 'provider' | 'name'>): string {
  const row = modelBox(a.provider ?? '') ?? modelBox(a.name ?? '')
  if (row) return row.family
  const n = (a.name || '').toLowerCase()
  if (/claude|opus|sonnet|haiku|fable/.test(n)) return 'Claude'
  if (/glm|zhipu/.test(n)) return 'GLM'
  if (/grok/.test(n)) return 'Grok'
  if (/deepseek/.test(n)) return 'DeepSeek'
  if (/nemotron|nemo/.test(n)) return 'Nemotron'
  if (/kimi|moonshot/.test(n)) return 'Kimi'
  if (/gpt|o1|o3|o4|chatgpt|openai/.test(n)) return 'GPT'
  return 'default'
}

/** Effort options + default for whatever model is behind this box. */
export function effortSpec(a: Pick<AiAgent, 'provider' | 'name'>): EffortSpec {
  return EFFORT_CATALOG[familyOf(a)] ?? EFFORT_FALLBACK
}

/** The effort currently in force for an agent: its saved choice if valid, else the family default. */
export function currentEffort(a: Pick<AiAgent, 'provider' | 'name' | 'effort'>): string {
  return effortInForce(familyOf(a), a.effort)
}

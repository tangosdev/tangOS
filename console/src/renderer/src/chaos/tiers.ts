import type { AtlasDb, AtlasFunction } from '../../../shared/types'

/** Which tier views the loaded atlas can offer. */
export interface TierSupport {
  /** records carry `converted` (or the descriptor says they will) */
  converted: boolean
  /** records carry `linked` */
  linked: boolean
  /** at least one source file holds several functions, so grouping and outlining by file means something */
  units: boolean
}

/** What the descriptor's data.tiers declares. A declared value wins over detection, so a project can
 *  switch a view on before its first record carries the column, or hide one it does not want shown. */
export interface DeclaredTiers {
  converted?: boolean
  linked?: boolean
  units?: boolean
}

/** The translation unit a function belongs to, for outlining and grouping: the source file when the
 *  decomp names one, else the TU id from its manifest, else none. Files are the unit because that is
 *  what a reader opens; tuId only ever names the same file's reconstruction state. */
export function tuKeyOf(f: AtlasFunction): string | null {
  return f.srcPath ?? f.tuId ?? null
}

/** Last path segment: the label a TU section carries on the map. */
export function tuLabel(key: string): string {
  const i = Math.max(key.lastIndexOf('/'), key.lastIndexOf('\\'))
  return i >= 0 ? key.slice(i + 1) : key
}

export function tierSupport(db: AtlasDb | null, declared?: DeclaredTiers | null): TierSupport {
  let converted = false
  let linked = false
  let units = false
  if (db) {
    const seen = new Set<string>()
    for (const f of db.functions) {
      if (f.converted) converted = true
      if (f.linked) linked = true
      const k = tuKeyOf(f)
      if (k) {
        if (f.tuId) units = true
        else if (seen.has(k)) units = true
        else seen.add(k)
      }
      if (converted && linked && units) break
    }
  }
  return {
    converted: declared?.converted ?? converted,
    linked: declared?.linked ?? linked,
    units: declared?.units ?? units
  }
}

/** Translation unit -> its functions, only for keys held by more than one function. */
export function tuMembers(db: AtlasDb | null): Map<string, AtlasFunction[]> {
  const all = new Map<string, AtlasFunction[]>()
  if (!db) return all
  for (const f of db.functions) {
    const k = tuKeyOf(f)
    if (!k) continue
    const list = all.get(k)
    if (list) list.push(f)
    else all.set(k, [f])
  }
  for (const [k, list] of all) if (list.length < 2) all.delete(k)
  return all
}

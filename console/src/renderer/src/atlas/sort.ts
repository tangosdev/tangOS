import type { AtlasFunction } from '../../../shared/types'

export type SortKey = 'unmatched' | 'size-desc' | 'size-asc' | 'name' | 'addr' | 'module'

export const SORT_LABELS: Record<SortKey, string> = {
  unmatched: 'unmatched first',
  'size-desc': 'size (largest)',
  'size-asc': 'size (smallest)',
  name: 'name (A–Z)',
  addr: 'address',
  module: 'module'
}

export function sortFns(fns: AtlasFunction[], key: SortKey): AtlasFunction[] {
  const a = fns.slice()
  switch (key) {
    case 'size-desc':
      a.sort((x, y) => y.size - x.size)
      break
    case 'size-asc':
      a.sort((x, y) => x.size - y.size)
      break
    case 'name':
      a.sort((x, y) => x.name.localeCompare(y.name))
      break
    case 'addr':
      a.sort((x, y) => x.addr - y.addr)
      break
    case 'module':
      a.sort((x, y) => x.module.localeCompare(y.module) || x.addr - y.addr)
      break
    default: // unmatched first, then largest
      a.sort((x, y) => Number(x.matched) - Number(y.matched) || y.size - x.size)
  }
  return a
}

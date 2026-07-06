/**
 * Squarified treemap layout (ported from sm64ds-decomp/tools/treemap.py via Chaos Viewer).
 * items: array of {value: positive number, ...rest}. Returns {item, x, y, w, h}.
 */
export interface SquarifyItem<T extends { value: number }> {
  item: T
  x: number
  y: number
  w: number
  h: number
}

export function squarify<T extends { value: number }>(
  items: T[],
  x: number,
  y: number,
  w: number,
  h: number
): SquarifyItem<T>[] {
  const filtered = items.filter((it) => it.value > 0)
  if (!filtered.length || w <= 0 || h <= 0) return []
  const total = filtered.reduce((s, it) => s + it.value, 0)
  if (total <= 0) return []

  const scale = (w * h) / total
  const scaled = filtered.map((it) => ({ it, area: it.value * scale }))
  const out: SquarifyItem<T>[] = []
  let rx = x, ry = y, rw = w, rh = h
  let i = 0
  const n = scaled.length

  while (i < n) {
    const short = Math.min(rw, rh)
    let row = [scaled[i]]
    i += 1
    while (i < n) {
      const trial = [...row, scaled[i]]
      if (_worst(trial, short) <= _worst(row, short)) {
        row = trial
        i += 1
      } else break
    }
    out.push(..._layoutRow(row, rx, ry, rw, rh))
    const rowSum = row.reduce((s, r) => s + r.area, 0)
    if (rw <= rh) {
      const dh = rowSum / rw || 0
      ry += dh
      rh -= dh
    } else {
      const dw = rowSum / rh || 0
      rx += dw
      rw -= dw
    }
  }
  return out
}

function _worst(row: Array<{ area: number }>, short: number): number {
  const s = row.reduce((sum, r) => sum + r.area, 0)
  if (s <= 0 || short <= 0) return Infinity
  const mx = Math.max(...row.map((r) => r.area))
  const mn = Math.min(...row.map((r) => r.area))
  return Math.max((short * short * mx) / (s * s), (s * s) / (short * short * mn))
}

function _layoutRow<T extends { value: number }>(
  row: Array<{ it: T; area: number }>,
  rx: number,
  ry: number,
  rw: number,
  rh: number
): SquarifyItem<T>[] {
  const s = row.reduce((sum, r) => sum + r.area, 0)
  if (s <= 0) return []
  const out: SquarifyItem<T>[] = []
  if (rw <= rh) {
    const dh = s / rw
    let cx = rx
    for (const r of row) {
      const cw = r.area / dh || 0
      out.push({ item: r.it, x: cx, y: ry, w: cw, h: dh })
      cx += cw
    }
  } else {
    const dw = s / rh
    let cy = ry
    for (const r of row) {
      const ch = r.area / dw || 0
      out.push({ item: r.it, x: rx, y: cy, w: dw, h: ch })
      cy += ch
    }
  }
  return out
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { squarify } from '../atlas/squarify'
import type { AtlasDb, AtlasFunction } from '../../../shared/types'

const MATCHED = '#3fc45f'
const UNMATCHED = '#b9cadb'
const NEARMISS = '#eab308'
const H = 264

interface FnRect { x: number; y: number; w: number; h: number; f: AtlasFunction }
interface ModRect { module: string; x: number; y: number; w: number; h: number }

/** Chaos-Viewer-style treemap. Geometry (the expensive squarify) is cached and only
 *  recomputed when the data or size changes; recoloring/highlighting just repaints. */
export default function Treemap({
  db,
  moduleFilter,
  onModule,
  onFunction,
  colorBy = 'status',
  authorColors,
  authorResolve,
  authorFilter = null,
  showNearMiss = true,
  square = false,
  fill = false,
  selectedId,
  height = H
}: {
  db: AtlasDb
  moduleFilter: string | null
  onModule: (m: string | null) => void
  onFunction?: (f: AtlasFunction) => void
  colorBy?: 'status' | 'author'
  authorColors?: Map<string, string>
  authorResolve?: Map<string, string>
  authorFilter?: string | null
  showNearMiss?: boolean
  square?: boolean
  fill?: boolean
  selectedId?: string
  height?: number
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [w, setW] = useState(880)
  const [measuredH, setMeasuredH] = useState(H)
  const hasFn = !!onFunction
  const resolve = (a?: string): string => (a ? authorResolve?.get(a) ?? a : '')

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | null = null
    const apply = (): void => {
      setW(Math.max(240, el.clientWidth - 16))
      setMeasuredH(Math.max(120, el.clientHeight - 16))
    }
    apply()
    const measure = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(apply, 150)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      if (t) clearTimeout(t)
      ro.disconnect()
    }
  }, [db, fill])

  const drawH = square ? w : fill ? measuredH : height

  const geom = useMemo(() => {
    const groups = new Map<string, { module: string; value: number; funcs: AtlasFunction[] }>()
    for (const f of db.functions) {
      const g = groups.get(f.module) ?? { module: f.module, value: 0, funcs: [] }
      g.value += Math.max(1, f.size)
      g.funcs.push(f)
      groups.set(f.module, g)
    }
    const mods = [...groups.values()].sort((a, b) => b.value - a.value)
    const modTiles = squarify(mods, 0, 0, w, drawH)
    const modRects: ModRect[] = []
    const fnRects: FnRect[] = []
    for (const mt of modTiles) {
      const items = mt.item.funcs
        .slice()
        .sort((a, b) => b.size - a.size)
        .map((f) => ({ f, value: Math.max(1, f.size) }))
      const fnTiles = squarify(items, mt.x + 1, mt.y + 1, Math.max(0, mt.w - 2), Math.max(0, mt.h - 2))
      for (const ft of fnTiles) fnRects.push({ x: ft.x, y: ft.y, w: ft.w, h: ft.h, f: ft.item.f })
      modRects.push({ module: mt.item.module, x: mt.x, y: mt.y, w: mt.w, h: mt.h })
    }
    return { modRects, fnRects }
  }, [db, w, drawH])

  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs) return
    const dpr = window.devicePixelRatio || 1
    cvs.width = Math.round(w * dpr)
    cvs.height = Math.round(drawH * dpr)
    cvs.style.width = `${w}px`
    cvs.style.height = `${drawH}px`
    const ctx = cvs.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, drawH)

    let selRect: FnRect | null = null
    for (const r of geom.fnRects) {
      const f = r.f
      const dim = (!!moduleFilter && f.module !== moduleFilter) || (!!authorFilter && resolve(f.author) !== authorFilter)
      ctx.globalAlpha = dim ? 0.14 : 1
      if (colorBy === 'author') {
        const who = resolve(f.author)
        ctx.fillStyle = f.matched ? (who && authorColors?.get(who)) || '#9aa7b5' : UNMATCHED
      } else {
        ctx.fillStyle = f.matched ? MATCHED : typeof f.div === 'number' && showNearMiss ? NEARMISS : UNMATCHED
      }
      ctx.fillRect(r.x, r.y, Math.max(0.5, r.w - 0.5), Math.max(0.5, r.h - 0.5))
      if (selectedId && f.id === selectedId) selRect = r
    }
    ctx.globalAlpha = 1

    for (const m of geom.modRects) {
      const sel = moduleFilter === m.module
      ctx.strokeStyle = sel ? '#0d3a5c' : 'rgba(13,58,92,0.55)'
      ctx.lineWidth = sel ? 2.5 : 1
      ctx.strokeRect(m.x + 0.5, m.y + 0.5, Math.max(0, m.w - 1), Math.max(0, m.h - 1))
      if (m.w > 30 && m.h > 12) {
        ctx.font = '600 11px "Segoe UI", system-ui, sans-serif'
        ctx.lineJoin = 'round'
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.strokeText(m.module, m.x + 4, m.y + 12)
        ctx.fillStyle = '#0d3a5c'
        ctx.fillText(m.module, m.x + 4, m.y + 12)
      }
    }

    if (selRect) {
      const r: FnRect = selRect
      const mw = Math.max(r.w, 5)
      const mh = Math.max(r.h, 5)
      ctx.lineJoin = 'round'
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.lineWidth = 4
      ctx.strokeRect(r.x - 1, r.y - 1, mw + 2, mh + 2)
      ctx.strokeStyle = '#0d3a5c'
      ctx.lineWidth = 2
      ctx.strokeRect(r.x - 1, r.y - 1, mw + 2, mh + 2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom, w, drawH, colorBy, authorColors, authorResolve, authorFilter, moduleFilter, showNearMiss, selectedId])

  function onClick(e: React.MouseEvent): void {
    const cvs = canvasRef.current
    if (!cvs) return
    const r = cvs.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    if (onFunction) {
      const fr = geom.fnRects.find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h)
      if (fr) {
        onFunction(fr.f)
        return
      }
    }
    const hit = geom.modRects.find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h)
    if (hit) onModule(moduleFilter === hit.module ? null : hit.module)
    void hasFn
  }

  return (
    <div className={`atlas-treemap aero-panel${fill ? ' fill' : ''}`} ref={wrapRef}>
      <canvas ref={canvasRef} onClick={onClick} style={{ display: 'block', cursor: 'pointer', borderRadius: 8 }} />
    </div>
  )
}

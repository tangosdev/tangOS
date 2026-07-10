import type { AtlasFunction } from '../../../../../shared/types'
import { smoothstep } from '../anim'
import type { Camera } from '../camera'
import type { World } from '../../layout'
import type { Rect } from '../../types'
import type { Theme } from '../../themes/types'

export interface PaintView {
  theme: Theme
  colorBy: 'status' | 'author'
  authorColors?: Map<string, string>
  authorResolve?: Map<string, string>
  authorFilter: string | null
  moduleFilter: string | null
  showNearMiss: boolean
}

const AUTHOR_FALLBACK = '#9aa7b5'
const LABEL_FONT = '600 11px "Segoe UI", system-ui, sans-serif'

function resolveAuthor(v: PaintView, a?: string): string {
  return a ? v.authorResolve?.get(a) ?? a : ''
}

export function fnColor(f: AtlasFunction, v: PaintView): string {
  const c = v.theme.colors
  if (v.colorBy === 'author') {
    if (!f.matched) return c.unmatched
    const who = resolveAuthor(v, f.author)
    return (who && v.authorColors?.get(who)) || AUTHOR_FALLBACK
  }
  if (f.matched) return c.matched
  if (typeof f.div === 'number' && v.showNearMiss) return c.nearMiss
  return c.unmatched
}

export function isDimmed(f: AtlasFunction, v: PaintView): boolean {
  return (
    (!!v.moduleFilter && f.module !== v.moduleFilter) ||
    (!!v.authorFilter && resolveAuthor(v, f.author) !== v.authorFilter)
  )
}

/** Flat tiles in world space. The ctx transform must already map world -> device px. */
export function paintTiles(
  ctx: CanvasRenderingContext2D,
  world: World,
  view: Rect,
  v: PaintView,
  scratch: number[]
): void {
  for (const i of world.query(view, scratch)) {
    const n = world.fns[i]
    ctx.globalAlpha = isDimmed(n.f, v) ? 0.14 : 1
    ctx.fillStyle = fnColor(n.f, v)
    ctx.fillRect(n.x, n.y, Math.max(0.5, n.w - 0.5), Math.max(0.5, n.h - 0.5))
  }
  ctx.globalAlpha = 1
}

/** Module borders, world space. invZ keeps stroke widths constant on screen. */
export function paintModuleBorders(ctx: CanvasRenderingContext2D, world: World, v: PaintView, invZ: number): void {
  for (const m of world.mods) {
    const sel = v.moduleFilter === m.module
    ctx.strokeStyle = sel ? v.theme.colors.moduleStroke : 'rgba(13,58,92,0.55)'
    ctx.lineWidth = (sel ? 2.5 : 1) * invZ
    ctx.strokeRect(m.x + 0.5 * invZ, m.y + 0.5 * invZ, Math.max(0, m.w - invZ), Math.max(0, m.h - invZ))
  }
}

/** Labels at constant screen size: module names always (when their rect is large
 *  enough on screen), function names fading in once a tile projects tall enough.
 *  The ctx transform must map CSS px (dpr applied); positions are projected. */
export function paintLabels(
  ctx: CanvasRenderingContext2D,
  world: World,
  view: Rect,
  v: PaintView,
  cam: Camera,
  scratch: number[]
): void {
  ctx.font = LABEL_FONT
  ctx.lineJoin = 'round'
  for (const i of world.query(view, scratch)) {
    const n = world.fns[i]
    const hpx = n.h * cam.z
    if (hpx < 40) continue
    const wpx = n.w * cam.z
    if (wpx < 50) continue
    const alpha = smoothstep(40, 70, hpx) * (isDimmed(n.f, v) ? 0.14 : 1)
    if (alpha < 0.05) continue
    const p = cam.worldToScreen(n.x, n.y)
    ctx.globalAlpha = alpha
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.strokeText(n.f.name, p.x + 4, p.y + 13, wpx - 8)
    ctx.fillStyle = v.theme.colors.moduleStroke
    ctx.fillText(n.f.name, p.x + 4, p.y + 13, wpx - 8)
  }
  ctx.globalAlpha = 1
  for (const m of world.mods) {
    const wpx = m.w * cam.z
    const hpx = m.h * cam.z
    if (wpx <= 30 || hpx <= 12) continue
    const p = cam.worldToScreen(m.x, m.y)
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.strokeText(m.module, p.x + 4, p.y + 12, Math.max(20, wpx - 8))
    ctx.fillStyle = v.theme.colors.moduleStroke
    ctx.fillText(m.module, p.x + 4, p.y + 12, Math.max(20, wpx - 8))
  }
}

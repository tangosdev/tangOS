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
  starredIds?: Set<string>
}

const AUTHOR_FALLBACK = '#9aa7b5'
const STAR_GOLD = '#fbbf24'
const LABEL_FONT = '600 11px "Segoe UI", system-ui, sans-serif'
// Light-red wash over a function another contributor holds (active/partial CLAIMS.md, Live only),
// so hand-picking can see it is taken and the marquee visibly skips it.
const CLAIM_TINT = 'rgba(255,90,90,0.42)'

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
  // A committed src file that is NOT matched (e.g. a // NONMATCHING hand-asm/near-miss
  // draft) still represents work done, so color it as a draft even when there is no
  // near-miss `div`. Matches the draft rule in layout.ts.
  if ((typeof f.div === 'number' || !!f.srcPath) && v.showNearMiss) return c.nearMiss
  return c.unmatched
}

export function isDimmed(f: AtlasFunction, v: PaintView): boolean {
  return (
    (!!v.moduleFilter && f.module !== v.moduleFilter) ||
    (!!v.authorFilter && resolveAuthor(v, f.author) !== v.authorFilter)
  )
}

/** Flat tiles in world space. The ctx transform must already map world -> device px.
 *  invZ keeps the hairline gap between tiles at ~0.5 SCREEN px regardless of zoom -
 *  world-unit gaps would blow up into fat empty bands at code zoom. */
export function paintTiles(
  ctx: CanvasRenderingContext2D,
  world: World,
  view: Rect,
  v: PaintView,
  scratch: number[],
  invZ: number
): void {
  const shave = 0.5 * invZ
  const starred = v.starredIds
  for (const i of world.query(view, scratch)) {
    const n = world.fns[i]
    const w = Math.max(shave, n.w - shave)
    const h = Math.max(shave, n.h - shave)
    ctx.globalAlpha = isDimmed(n.f, v) ? 0.14 : 1
    ctx.fillStyle = fnColor(n.f, v)
    ctx.fillRect(n.x, n.y, w, h)
    if (n.f.claim && !isDimmed(n.f, v)) {
      ctx.fillStyle = CLAIM_TINT
      ctx.fillRect(n.x, n.y, w, h)
    }
    if (starred?.has(n.f.id) && !isDimmed(n.f, v)) {
      // Gold outline round the whole tile plus a star glyph when it's big enough to carry
      // one - the same treatment as the website viewer's bought stars.
      ctx.strokeStyle = STAR_GOLD
      ctx.lineWidth = 1.5 * invZ
      ctx.strokeRect(n.x + 0.75 * invZ, n.y + 0.75 * invZ, w - 1.5 * invZ, h - 1.5 * invZ)
      const s = Math.min(w, h)
      if (s > 12 * invZ) {
        const r = Math.min(5 * invZ, s * 0.3)
        drawStar(ctx, n.x + w - r * 1.4, n.y + r * 1.4, r)
        ctx.fillStyle = STAR_GOLD
        ctx.fill()
      }
    }
  }
  ctx.globalAlpha = 1
}

// 5-point star path centered on (cx, cy) in the current (world) transform; caller fills.
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number): void {
  const inner = outer * 0.45
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5
    const radius = i % 2 === 0 ? outer : inner
    const x = cx + Math.cos(angle) * radius
    const y = cy + Math.sin(angle) * radius
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** One world-locked ground fill under everything - the tile gaps and module
 *  insets read as a stable tone that moves with the map. World transform. */
export function paintGround(ctx: CanvasRenderingContext2D, world: World, v: PaintView): void {
  ctx.fillStyle = v.theme.colors.ground
  ctx.fillRect(0, 0, world.w, world.h)
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

/** Function name labels at constant screen size, fading in once a tile projects
 *  tall enough. The ctx transform must map CSS px (dpr applied). */
export function paintFnLabels(
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
}

/** Group name labels at constant screen size (parity with the classic Treemap), each with its
 *  function count in parentheses ("ov006 (321)", "andrewboudreau (94)"). Counted by group INDEX
 *  (modIx), not by f.module - in the size/match/contributor layouts the groups are keyed by
 *  bucket/contributor, so a module-name count read 0 for every header. One pass per bake. */
export function paintModuleLabels(
  ctx: CanvasRenderingContext2D,
  world: World,
  v: PaintView,
  cam: Camera
): void {
  const counts = new Array<number>(world.mods.length).fill(0)
  for (const n of world.fns) if (n.modIx >= 0 && n.modIx < counts.length) counts[n.modIx]++
  ctx.font = LABEL_FONT
  ctx.lineJoin = 'round'
  for (let i = 0; i < world.mods.length; i++) {
    const m = world.mods[i]
    const wpx = m.w * cam.z
    const hpx = m.h * cam.z
    if (wpx <= 30 || hpx <= 12) continue
    const p = cam.worldToScreen(m.x, m.y)
    const label = `${m.module} (${counts[i]})`
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.strokeText(label, p.x + 4, p.y + 12, Math.max(20, wpx - 8))
    ctx.fillStyle = v.theme.colors.moduleStroke
    ctx.fillText(label, p.x + 4, p.y + 12, Math.max(20, wpx - 8))
  }
}

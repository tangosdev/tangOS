import type { Camera } from '../camera'
import type { World } from '../../layout'
import type { SourceCache } from '../../sourceCache'
import { smoothstep } from '../anim'

const HEADER_FONT = '600 12px "Segoe UI", system-ui, sans-serif'
const INK = 'rgba(13,42,66,0.92)'
const INK_SOFT = 'rgba(13,42,66,0.55)'
const MIN_LINE_H = 11
const MAX_LINE_H = 17

/** Source text inside the SELECTED function only, and only once the dive has it
 *  filling most of the viewport (the fit a click/WASD flight lands on). Fades in
 *  across the last stretch of zoom so it never pops. Bake-only, screen space. */
export function paintSelectedCode(
  ctx: CanvasRenderingContext2D,
  world: World,
  cam: Camera,
  sources: SourceCache,
  selectedId: string | undefined
): void {
  if (!selectedId) return
  const ix = world.byId.get(selectedId)
  if (ix == null) return
  const n = world.fns[ix]
  const wpx = n.w * cam.z
  const hpx = n.h * cam.z * cam.sy
  const coverage = Math.max(wpx / cam.vw, hpx / cam.vh)
  const alpha = smoothstep(0.55, 0.8, coverage)
  if (alpha <= 0.02) return
  const entry = sources.get(n.f.id)
  if (entry.state === 'idle') sources.request(n.f)
  const p = cam.worldToScreen(n.x, n.y)
  ctx.save()
  ctx.beginPath()
  ctx.rect(p.x + 1, p.y + 1, wpx - 2, hpx - 2)
  ctx.clip()
  ctx.globalAlpha = alpha
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.fillRect(p.x + 1, p.y + 1, wpx - 2, hpx - 2)
  ctx.font = HEADER_FONT
  ctx.fillStyle = INK
  ctx.fillText(n.f.name, p.x + 10, p.y + 18, Math.max(20, wpx - 20))
  const src = entry.state === 'ready' ? entry.src : undefined
  if (!src) {
    ctx.fillStyle = INK_SOFT
    ctx.font = '11px Consolas, "Courier New", monospace'
    ctx.fillText(entry.state === 'loading' ? 'loading source...' : 'no source yet - unmatched', p.x + 10, p.y + 38)
    ctx.restore()
    ctx.globalAlpha = 1
    return
  }
  const padX = 10
  const top = p.y + 28
  const availH = hpx - 34
  const lineH = Math.min(MAX_LINE_H, Math.max(MIN_LINE_H, availH / Math.max(1, src.lines.length)))
  const fontPx = Math.floor(lineH * 0.8)
  ctx.font = `${fontPx}px Consolas, "Courier New", monospace`
  ctx.fillStyle = INK
  const maxChars = Math.ceil((wpx - padX * 2) / (fontPx * 0.55))
  const nShow = Math.min(src.lines.length, Math.max(1, Math.floor(availH / lineH)))
  for (let i = 0; i < nShow; i++) {
    const text = src.lines[i]
    if (!text) continue
    ctx.fillText(text.replace(/\t/g, '  ').slice(0, maxChars), p.x + padX, top + i * lineH + lineH * 0.8)
  }
  if (src.truncated || nShow < src.lines.length) {
    ctx.fillStyle = INK_SOFT
    ctx.fillText('...', p.x + padX, Math.min(top + nShow * lineH + 12, p.y + hpx - 8))
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

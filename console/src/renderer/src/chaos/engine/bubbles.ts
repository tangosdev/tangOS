import { clamp, easeOutBack } from './anim'
import type { Camera } from './camera'

/** Hover name bubble: pops in over the hovered module/function, retargets with a
 *  quicker pop, fades out on leave. Drawn in screen space so zoom never scales it. */

const FONT = '600 11px "Segoe UI", system-ui, sans-serif'
const SUB_FONT = '400 10.5px "Segoe UI", system-ui, sans-serif'
const POP_MS = 150
const RETARGET_MS = 80
const FADE_MS = 100
const H = 22
const NOTCH = 6
const PAD_X = 8
const MARGIN = 8
const SUB_LINE_H = 13
const SUB_MAX_W = 250

export class NameBubble {
  private text = ''
  private sub = ''
  private wx = 0
  private wy = 0
  private shownAt = -1e9
  private hiddenAt = -1e9
  private visible = false
  private popMs = POP_MS
  private readonly widths = new Map<string, number>()
  // Wrapped `sub`, cached per text so the wrap is measured once and not every frame.
  private subLines: string[] = []
  private subWrapped = ''

  /** The text currently targeted, '' when hidden or fading out. */
  get currentText(): string {
    return this.visible ? this.text : ''
  }

  /** `sub` is an optional explanation wrapped under the name - used to say why a
   *  function needs no match, rather than leaving the red tile unexplained. */
  show(text: string, wx: number, wy: number, now: number, sub = ''): void {
    if (this.visible && this.text === text && this.sub === sub) return
    this.popMs = this.visible ? RETARGET_MS : POP_MS
    this.text = text
    this.sub = sub
    this.wx = wx
    this.wy = wy
    this.shownAt = now
    this.visible = true
  }

  hide(now: number): void {
    if (!this.visible) return
    this.visible = false
    this.hiddenAt = now
  }

  needsFrame(now: number): boolean {
    if (this.visible) return now - this.shownAt < this.popMs + 40
    return now - this.hiddenAt < FADE_MS + 40
  }

  /** ctx transform must map CSS px (dpr already applied). */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, now: number): void {
    let scale: number
    let alpha: number
    if (this.visible) {
      const k = clamp((now - this.shownAt) / this.popMs, 0, 1)
      scale = 0.55 + 0.45 * easeOutBack(k)
      alpha = clamp((now - this.shownAt) / 100, 0, 1)
    } else {
      const k = clamp((now - this.hiddenAt) / FADE_MS, 0, 1)
      if (k >= 1) return
      scale = 1 - 0.15 * k
      alpha = 1 - k
    }
    ctx.font = FONT
    let tw = this.widths.get(this.text)
    if (tw == null) {
      if (this.widths.size > 512) this.widths.clear()
      tw = ctx.measureText(this.text).width
      this.widths.set(this.text, tw)
    }
    if (this.sub !== this.subWrapped) {
      ctx.font = SUB_FONT
      this.subLines = wrap(ctx, this.sub, SUB_MAX_W)
      this.subWrapped = this.sub
      ctx.font = FONT
    }
    const subW = this.subLines.length
      ? Math.max(...this.subLines.map((l) => measure(ctx, l, SUB_FONT, FONT)))
      : 0
    const bw = Math.max(tw, subW) + PAD_X * 2
    const bh = H + (this.subLines.length ? this.subLines.length * SUB_LINE_H + 4 : 0)
    const p = cam.worldToScreen(this.wx, this.wy)
    const bx = clamp(p.x - bw / 2, MARGIN, Math.max(MARGIN, cam.vw - bw - MARGIN))
    let by = p.y - NOTCH - bh - 4
    let dir: 1 | -1 = 1
    if (by < MARGIN) {
      dir = -1
      by = p.y + NOTCH + 4
    }
    const tipX = clamp(p.x, bx + 10, bx + bw - 10)
    const tipY = dir === 1 ? by + bh + NOTCH : by - NOTCH
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(tipX, tipY)
    ctx.scale(scale, scale)
    ctx.translate(-tipX, -tipY)
    bubblePath(ctx, bx, by, bw, bh, 7, tipX, dir)
    ctx.fillStyle = 'rgba(255,255,255,0.93)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(13,58,92,0.85)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = '#0d3a5c'
    ctx.font = FONT
    ctx.fillText(this.text, bx + PAD_X, by + 15)
    if (this.subLines.length) {
      ctx.font = SUB_FONT
      ctx.fillStyle = 'rgba(13,58,92,0.78)'
      this.subLines.forEach((l, i) => ctx.fillText(l, bx + PAD_X, by + H + 6 + i * SUB_LINE_H))
    }
    ctx.restore()
  }
}

function measure(ctx: CanvasRenderingContext2D, s: string, font: string, restore: string): number {
  ctx.font = font
  const w = ctx.measureText(s).width
  ctx.font = restore
  return w
}

/** Greedy word wrap. Called only when the explanation text changes, not per frame. */
function wrap(ctx: CanvasRenderingContext2D, s: string, maxW: number): string[] {
  if (!s) return []
  const out: string[] = []
  let line = ''
  for (const word of s.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > maxW) {
      out.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) out.push(line)
  return out
}

function bubblePath(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  r: number,
  tipX: number,
  dir: 1 | -1
): void {
  ctx.beginPath()
  if (dir === 1) {
    // notch on the bottom edge - bubble floats above the anchor
    ctx.moveTo(bx + r, by)
    ctx.lineTo(bx + bw - r, by)
    ctx.arcTo(bx + bw, by, bx + bw, by + r, r)
    ctx.lineTo(bx + bw, by + bh - r)
    ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r)
    ctx.lineTo(tipX + NOTCH, by + bh)
    ctx.lineTo(tipX, by + bh + NOTCH)
    ctx.lineTo(tipX - NOTCH, by + bh)
    ctx.lineTo(bx + r, by + bh)
    ctx.arcTo(bx, by + bh, bx, by + bh - r, r)
    ctx.lineTo(bx, by + r)
    ctx.arcTo(bx, by, bx + r, by, r)
  } else {
    // notch on the top edge - bubble hangs below the anchor
    ctx.moveTo(bx + r, by)
    ctx.lineTo(tipX - NOTCH, by)
    ctx.lineTo(tipX, by - NOTCH)
    ctx.lineTo(tipX + NOTCH, by)
    ctx.lineTo(bx + bw - r, by)
    ctx.arcTo(bx + bw, by, bx + bw, by + r, r)
    ctx.lineTo(bx + bw, by + bh - r)
    ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r)
    ctx.lineTo(bx + r, by + bh)
    ctx.arcTo(bx, by + bh, bx, by + bh - r, r)
    ctx.lineTo(bx, by + r)
    ctx.arcTo(bx, by, bx + r, by, r)
  }
  ctx.closePath()
}

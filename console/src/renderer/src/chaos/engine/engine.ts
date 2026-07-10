import type { AtlasDb, AtlasFunction } from '../../../../shared/types'
import { buildWorld } from '../layout'
import type { World } from '../layout'
import { getTheme } from '../themes'
import { clamp } from './anim'
import { NameBubble } from './bubbles'
import { Camera } from './camera'
import { LodState } from './lod'
import { RippleField, rippleBounds, rippleLift } from './ripple'
import { fnColor, isDimmed, paintLabels, paintModuleBorders, paintTiles } from './render/classic'
import type { PaintView } from './render/classic'

export interface EngineCallbacks {
  onModule: (m: string | null) => void
  onFunction: (f: AtlasFunction) => void
  onBand?: (band: 1 | 2 | 3) => void
}

export interface ViewOptions {
  colorBy: 'status' | 'author'
  authorColors?: Map<string, string>
  authorResolve?: Map<string, string>
  authorFilter: string | null
  moduleFilter: string | null
  showNearMiss: boolean
  selectedId?: string
  themeId: string
}

declare global {
  interface Window {
    /** Set window.chaosPerf = true from devtools to overlay frame/bake timings. */
    chaosPerf?: boolean
  }
}

const DEFAULT_OPTS: ViewOptions = {
  colorBy: 'status',
  authorFilter: null,
  moduleFilter: null,
  showNearMiss: true,
  themeId: 'classic'
}

interface BakeCam {
  x: number
  y: number
  z: number
  vw: number
  vh: number
  ovX: number
  ovY: number
}

/** Owns the rAF loop and all mutable viewer state. React never sees a frame.
 *  Two layers: a baked base bitmap (tiles, borders, labels) re-baked only when
 *  the camera settles or data/options change, blitted with a delta transform
 *  while the camera flies; and a dynamic pass (ripples, bubbles, selection)
 *  drawn over it each frame. The loop sleeps whenever nothing moves. */
export class ChaosEngine {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly base: HTMLCanvasElement
  private readonly baseCtx: CanvasRenderingContext2D
  private readonly cb: EngineCallbacks
  private readonly cam = new Camera()
  private readonly lod = new LodState()
  private readonly scratch: number[] = []
  private readonly ripples = new RippleField()
  private readonly bubble = new NameBubble()
  private readonly pointer = { x: 0, y: 0, lastT: 0, inside: false }
  private db: AtlasDb | null = null
  private world: World | null = null
  private opts: ViewOptions = { ...DEFAULT_OPTS }
  private cssW = 0
  private cssH = 0
  private dpr = 1
  private needBake = true
  private bakeCam: BakeCam | null = null
  private rafId: number | null = null
  private disposed = false
  private lastFrameT = 0
  private lastBakeMs = 0
  private lastFrameMs = 0
  private restX = 0
  private restY = 0
  private restSince = 0
  private pendingBubble = false
  private lastEmittedModule: string | null = null
  private lastBand: 1 | 2 | 3 = 1

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks) {
    this.canvas = canvas
    this.cb = cb
    const ctx = canvas.getContext('2d')
    const base = document.createElement('canvas')
    const baseCtx = base.getContext('2d')
    if (!ctx || !baseCtx) throw new Error('chaos: 2d canvas context unavailable')
    this.ctx = ctx
    this.base = base
    this.baseCtx = baseCtx
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr) return
    this.cssW = cssW
    this.cssH = cssH
    this.dpr = dpr
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    this.cam.setViewport(cssW, cssH)
    this.rebuild()
  }

  setData(db: AtlasDb): void {
    this.db = db
    this.rebuild()
  }

  setOptions(next: Partial<ViewOptions>): void {
    const prev = this.opts
    this.opts = { ...prev, ...next }
    const bakeKeys: (keyof ViewOptions)[] = [
      'colorBy',
      'authorColors',
      'authorResolve',
      'authorFilter',
      'moduleFilter',
      'showNearMiss',
      'themeId'
    ]
    if (bakeKeys.some((k) => prev[k] !== this.opts[k])) this.needBake = true
    if ('moduleFilter' in next && next.moduleFilter !== prev.moduleFilter) {
      // externally requested focus (toolbar chip, list selection, detail-bar close)
      if (this.opts.moduleFilter !== this.lastEmittedModule) this.externalFocus(this.opts.moduleFilter)
      this.lastEmittedModule = this.opts.moduleFilter
    }
    this.invalidate()
  }

  /** Click in canvas CSS coordinates. Band 1: fly into the module. Band 2+:
   *  select the function (same upward semantics as the classic Treemap). */
  click(cssX: number, cssY: number): void {
    if (!this.world) return
    const p = this.cam.screenToWorld(cssX, cssY)
    if (this.lod.band === 1) {
      const mod = this.world.hitMod(p.x, p.y)
      if (mod) {
        this.lastEmittedModule = mod.module
        this.cb.onModule(mod.module)
        this.cam.flyToRect(mod, 0.06, performance.now())
        this.wake()
      }
      return
    }
    const fn = this.world.hitFn(p.x, p.y)
    if (fn) {
      this.cb.onFunction(fn.f)
      return
    }
    const mod = this.world.hitMod(p.x, p.y)
    if (mod) this.cb.onModule(this.opts.moduleFilter === mod.module ? null : mod.module)
  }

  /** Pointer position in canvas CSS coordinates. Feeds ripples and hover intent. */
  pointerMove(cssX: number, cssY: number): void {
    const now = performance.now()
    const pt = this.pointer
    if (pt.inside && this.lod.band === 1 && this.cam.settled(now)) {
      const dt = Math.max(1, now - pt.lastT)
      const speed = (Math.hypot(cssX - pt.x, cssY - pt.y) / dt) * 1000
      const w = this.cam.screenToWorld(cssX, cssY)
      this.ripples.emit(w.x, w.y, speed, now)
    }
    if (Math.hypot(cssX - this.restX, cssY - this.restY) > 4) {
      this.restX = cssX
      this.restY = cssY
      this.restSince = now
    }
    pt.x = cssX
    pt.y = cssY
    pt.lastT = now
    pt.inside = true
    this.wake()
  }

  pointerLeave(): void {
    this.pointer.inside = false
    this.bubble.hide(performance.now())
    this.wake()
  }

  wheel(cssX: number, cssY: number, deltaY: number): void {
    this.cam.wheelZoomAt(cssX, cssY, deltaY, performance.now())
    this.bubble.hide(performance.now())
    this.wake()
  }

  panBy(dxCss: number, dyCss: number): void {
    const now = performance.now()
    this.cam.panBy(dxCss, dyCss, now)
    this.bubble.hide(now)
    this.ripples.clear()
    this.wake()
  }

  /** Returns true when the key was consumed. */
  key(k: string): boolean {
    if (k === 'Escape') return this.escapeOut()
    return false
  }

  invalidate(): void {
    this.wake()
  }

  destroy(): void {
    this.disposed = true
    if (this.rafId != null) cancelAnimationFrame(this.rafId)
    this.rafId = null
  }

  private escapeOut(): boolean {
    if (!this.world) return false
    const now = performance.now()
    if (this.lod.band === 3) {
      const dom = this.world.hitMod(this.cam.x, this.cam.y)
      if (dom) {
        this.cam.flyToRect(dom, 0.06, now)
        this.wake()
        return true
      }
    }
    if (this.lod.band >= 2) {
      this.cam.flyToRect({ x: 0, y: 0, w: this.world.w, h: this.world.h }, 0, now)
      this.wake()
      return true
    }
    return false
  }

  private externalFocus(m: string | null): void {
    if (!this.world) return
    const now = performance.now()
    if (m) {
      const mod = this.world.mods.find((x) => x.module === m)
      if (!mod) return
      const dom = this.world.hitMod(this.cam.x, this.cam.y)
      if (this.lod.band >= 2 && dom && dom.module === m) return
      this.cam.flyToRect(mod, 0.06, now)
    } else if (this.lod.band > 1) {
      this.cam.flyToRect({ x: 0, y: 0, w: this.world.w, h: this.world.h }, 0, now)
    }
    this.wake()
  }

  private wake(): void {
    if (this.disposed || this.rafId != null) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      this.frame()
    })
  }

  private rebuild(): void {
    if (!this.db || this.cssW <= 0 || this.cssH <= 0) return
    const prevBand = this.lod.band
    const anchorModule = this.opts.moduleFilter
    const anchorFn = this.opts.selectedId
    this.world = buildWorld(this.db, this.cssW, this.cssH)
    this.lod.compute(this.world, this.cssW, this.cssH)
    this.cam.setWorld(this.world.w, this.world.h, this.lod.zMax())
    const fnIx = anchorFn != null ? this.world.byId.get(anchorFn) : undefined
    if (prevBand === 3 && fnIx != null) {
      this.cam.jumpToRect(this.world.fns[fnIx], 0.35)
    } else if (prevBand >= 2 && anchorModule) {
      const mod = this.world.mods.find((m) => m.module === anchorModule)
      if (mod) this.cam.jumpToRect(mod, 0.06)
      else this.cam.fitWorld()
    } else {
      this.cam.fitWorld()
    }
    this.lod.update(this.cam.z)
    this.needBake = true
    this.invalidate()
  }

  private paintView(): PaintView {
    return {
      theme: getTheme(this.opts.themeId),
      colorBy: this.opts.colorBy,
      authorColors: this.opts.authorColors,
      authorResolve: this.opts.authorResolve,
      authorFilter: this.opts.authorFilter,
      moduleFilter: this.opts.moduleFilter,
      showNearMiss: this.opts.showNearMiss
    }
  }

  private bakeMatches(): boolean {
    const b = this.bakeCam
    return !!b && b.x === this.cam.x && b.y === this.cam.y && b.z === this.cam.z
  }

  private bake(): void {
    if (!this.world) return
    const t0 = performance.now()
    const { cam, dpr } = this
    const ovX = cam.overscanX
    const ovY = cam.overscanY
    const bw = Math.round((this.cssW + 2 * ovX) * dpr)
    const bh = Math.round((this.cssH + 2 * ovY) * dpr)
    if (this.base.width !== bw || this.base.height !== bh) {
      this.base.width = bw
      this.base.height = bh
    }
    const c = this.baseCtx
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, bw, bh)
    const vr = cam.viewRect()
    const view = {
      x: vr.x - ovX / cam.z,
      y: vr.y - ovY / cam.z,
      w: vr.w + (2 * ovX) / cam.z,
      h: vr.h + (2 * ovY) / cam.z
    }
    const v = this.paintView()
    c.setTransform(
      dpr * cam.z,
      0,
      0,
      dpr * cam.z,
      dpr * (ovX + cam.vw / 2 - cam.x * cam.z),
      dpr * (ovY + cam.vh / 2 - cam.y * cam.z)
    )
    paintTiles(c, this.world, view, v, this.scratch)
    paintModuleBorders(c, this.world, v, 1 / cam.z)
    // labels render at constant screen size - a separate pass in screen coords
    c.setTransform(dpr, 0, 0, dpr, ovX * dpr, ovY * dpr)
    paintLabels(c, this.world, view, v, cam, this.scratch)
    this.bakeCam = { x: cam.x, y: cam.y, z: cam.z, vw: cam.vw, vh: cam.vh, ovX, ovY }
    this.needBake = false
    this.lastBakeMs = performance.now() - t0
  }

  /** Blit the (possibly stale) base with the delta between its bake camera and
   *  the live camera - camera motion costs one drawImage per frame. */
  private blitBase(): void {
    const bk = this.bakeCam
    if (!bk) return
    const { ctx, cam, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const s = cam.z / bk.z
    const dx = (bk.x - cam.x) * cam.z + cam.vw / 2 - (bk.ovX + bk.vw / 2) * s
    const dy = (bk.y - cam.y) * cam.z + cam.vh / 2 - (bk.ovY + bk.vh / 2) * s
    ctx.drawImage(this.base, dx, dy, (bk.vw + 2 * bk.ovX) * s, (bk.vh + 2 * bk.ovY) * s)
  }

  private frame(): void {
    if (this.disposed) return
    const now = performance.now()
    const dt = clamp((now - this.lastFrameT) / 1000, 0, 0.033)
    this.lastFrameT = now
    const { ctx, canvas } = this
    if (!this.world) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    const camMoving = this.cam.update(dt, now)
    const band = this.lod.update(this.cam.z)
    if (band !== this.lastBand) {
      this.lastBand = band
      this.cb.onBand?.(band)
    }
    const settled = this.cam.settled(now)
    if (settled && (this.needBake || !this.bakeMatches())) this.bake()
    const ripplesActive = this.ripples.step(now)
    this.updateHover(now, settled)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    this.blitBase()
    if (ripplesActive && band === 1 && settled) this.drawRipples(now)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.bubble.draw(ctx, this.cam, now)
    this.drawSelection()
    this.emitFocus(settled, band)
    this.lastFrameMs = performance.now() - now
    if (window.chaosPerf) this.drawPerf()
    // keep frames coming only while something is alive; otherwise the loop sleeps
    if (camMoving || !settled || ripplesActive || this.bubble.needsFrame(now) || this.pendingBubble) {
      this.wake()
    }
  }

  /** While the camera rests at band 2+, the module under the camera center is the
   *  focus - emitted upward so the toolbar/list follow the viewport. Band 1 clears. */
  private emitFocus(settled: boolean, band: 1 | 2 | 3): void {
    if (!settled || !this.world) return
    if (band >= 2) {
      const dom = this.world.hitMod(this.cam.x, this.cam.y)
      if (dom && dom.module !== this.lastEmittedModule) {
        this.lastEmittedModule = dom.module
        this.cb.onModule(dom.module)
      }
    } else if (this.lastEmittedModule) {
      this.lastEmittedModule = null
      this.cb.onModule(null)
    }
  }

  /** Bubble intent: the cursor must rest ~90ms (within a 4px jitter box) before a
   *  name pops - modules at band 1, functions at band 2+. Hidden while moving. */
  private updateHover(now: number, settled: boolean): void {
    this.pendingBubble = false
    if (!this.world || !this.pointer.inside || !settled) {
      this.bubble.hide(now)
      return
    }
    const p = this.cam.screenToWorld(this.pointer.x, this.pointer.y)
    if (this.lod.band === 1) {
      const mod = this.world.hitMod(p.x, p.y)
      if (!mod) {
        this.bubble.hide(now)
        return
      }
      if (this.bubble.currentText === mod.module) return
      if (now - this.restSince >= 90) {
        this.bubble.show(mod.module, mod.x + mod.w / 2, mod.y + mod.h / 2, now)
      } else {
        this.pendingBubble = true
      }
    } else {
      const fn = this.world.hitFn(p.x, p.y)
      if (!fn) {
        this.bubble.hide(now)
        return
      }
      if (this.bubble.currentText === fn.f.name) return
      if (now - this.restSince >= 90) {
        this.bubble.show(fn.f.name, fn.x + fn.w / 2, fn.y, now)
      } else {
        this.pendingBubble = true
      }
    }
  }

  /** Repaint the ripple-affected region from data: clear, tiles with lift, module
   *  chrome - all clipped, so it composes seamlessly against the baked base. */
  private drawRipples(now: number): void {
    const { world, cam, ctx, dpr } = this
    if (!world) return
    const snaps = this.ripples.snapshot(cam, now)
    if (!snaps.length) return
    const b = rippleBounds(snaps)
    const bx = Math.max(0, b.x)
    const by = Math.max(0, b.y)
    const bw = Math.min(this.cssW, b.x + b.w) - bx
    const bh = Math.min(this.cssH, b.y + b.h) - by
    if (bw <= 0 || bh <= 0) return
    const v = this.paintView()
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.beginPath()
    ctx.rect(bx, by, bw, bh)
    ctx.clip()
    ctx.clearRect(bx, by, bw, bh)
    ctx.setTransform(
      dpr * cam.z,
      0,
      0,
      dpr * cam.z,
      dpr * (cam.vw / 2 - cam.x * cam.z),
      dpr * (cam.vh / 2 - cam.y * cam.z)
    )
    const tl = cam.screenToWorld(bx, by)
    const br = cam.screenToWorld(bx + bw, by + bh)
    const view = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
    const halfW = cam.vw / 2
    const halfH = cam.vh / 2
    for (const i of world.query(view, this.scratch)) {
      const n = world.fns[i]
      const sx = (n.x + n.w / 2 - cam.x) * cam.z + halfW
      const sy = (n.y + n.h / 2 - cam.y) * cam.z + halfH
      const lift = rippleLift(snaps, sx, sy)
      const dimA = isDimmed(n.f, v) ? 0.14 : 1
      ctx.globalAlpha = dimA
      ctx.fillStyle = fnColor(n.f, v)
      if (lift < 0.004) {
        ctx.fillRect(n.x, n.y, Math.max(0.5, n.w - 0.5), Math.max(0.5, n.h - 0.5))
      } else {
        const s = 1 + 0.05 * lift
        const x = n.x + (n.w * (1 - s)) / 2
        const y = n.y + (n.h * (1 - s)) / 2 - (3 * lift) / cam.z
        const w2 = Math.max(0.5, n.w * s - 0.5)
        const h2 = Math.max(0.5, n.h * s - 0.5)
        ctx.fillRect(x, y, w2, h2)
        ctx.globalAlpha = dimA * 0.1 * lift
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(x, y, w2, h2)
      }
    }
    ctx.globalAlpha = 1
    paintModuleBorders(ctx, world, v, 1 / cam.z)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paintLabels(ctx, world, view, v, cam, this.scratch)
    ctx.restore()
  }

  private drawSelection(): void {
    const { world } = this
    const id = this.opts.selectedId
    if (!world || !id) return
    const ix = world.byId.get(id)
    if (ix == null) return
    const n = world.fns[ix]
    const { ctx, cam } = this
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const p = cam.worldToScreen(n.x, n.y)
    const mw = Math.max(n.w * cam.z, 5)
    const mh = Math.max(n.h * cam.z, 5)
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 4
    ctx.strokeRect(p.x - 1, p.y - 1, mw + 2, mh + 2)
    ctx.strokeStyle = getTheme(this.opts.themeId).colors.selection
    ctx.lineWidth = 2
    ctx.strokeRect(p.x - 1, p.y - 1, mw + 2, mh + 2)
  }

  private drawPerf(): void {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.font = '10px Consolas, monospace'
    const text = `z ${this.cam.z.toFixed(2)} band ${this.lod.band} bake ${this.lastBakeMs.toFixed(1)}ms frame ${this.lastFrameMs.toFixed(1)}ms`
    const wpx = ctx.measureText(text).width
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(this.cssW - wpx - 12, this.cssH - 18, wpx + 8, 14)
    ctx.fillStyle = '#fff'
    ctx.fillText(text, this.cssW - wpx - 8, this.cssH - 8)
  }
}

import type { AtlasDb, AtlasFunction } from '../../../../shared/types'
import { buildWorld } from '../layout'
import type { FnNode, World } from '../layout'
import { SourceCache } from '../sourceCache'
import { getTheme } from '../themes'
import type { Rect } from '../types'
import { clamp, easeInOutCubic } from './anim'
import { NameBubble } from './bubbles'
import { Camera } from './camera'
import { LodState } from './lod'
import {
  fnColor,
  paintFnLabels,
  paintGround,
  paintModuleBorders,
  paintModuleLabels,
  paintTiles
} from './render/classic'
import type { PaintView } from './render/classic'
import { paintSelectedCode } from './render/code'

export interface EngineCallbacks {
  onModule: (m: string | null) => void
  onFunction: (f: AtlasFunction) => void
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

/** Function dives (click or WASD) land almost fullscreen; module fits keep a hair of margin. */
const FN_PAD = 0.08
const MOD_PAD = 0.06

const TRAVEL_KEYS: Record<string, [number, number]> = {
  w: [0, -1],
  a: [-1, 0],
  s: [0, 1],
  d: [1, 0],
  arrowup: [0, -1],
  arrowleft: [-1, 0],
  arrowdown: [0, 1],
  arrowright: [1, 0]
}

interface BakeCam {
  x: number
  y: number
  z: number
  sy: number
  vw: number
  vh: number
  ovX: number
  ovY: number
}

/** Owns the rAF loop and all mutable viewer state. React never sees a frame.
 *  Two layers: a baked base bitmap (tiles, borders, labels) re-baked only when
 *  the camera settles or data/options change, blitted with a delta transform
 *  while the camera flies; and a dynamic pass (bubbles, selection, minimap)
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
  private lastBakeMs = 0
  private lastFrameMs = 0
  private restX = 0
  private restY = 0
  private restSince = 0
  private pendingBubble = false
  private lastEmittedModule: string | null = null
  private travelAnim: { from: Rect; to: Rect; t0: number; dur: number } | null = null
  private lastTravelAt = 0
  /** What the camera is currently flying toward - re-issued after a rebuild so
   *  panel reflows mid-flight can never strand the camera partway there. */
  private flightTarget: { kind: 'fn'; id: string } | { kind: 'mod'; name: string } | { kind: 'fit' } | null = null
  private worldGen = 0
  private miniBase: HTMLCanvasElement | null = null
  private miniKey = ''
  private miniRect: Rect | null = null
  private readonly sources = new SourceCache()

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
    this.sources.onReady = () => {
      this.needBake = true
      this.wake()
    }
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
    if (this.world) {
      // NEVER relayout on panel changes - the world is frozen once built, so
      // tiles cannot shift or resize mid-interaction. Only the viewport,
      // zoom clamps, and LOD thresholds re-derive; flights keep flying.
      this.lod.compute(this.world, cssW, cssH)
      this.cam.setWorld(this.world.w, this.world.h, this.lod.zMax())
      this.needBake = true
      this.invalidate()
    } else {
      this.rebuild()
    }
  }

  setData(db: AtlasDb): void {
    if (this.db !== db) this.sources.clear()
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

  /** Click in canvas CSS coordinates: minimap clicks jump; otherwise the click
   *  IS the dive - select the function under the cursor at ANY zoom and fly to
   *  fit it almost fullscreen (re-clicking the selected one never
   *  toggle-deselects; Esc/detail-X handle backing out). */
  click(cssX: number, cssY: number): void {
    if (!this.world) return
    const now = performance.now()
    const mini = this.miniRect
    if (mini && cssX >= mini.x && cssX <= mini.x + mini.w && cssY >= mini.y && cssY <= mini.y + mini.h) {
      this.centerFromMini(cssX, cssY, false)
      return
    }
    const p = this.cam.screenToWorld(cssX, cssY)
    const fn = this.world.hitFn(p.x, p.y)
    if (fn) {
      const prevIx = this.opts.selectedId != null ? this.world.byId.get(this.opts.selectedId) : undefined
      if (fn.f.id !== this.opts.selectedId) {
        this.lastEmittedModule = fn.f.module // pre-acknowledge the moduleFilter echo
        this.cb.onFunction(fn.f)
      }
      this.sources.request(fn.f) // prefetch so the text is ready when the dive lands
      this.flightTarget = { kind: 'fn', id: fn.f.id }
      const dur = this.cam.flyToRect(fn, FN_PAD, now)
      const from = prevIx != null ? this.world.fns[prevIx] : fn
      this.travelAnim = {
        from: { x: from.x, y: from.y, w: from.w, h: from.h },
        to: { x: fn.x, y: fn.y, w: fn.w, h: fn.h },
        t0: now,
        dur
      }
      this.wake()
      return
    }
    const mod = this.world.hitMod(p.x, p.y)
    if (mod) this.cb.onModule(this.opts.moduleFilter === mod.module ? null : mod.module)
  }

  /** Pointer position in canvas CSS coordinates. Feeds the hover lift + bubbles. */
  pointerMove(cssX: number, cssY: number): void {
    const now = performance.now()
    const pt = this.pointer
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

  /** Drag router: a drag that STARTED on the minimap scrubs the camera there;
   *  anywhere else it pans the world. */
  drag(originX: number, originY: number, curX: number, curY: number, dxCss: number, dyCss: number): void {
    const r = this.miniRect
    if (r && originX >= r.x && originX <= r.x + r.w && originY >= r.y && originY <= r.y + r.h) {
      this.centerFromMini(curX, curY, true)
      return
    }
    this.panBy(dxCss, dyCss)
  }

  wheel(cssX: number, cssY: number, deltaY: number): void {
    this.flightTarget = null
    this.cam.wheelZoomAt(cssX, cssY, deltaY, performance.now())
    this.bubble.hide(performance.now())
    this.wake()
  }

  panBy(dxCss: number, dyCss: number): void {
    const now = performance.now()
    this.flightTarget = null
    this.cam.panBy(dxCss, dyCss, now)
    this.bubble.hide(now)
    this.wake()
  }

  /** Returns true when the key was consumed. */
  key(k: string): boolean {
    if (k === 'Escape') return this.escapeOut()
    const dir = TRAVEL_KEYS[k.toLowerCase()]
    if (dir && this.lod.band >= 2) return this.travel(dir[0], dir[1])
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
        this.flightTarget = { kind: 'mod', name: dom.module }
        this.cam.flyToRect(dom, MOD_PAD, now)
        this.wake()
        return true
      }
    }
    if (this.lod.band >= 2) {
      this.flightTarget = { kind: 'fit' }
      this.cam.flyToRect({ x: 0, y: 0, w: this.world.w, h: this.world.h }, 0, now)
      this.wake()
      return true
    }
    return false
  }

  /** WASD/arrow travel at band 3: pick the best-aligned neighbor, select it, and
   *  fly the camera while the selection bubble tweens over on the same clock. */
  private travel(dx: number, dy: number): boolean {
    if (!this.world) return false
    const now = performance.now()
    if (now - this.lastTravelAt < 160) return true
    const cur = this.travelNode()
    if (!cur) return false
    const hasSel = !!this.opts.selectedId && this.world.byId.has(this.opts.selectedId)
    const target = hasSel ? this.pickNeighbor(cur, dx, dy) : cur
    if (!target || (hasSel && target === cur)) return true
    this.lastTravelAt = now
    if (target.f.id !== this.opts.selectedId) {
      this.lastEmittedModule = target.f.module // pre-acknowledge the moduleFilter echo
      this.cb.onFunction(target.f)
    }
    this.sources.request(target.f)
    this.flightTarget = { kind: 'fn', id: target.f.id }
    const dur = this.cam.flyToRect(target, FN_PAD, now)
    this.travelAnim = {
      from: { x: cur.x, y: cur.y, w: cur.w, h: cur.h },
      to: { x: target.x, y: target.y, w: target.w, h: target.h },
      t0: now,
      dur
    }
    this.wake()
    return true
  }

  /** The function the travel bubble sits on: the selection when it exists, else
   *  whatever is nearest the camera center. */
  private travelNode(): FnNode | null {
    if (!this.world) return null
    if (this.opts.selectedId) {
      const ix = this.world.byId.get(this.opts.selectedId)
      if (ix != null) return this.world.fns[ix]
    }
    const hit = this.world.hitFn(this.cam.x, this.cam.y)
    if (hit) return hit
    const r = 80 / this.cam.z
    const out: number[] = []
    this.world.query({ x: this.cam.x - r, y: this.cam.y - r, w: r * 2, h: r * 2 }, out)
    let best: FnNode | null = null
    let bd = Infinity
    for (const i of out) {
      const n = this.world.fns[i]
      const d = Math.hypot(n.x + n.w / 2 - this.cam.x, n.y + n.h / 2 - this.cam.y)
      if (d < bd) {
        bd = d
        best = n
      }
    }
    return best
  }

  /** Directional pick: distance penalized by misalignment; same module first,
   *  the whole world once the module edge runs out. */
  private pickNeighbor(cur: FnNode, dx: number, dy: number): FnNode | null {
    const world = this.world
    if (!world) return null
    const cx = cur.x + cur.w / 2
    const cy = cur.y + cur.h / 2
    const pick = (sameModule: boolean): FnNode | null => {
      let best: FnNode | null = null
      let bs = Infinity
      for (const n of world.fns) {
        if (n === cur) continue
        if (sameModule && n.modIx !== cur.modIx) continue
        const vx = n.x + n.w / 2 - cx
        const vy = n.y + n.h / 2 - cy
        const dot = vx * dx + vy * dy
        if (dot <= 0) continue
        const dist = Math.hypot(vx, vy)
        if (dist < 1e-6) continue
        const score = dist * (1 + 2 * (1 - dot / dist))
        if (score < bs) {
          bs = score
          best = n
        }
      }
      return best
    }
    return pick(true) ?? pick(false)
  }

  private externalFocus(m: string | null): void {
    if (!this.world) return
    const now = performance.now()
    if (m) {
      const mod = this.world.mods.find((x) => x.module === m)
      if (!mod) return
      const dom = this.world.hitMod(this.cam.x, this.cam.y)
      if (this.lod.band >= 2 && dom && dom.module === m) return
      this.flightTarget = { kind: 'mod', name: m }
      this.cam.flyToRect(mod, MOD_PAD, now)
    } else if (this.lod.band > 1) {
      this.flightTarget = { kind: 'fit' }
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

  /** Jump/scrub the camera to a minimap position (keeps the current zoom). */
  private centerFromMini(cssX: number, cssY: number, scrub: boolean): void {
    const r = this.miniRect
    if (!r || !this.world) return
    const wx = clamp((cssX - r.x) / r.w, 0, 1) * this.world.w
    const wy = clamp((cssY - r.y) / r.h, 0, 1) * this.world.h
    this.flightTarget = null
    this.bubble.hide(performance.now())
    if (scrub) {
      this.cam.jumpTo(wx, wy, this.cam.z)
      this.cam.panBy(0, 0, performance.now()) // mark as nudged so bakes wait for release
    } else {
      const vr = this.cam.viewRect()
      this.cam.flyToRect({ x: wx - vr.w / 2, y: wy - vr.h / 2, w: vr.w, h: vr.h }, 0, performance.now())
    }
    this.wake()
  }

  private rebuild(): void {
    if (!this.db || this.cssW <= 0 || this.cssH <= 0) return
    const prev = this.world
    // capture BEFORE setWorld: relative center + zoom-above-fit. Panel reflows
    // (detail bar / toolbar chip appearing) and data refreshes must never yank
    // the camera - restore exactly where the user was, just re-projected.
    const relX = prev ? this.cam.x / prev.w : 0.5
    const relY = prev ? this.cam.y / prev.h : 0.5
    const relZ = prev ? this.cam.z / this.cam.fitZ : 1
    this.world = buildWorld(this.db, this.cssW, this.cssH)
    this.worldGen++
    this.lod.compute(this.world, this.cssW, this.cssH)
    this.cam.setWorld(this.world.w, this.world.h, this.lod.zMax())
    this.travelAnim = null // old-world coordinates would strand the ring
    if (prev) {
      this.cam.jumpTo(relX * this.world.w, relY * this.world.h, relZ * this.cam.fitZ)
      this.resumeFlight()
    } else {
      this.cam.fitWorld()
    }
    this.lod.update(this.cam.z)
    this.needBake = true
    this.invalidate()
  }

  /** jumpTo (the rebuild restore) cancels any tween - re-issue the interrupted
   *  flight toward the same target, resolved against the fresh layout. */
  private resumeFlight(): void {
    const t = this.flightTarget
    if (!t || !this.world) return
    const now = performance.now()
    if (t.kind === 'fn') {
      const ix = this.world.byId.get(t.id)
      if (ix == null) return
      const n = this.world.fns[ix]
      this.cam.flyToRect(n, FN_PAD, now)
      if (this.travelAnim) this.travelAnim.to = { x: n.x, y: n.y, w: n.w, h: n.h }
    } else if (t.kind === 'mod') {
      const mod = this.world.mods.find((m) => m.module === t.name)
      if (mod) this.cam.flyToRect(mod, MOD_PAD, now)
    } else {
      this.cam.flyToRect({ x: 0, y: 0, w: this.world.w, h: this.world.h }, 0, now)
    }
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
    return !!b && b.x === this.cam.x && b.y === this.cam.y && b.z === this.cam.z && b.sy === this.cam.sy
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
    const zy = cam.z * cam.sy
    const vr = cam.viewRect()
    const view = {
      x: vr.x - ovX / cam.z,
      y: vr.y - ovY / zy,
      w: vr.w + (2 * ovX) / cam.z,
      h: vr.h + (2 * ovY) / zy
    }
    const v = this.paintView()
    c.setTransform(
      dpr * cam.z,
      0,
      0,
      dpr * zy,
      dpr * (ovX + cam.vw / 2 - cam.x * cam.z),
      dpr * (ovY + cam.vh / 2 - cam.y * zy)
    )
    paintGround(c, this.world, v)
    paintTiles(c, this.world, view, v, this.scratch, 1 / cam.z)
    paintModuleBorders(c, this.world, v, 1 / cam.z)
    // labels + the selected function's text render at constant screen size
    c.setTransform(dpr, 0, 0, dpr, ovX * dpr, ovY * dpr)
    paintFnLabels(c, this.world, view, v, cam, this.scratch)
    paintModuleLabels(c, this.world, v, cam)
    paintSelectedCode(c, this.world, cam, this.sources, this.opts.selectedId)
    this.bakeCam = { x: cam.x, y: cam.y, z: cam.z, sy: cam.sy, vw: cam.vw, vh: cam.vh, ovX, ovY }
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
    const sX = cam.z / bk.z
    const sY = (cam.z * cam.sy) / (bk.z * bk.sy)
    const dx = (bk.x - cam.x) * cam.z + cam.vw / 2 - (bk.ovX + bk.vw / 2) * sX
    const dy = (bk.y - cam.y) * cam.z * cam.sy + cam.vh / 2 - (bk.ovY + bk.vh / 2) * sY
    ctx.drawImage(this.base, dx, dy, (bk.vw + 2 * bk.ovX) * sX, (bk.vh + 2 * bk.ovY) * sY)
  }

  private frame(): void {
    if (this.disposed) return
    const now = performance.now()
    const { ctx, canvas } = this
    if (!this.world) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    const camMoving = this.cam.update(now)
    if (this.flightTarget && !this.cam.flying) this.flightTarget = null
    const band = this.lod.update(this.cam.z)
    const settled = this.cam.settled(now)
    if (settled && (this.needBake || !this.bakeMatches())) this.bake()
    this.updateHover(now, settled)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    this.blitBase()
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.bubble.draw(ctx, this.cam, now)
    this.drawSelection(now)
    this.drawMinimap()
    this.emitFocus(settled, band)
    this.lastFrameMs = performance.now() - now
    if (window.chaosPerf) this.drawPerf()
    // keep frames coming only while something is alive; otherwise the loop sleeps
    if (
      camMoving ||
      !settled ||
      this.bubble.needsFrame(now) ||
      this.pendingBubble ||
      this.travelAnim
    ) {
      this.wake()
    }
  }

  /** Minimap (shown once zoomed past the overview): whole-world mosaic top-right
   *  with the current viewport outlined. Click jumps, dragging scrubs. The base
   *  re-renders only when the world/theme/coloring/size changes. */
  private drawMinimap(): void {
    const { world, cam, ctx } = this
    if (!world || this.lod.band < 2) {
      this.miniRect = null
      return
    }
    const margin = 14
    let w = clamp(this.cssW * 0.22, 120, 220)
    let h = Math.round((w * world.h) / world.w)
    const maxH = this.cssH * 0.32
    if (h > maxH) {
      h = Math.round(maxH)
      w = Math.round((h * world.w) / world.h)
    }
    const r = { x: this.cssW - w - margin, y: margin, w, h }
    this.miniRect = r
    const key = `${this.worldGen}|${this.opts.themeId}|${this.opts.colorBy}|${this.opts.showNearMiss}|${w}x${h}|${this.dpr}`
    if (key !== this.miniKey || !this.miniBase) {
      this.miniKey = key
      const base = this.miniBase ?? document.createElement('canvas')
      base.width = Math.max(1, Math.round(w * this.dpr))
      base.height = Math.max(1, Math.round(h * this.dpr))
      const g = base.getContext('2d')
      if (g) {
        const v = this.paintView()
        g.setTransform(base.width / world.w, 0, 0, base.height / world.h, 0, 0)
        g.fillStyle = v.theme.colors.ground
        g.fillRect(0, 0, world.w, world.h)
        for (const n of world.fns) {
          g.fillStyle = fnColor(n.f, v)
          g.fillRect(n.x, n.y, n.w, n.h)
        }
        g.strokeStyle = 'rgba(20,20,20,0.6)'
        g.lineWidth = world.w / base.width
        for (const m of world.mods) g.strokeRect(m.x, m.y, m.w, m.h)
      }
      this.miniBase = base
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.beginPath()
    ctx.roundRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8, 8)
    ctx.fillStyle = 'rgba(15,20,26,0.55)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    if (this.miniBase) ctx.drawImage(this.miniBase, r.x, r.y, r.w, r.h)
    const vr = cam.viewRect()
    const mx = r.x + clamp(vr.x / world.w, 0, 1) * r.w
    const my = r.y + clamp(vr.y / world.h, 0, 1) * r.h
    const mw = Math.max(6, Math.min(r.w, (vr.w / world.w) * r.w))
    const mh = Math.max(6, Math.min(r.h, (vr.h / world.h) * r.h))
    ctx.strokeStyle = 'rgba(10,12,14,0.8)'
    ctx.lineWidth = 3
    ctx.strokeRect(Math.min(mx, r.x + r.w - mw), Math.min(my, r.y + r.h - mh), mw, mh)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.strokeRect(Math.min(mx, r.x + r.w - mw), Math.min(my, r.y + r.h - mh), mw, mh)
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

  /** Bubble intent: the cursor must rest ~90ms (within a 4px jitter box) over a
   *  function before its name pops - band 2+ only, nothing at the overview. */
  private updateHover(now: number, settled: boolean): void {
    this.pendingBubble = false
    if (!this.world || !this.pointer.inside || !settled || this.lod.band < 2) {
      this.bubble.hide(now)
      return
    }
    const mini = this.miniRect
    if (
      mini &&
      this.pointer.x >= mini.x &&
      this.pointer.x <= mini.x + mini.w &&
      this.pointer.y >= mini.y &&
      this.pointer.y <= mini.y + mini.h
    ) {
      this.bubble.hide(now)
      return
    }
    const p = this.cam.screenToWorld(this.pointer.x, this.pointer.y)
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

  /** Selection bubble: double-stroke rounded outline. During travel the rect
   *  tweens from the previous function on the camera flight's clock. */
  private drawSelection(now: number): void {
    const { world } = this
    if (!world) return
    let rx: number
    let ry: number
    let rw: number
    let rh: number
    const ta = this.travelAnim
    if (ta) {
      const t = clamp((now - ta.t0) / ta.dur, 0, 1)
      const e = easeInOutCubic(t)
      rx = ta.from.x + (ta.to.x - ta.from.x) * e
      ry = ta.from.y + (ta.to.y - ta.from.y) * e
      rw = ta.from.w + (ta.to.w - ta.from.w) * e
      rh = ta.from.h + (ta.to.h - ta.from.h) * e
      if (t >= 1) this.travelAnim = null
    } else {
      const id = this.opts.selectedId
      if (!id) return
      const ix = world.byId.get(id)
      if (ix == null) return
      const n = world.fns[ix]
      rx = n.x
      ry = n.y
      rw = n.w
      rh = n.h
    }
    const { ctx, cam } = this
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const p = cam.worldToScreen(rx, ry)
    const mw = Math.max(rw * cam.z, 5)
    const mh = Math.max(rh * cam.z * cam.sy, 5)
    const rad = Math.max(2, Math.min(9, mw / 4, mh / 4))
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.roundRect(p.x - 1, p.y - 1, mw + 2, mh + 2, rad)
    ctx.stroke()
    ctx.strokeStyle = getTheme(this.opts.themeId).colors.selection
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(p.x - 1, p.y - 1, mw + 2, mh + 2, rad)
    ctx.stroke()
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

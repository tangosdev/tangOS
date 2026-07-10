import type { AtlasDb, AtlasFunction } from '../../../../shared/types'
import { buildWorld } from '../layout'
import type { FnNode, World } from '../layout'
import { SourceCache } from '../sourceCache'
import { getTheme } from '../themes'
import { TILE_PX } from '../themes/types'
import type { Rect } from '../types'
import { clamp, easeInOutCubic, mulberry32, smoothstep } from './anim'
import { NameBubble } from './bubbles'
import { Camera } from './camera'
import { LodState } from './lod'
import { RippleField, rippleBounds, rippleLift } from './ripple'
import { paintBoard } from './render/board'
import type { BoardPaint } from './render/board'
import {
  fnColor,
  isDimmed,
  paintFnLabels,
  paintModuleBorders,
  paintModuleLabels,
  paintTiles
} from './render/classic'
import type { PaintView } from './render/classic'
import { paintCode } from './render/code'

export interface EngineCallbacks {
  onModule: (m: string | null) => void
  onFunction: (f: AtlasFunction) => void
  onBand?: (band: 1 | 2 | 3) => void
  onBoard?: (on: boolean) => void
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
  private readonly sources = new SourceCache()
  private travelAnim: { from: Rect; to: Rect; t0: number; dur: number } | null = null
  private lastTravelAt = 0
  /** What the camera is currently flying toward - re-issued after a rebuild so
   *  panel reflows mid-flight can never strand the camera partway there. */
  private flightTarget: { kind: 'fn'; id: string } | { kind: 'mod'; name: string } | { kind: 'fit' } | null = null
  private board = false
  private cloud: { t0: number; dur: number; dir: 1 | -1; switched: boolean } | null = null
  private camBeforeBoard: { x: number; y: number; z: number } | null = null
  private boardCell = 2
  private atlasImg: CanvasImageSource | null = null
  private atlasTheme = ''
  private cloudSprites: HTMLCanvasElement[] | null = null
  private shadowSprite: HTMLCanvasElement | null = null
  private wakeTimer: ReturnType<typeof setTimeout> | null = null

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
    if (next.themeId && next.themeId !== prev.themeId) this.ensureAtlas()
    if ('moduleFilter' in next && next.moduleFilter !== prev.moduleFilter) {
      // externally requested focus (toolbar chip, list selection, detail-bar close)
      if (this.opts.moduleFilter !== this.lastEmittedModule) this.externalFocus(this.opts.moduleFilter)
      this.lastEmittedModule = this.opts.moduleFilter
    }
    this.invalidate()
  }

  /** Click in canvas CSS coordinates. Band 1: fly into the module. Band 2+:
   *  the click IS the dive - select the function and fly to fit it (re-clicking
   *  the selected one never toggle-deselects; Esc/detail-X handle that). */
  click(cssX: number, cssY: number): void {
    if (!this.world) return
    const now = performance.now()
    const p = this.cam.screenToWorld(cssX, cssY)
    if (this.lod.band === 1) {
      const mod = this.world.hitMod(p.x, p.y)
      if (mod) {
        this.lastEmittedModule = mod.module
        this.cb.onModule(mod.module)
        this.flightTarget = { kind: 'mod', name: mod.module }
        this.cam.flyToRect(mod, MOD_PAD, now)
        this.wake()
      }
      return
    }
    const fn = this.world.hitFn(p.x, p.y)
    if (fn) {
      const prevIx = this.opts.selectedId != null ? this.world.byId.get(this.opts.selectedId) : undefined
      if (fn.f.id !== this.opts.selectedId) {
        this.lastEmittedModule = fn.f.module // pre-acknowledge the moduleFilter echo
        this.cb.onFunction(fn.f)
      }
      this.sources.request(fn.f)
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
    this.ripples.clear()
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

  /** Enter the Sid Meier board through the cloud layer. The theme/zoom switch
   *  happens at the fully-clouded midpoint, hidden under the cover. */
  enterBoard(): void {
    if (this.board || this.cloud || !this.world) return
    this.cloud = { t0: performance.now(), dur: 900, dir: 1, switched: false }
    this.camBeforeBoard = { x: this.cam.x, y: this.cam.y, z: this.cam.z }
    this.ensureClouds()
    this.ensureShadow()
    this.ensureAtlas()
    this.wake()
  }

  exitBoard(): void {
    if (!this.board || this.cloud) return
    this.cloud = { t0: performance.now(), dur: 900, dir: -1, switched: false }
    this.wake()
  }

  destroy(): void {
    this.disposed = true
    if (this.rafId != null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    if (this.wakeTimer != null) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
  }

  private escapeOut(): boolean {
    if (this.board || this.cloud) {
      this.exitBoard()
      return true
    }
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
    if (this.wakeTimer != null) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      this.frame()
    })
  }

  /** Low-rate wakeup for the board's idle drift - half rAF rate is plenty. */
  private wakeSoon(ms: number): void {
    if (this.disposed || this.rafId != null || this.wakeTimer != null) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.wake()
    }, ms)
  }

  private activateBoard(): void {
    if (!this.world) return
    this.board = true
    this.cb.onBoard?.(true)
    this.boardCell = Math.sqrt(Math.max(4, this.world.medianFnArea)) / 4
    this.cam.setZoomOverride(16 / this.boardCell, 64 / this.boardCell)
    this.needBake = true
  }

  private deactivateBoard(): void {
    this.board = false
    this.cb.onBoard?.(false)
    this.cam.setZoomOverride(null, null)
    if (this.camBeforeBoard) {
      this.cam.jumpTo(this.camBeforeBoard.x, this.camBeforeBoard.y, this.camBeforeBoard.z)
      this.camBeforeBoard = null
    }
    this.needBake = true
  }

  private ensureAtlas(): void {
    const theme = getTheme(this.opts.themeId)
    if (theme.mode !== 'sprite') return
    if (this.atlasTheme === theme.id && this.atlasImg) return
    const want = theme.id
    this.atlasTheme = want
    this.atlasImg = null
    theme
      .resolveAtlas()
      .then((img) => {
        if (this.atlasTheme !== want || this.disposed) return
        this.atlasImg = img
        this.needBake = true
        this.wake()
      })
      .catch(() => {})
  }

  private ensureClouds(): void {
    if (this.cloudSprites) return
    const rnd = mulberry32(0x51f0c1)
    const sprites: HTMLCanvasElement[] = []
    for (let v = 0; v < 4; v++) {
      const c = document.createElement('canvas')
      c.width = 160
      c.height = 96
      const g = c.getContext('2d')
      if (!g) continue
      const rows = 8
      for (let r = 0; r < rows; r++) {
        const k = Math.sin((Math.PI * (r + 0.5)) / rows)
        const w = Math.round((60 + rnd() * 60) * k + 30)
        const x = Math.round((160 - w) / 2 + (rnd() - 0.5) * 24)
        g.fillStyle = r >= rows - 2 ? 'rgba(214,226,238,0.95)' : 'rgba(255,255,255,0.96)'
        g.fillRect(x, 8 + r * 10, w, 10)
      }
      sprites.push(c)
    }
    this.cloudSprites = sprites
  }

  private ensureShadow(): void {
    if (this.shadowSprite) return
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 160
    const g = c.getContext('2d')
    if (!g) return
    const grad = g.createRadialGradient(128, 80, 10, 128, 80, 120)
    grad.addColorStop(0, 'rgba(20,30,40,0.14)')
    grad.addColorStop(1, 'rgba(20,30,40,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 256, 160)
    this.shadowSprite = c
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
    this.lod.compute(this.world, this.cssW, this.cssH)
    this.cam.setWorld(this.world.w, this.world.h, this.lod.zMax())
    if (this.board) {
      this.boardCell = Math.sqrt(Math.max(4, this.world.medianFnArea)) / 4
      this.cam.setZoomOverride(16 / this.boardCell, 64 / this.boardCell)
    }
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
    if (this.board) {
      const theme = getTheme(this.opts.themeId)
      const bp: BoardPaint =
        theme.mode === 'sprite'
          ? { atlas: this.atlasImg, tilePx: theme.tilePx, layout: theme.layout, cellWorld: this.boardCell }
          : { atlas: null, tilePx: TILE_PX, layout: null, cellWorld: this.boardCell }
      paintBoard(c, this.world, view, v, cam, dpr, ovX, ovY, bp, this.scratch)
      c.setTransform(dpr, 0, 0, dpr, ovX * dpr, ovY * dpr)
      paintModuleLabels(c, this.world, v, cam)
    } else {
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
      // labels + code render at constant screen size - separate passes in screen coords
      const codeVisible = this.lod.band >= 2
      c.setTransform(dpr, 0, 0, dpr, ovX * dpr, ovY * dpr)
      paintFnLabels(c, this.world, view, v, cam, this.scratch, codeVisible)
      paintModuleLabels(c, this.world, v, cam)
      if (codeVisible) paintCode(c, this.world, view, v, cam, this.sources, this.scratch)
    }
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
    if (this.flightTarget && !this.cam.flying) this.flightTarget = null
    const band = this.lod.update(this.cam.z)
    if (band !== this.lastBand) {
      this.lastBand = band
      this.cb.onBand?.(band)
    }
    if (this.cloud) {
      const tCloud = (now - this.cloud.t0) / this.cloud.dur
      if (tCloud >= 0.5 && !this.cloud.switched) {
        this.cloud.switched = true
        if (this.cloud.dir === 1) this.activateBoard()
        else this.deactivateBoard()
      }
      if (tCloud >= 1) this.cloud = null
    }
    const settled = this.cam.settled(now)
    if (settled && (this.needBake || !this.bakeMatches())) this.bake()
    const ripplesActive = this.ripples.step(now)
    this.updateHover(now, settled)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    this.blitBase()
    if (ripplesActive && band === 1 && settled && !this.board) this.drawRipples(now)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (this.board && !this.cloud) this.drawBoardShadows(now)
    this.bubble.draw(ctx, this.cam, now)
    this.drawSelection(now)
    const cloudsActive = this.drawClouds(now)
    this.emitFocus(settled, band)
    this.lastFrameMs = performance.now() - now
    if (window.chaosPerf) this.drawPerf()
    // keep frames coming only while something is alive; otherwise the loop sleeps
    // (the board's idle drift ticks at half rate through wakeSoon)
    if (
      camMoving ||
      !settled ||
      ripplesActive ||
      cloudsActive ||
      this.bubble.needsFrame(now) ||
      this.pendingBubble ||
      this.travelAnim
    ) {
      this.wake()
    } else if (this.board) {
      this.wakeSoon(33)
    }
  }

  /** Two soft cloud shadows drifting over the board - the living-map idle motion. */
  private drawBoardShadows(now: number): void {
    const s = this.shadowSprite
    if (!s) return
    const ctx = this.ctx
    const t = now / 1000
    const pts = [
      { x: this.cssW * (0.32 + 0.26 * Math.sin(t * 0.05)), y: this.cssH * (0.35 + 0.22 * Math.cos(t * 0.041)) },
      { x: this.cssW * (0.66 + 0.24 * Math.cos(t * 0.037)), y: this.cssH * (0.62 + 0.24 * Math.sin(t * 0.047)) }
    ]
    for (const p of pts) ctx.drawImage(s, p.x - 190, p.y - 120, 380, 240)
  }

  /** Cloud layer transition: puffs drift across while coverage ramps to a solid
   *  sheet at the midpoint (where the board switch happens), then reveals. */
  private drawClouds(now: number): boolean {
    const cl = this.cloud
    if (!cl) return false
    const t = clamp((now - cl.t0) / cl.dur, 0, 1)
    const coverage = t < 0.5 ? smoothstep(0.02, 0.45, t) : 1 - smoothstep(0.55, 0.98, t)
    const sprites = this.cloudSprites
    if (!sprites || !sprites.length) return t < 1
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const span = this.cssW + 480
    for (let i = 0; i < 14; i++) {
      const layer = i % 2
      const speed = layer ? 120 : 70
      const scale = layer ? 2.7 : 2
      const x = ((i * 331 + (now / 1000) * speed) % span) - 240
      const y = ((i * 97) % Math.max(1, this.cssH - 40)) - 30
      ctx.globalAlpha = coverage * (layer ? 0.95 : 0.8)
      ctx.drawImage(sprites[i % sprites.length], x, y, 160 * scale, 96 * scale)
    }
    const sheet = t < 0.5 ? smoothstep(0.3, 0.48, t) : 1 - smoothstep(0.52, 0.7, t)
    if (sheet > 0) {
      ctx.globalAlpha = sheet
      ctx.fillStyle = '#eef4fa'
      ctx.fillRect(0, 0, this.cssW, this.cssH)
    }
    ctx.globalAlpha = 1
    return t < 1
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
    if (!this.world || !this.pointer.inside || !settled || this.cloud) {
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
    paintFnLabels(ctx, world, view, v, cam, this.scratch, false)
    paintModuleLabels(ctx, world, v, cam)
    ctx.restore()
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
    const mh = Math.max(rh * cam.z, 5)
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

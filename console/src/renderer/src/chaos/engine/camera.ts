import { clamp, easeInOutCubic } from './anim'
import type { Pt, Rect } from '../types'

const WHEEL_FACTOR = 1.0015
const OVERSCAN = 0.15

interface Fly {
  x0: number
  y0: number
  lz0: number
  x1: number
  y1: number
  lz1: number
  t0: number
  dur: number
  dip: number
}

/** Continuous camera over the treemap world. z = screen CSS px per world unit.
 *  Wheel zoom is INSTANT (each tick applies immediately, anchored to the
 *  cursor, hard-clamped to the full-map fit); flights (click dives, Escape,
 *  external focus) tween (x, y, logZ) with a zoom dip so long pans read as
 *  "up over the terrain, then back down". */
export class Camera {
  x = 0
  y = 0
  z = 1
  /** Vertical view squash: 1 = straight down, <1 tilts the ground plane. */
  sy = 1
  vw = 1
  vh = 1
  worldW = 1
  worldH = 1
  private zMin = 0.01
  private zMax = 64
  private zOverrideMin: number | null = null
  private zOverrideMax: number | null = null
  private lastNudge = -1e9
  private fly: Fly | null = null

  get fitZ(): number {
    return Math.min(this.vw / this.worldW, this.vh / this.worldH)
  }

  get overscanX(): number {
    return Math.round(this.vw * OVERSCAN)
  }

  get overscanY(): number {
    return Math.round(this.vh * OVERSCAN)
  }

  get flying(): boolean {
    return !!this.fly
  }

  private get zLo(): number {
    return this.zOverrideMin ?? this.zMin
  }

  private get zHi(): number {
    return this.zOverrideMax ?? this.zMax
  }

  setViewport(vw: number, vh: number): void {
    this.vw = Math.max(1, vw)
    this.vh = Math.max(1, vh)
  }

  setWorld(w: number, h: number, zMax: number): void {
    this.worldW = Math.max(1, w)
    this.worldH = Math.max(1, h)
    this.zMin = this.fitZ
    this.zMax = Math.max(zMax, this.fitZ * 2)
    this.z = clamp(this.z, this.zLo, this.zHi)
    this.clampPan()
  }

  /** Pass nulls to restore the world-derived clamps. */
  setZoomOverride(min: number | null, max: number | null): void {
    this.zOverrideMin = min
    this.zOverrideMax = max
    this.fly = null
    this.z = clamp(this.z, this.zLo, this.zHi)
    this.clampPan()
  }

  jumpTo(x: number, y: number, z: number): void {
    this.fly = null
    this.z = clamp(z, this.zLo, this.zHi)
    this.x = x
    this.y = y
    this.clampPan()
  }

  fitWorld(): void {
    this.jumpToRect({ x: 0, y: 0, w: this.worldW, h: this.worldH }, 0)
  }

  jumpToRect(r: Rect, padFrac: number): void {
    const z = clamp(
      Math.min(this.vw / (r.w * (1 + 2 * padFrac)), this.vh / (r.h * (1 + 2 * padFrac) * this.sy)),
      this.zLo,
      this.zHi
    )
    this.fly = null
    this.z = z
    this.x = r.x + r.w / 2
    this.y = r.y + r.h / 2
    this.clampPan()
  }

  /** Returns the flight duration in ms so companions (selection bubble) can sync. */
  flyToRect(r: Rect, padFrac: number, now: number): number {
    const z1 = clamp(
      Math.min(this.vw / (r.w * (1 + 2 * padFrac)), this.vh / (r.h * (1 + 2 * padFrac) * this.sy)),
      this.zLo,
      this.zHi
    )
    const x1 = this.clampAxisAt(r.x + r.w / 2, this.worldW, this.vw, z1)
    const y1 = this.clampAxisAt(r.y + r.h / 2, this.worldH, this.vh, z1 * this.sy)
    const lz0 = Math.log(this.z)
    const lz1 = Math.log(z1)
    const travel = Math.hypot((x1 - this.x) * z1, (y1 - this.y) * z1 * this.sy)
    const dur = clamp(350 + 250 * Math.min(1, travel / this.vw) + 120 * Math.abs(lz1 - lz0), 350, 800)
    const panWorld = Math.hypot(x1 - this.x, y1 - this.y)
    const dip = 0.35 * Math.min(1, (panWorld * Math.min(this.z, z1)) / this.vw)
    this.fly = { x0: this.x, y0: this.y, lz0, x1, y1, lz1, t0: now, dur, dip }
    this.lastNudge = now
    return dur
  }

  /** Wheel zoom: instant, cursor-anchored, clamped - never undershoots the fit. */
  wheelZoomAt(sx: number, sy: number, deltaY: number, now: number): void {
    this.fly = null
    const w = this.screenToWorld(sx, sy)
    this.z = clamp(this.z * Math.pow(WHEEL_FACTOR, -deltaY), this.zLo, this.zHi)
    this.x = w.x - (sx - this.vw / 2) / this.z
    this.y = w.y - (sy - this.vh / 2) / (this.z * this.sy)
    this.clampPan()
    this.lastNudge = now
  }

  panBy(dxCss: number, dyCss: number, now: number): void {
    this.fly = null
    this.x -= dxCss / this.z
    this.y -= dyCss / (this.z * this.sy)
    this.clampPan()
    this.lastNudge = now
  }

  /** Advance the flight tween. Returns true while the camera is in motion. */
  update(now: number): boolean {
    if (!this.fly) return false
    const f = this.fly
    const t = clamp((now - f.t0) / f.dur, 0, 1)
    const e = easeInOutCubic(t)
    this.x = f.x0 + (f.x1 - f.x0) * e
    this.y = f.y0 + (f.y1 - f.y0) * e
    const lz = f.lz0 + (f.lz1 - f.lz0) * e - f.dip * Math.sin(Math.PI * t)
    this.z = clamp(Math.exp(lz), this.zLo, this.zHi)
    if (t >= 1) {
      this.fly = null
      this.z = clamp(Math.exp(f.lz1), this.zLo, this.zHi)
    }
    this.clampPan()
    return true
  }

  settled(now: number): boolean {
    return !this.fly && now - this.lastNudge > 90
  }

  worldToScreen(wx: number, wy: number): Pt {
    return {
      x: (wx - this.x) * this.z + this.vw / 2,
      y: (wy - this.y) * this.z * this.sy + this.vh / 2
    }
  }

  screenToWorld(sx: number, syPx: number): Pt {
    return {
      x: (sx - this.vw / 2) / this.z + this.x,
      y: (syPx - this.vh / 2) / (this.z * this.sy) + this.y
    }
  }

  viewRect(): Rect {
    return {
      x: this.x - this.vw / 2 / this.z,
      y: this.y - this.vh / 2 / (this.z * this.sy),
      w: this.vw / this.z,
      h: this.vh / (this.z * this.sy)
    }
  }

  private clampAxisAt(c: number, world: number, view: number, z: number): number {
    const half = view / 2 / z
    if (world * z <= view) return world / 2
    return clamp(c, half, world - half)
  }

  private clampPan(): void {
    this.x = this.clampAxisAt(this.x, this.worldW, this.vw, this.z)
    this.y = this.clampAxisAt(this.y, this.worldH, this.vh, this.z * this.sy)
  }
}

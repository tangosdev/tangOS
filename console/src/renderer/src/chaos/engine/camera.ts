import { clamp, easeInOutCubic } from './anim'
import type { Pt, Rect } from '../types'

const WHEEL_FACTOR = 1.0015
const GESTURE_MS = 150
const SPRING_OMEGA = 14
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
 *  Wheel zoom eases toward a target with the world point under the cursor held
 *  fixed; flights tween (x, y, logZ) with a zoom dip so long pans read as
 *  "up over the terrain, then back down". */
export class Camera {
  x = 0
  y = 0
  z = 1
  vw = 1
  vh = 1
  worldW = 1
  worldH = 1
  private zMin = 0.01
  private zMax = 64
  private zTarget = 1
  private zVel = 0
  private anchorWX = 0
  private anchorWY = 0
  private anchorSX = 0
  private anchorSY = 0
  private gestureUntil = -1e9
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

  setViewport(vw: number, vh: number): void {
    this.vw = Math.max(1, vw)
    this.vh = Math.max(1, vh)
  }

  setWorld(w: number, h: number, zMax: number): void {
    this.worldW = Math.max(1, w)
    this.worldH = Math.max(1, h)
    this.zMin = this.fitZ
    this.zMax = Math.max(zMax, this.fitZ * 2)
    this.z = clamp(this.z, this.zMin, this.zMax)
    this.zTarget = clamp(this.zTarget, this.zMin, this.zMax)
    this.clampPan()
  }

  fitWorld(): void {
    this.jumpToRect({ x: 0, y: 0, w: this.worldW, h: this.worldH }, 0)
  }

  jumpToRect(r: Rect, padFrac: number): void {
    const z = clamp(
      Math.min(this.vw / (r.w * (1 + 2 * padFrac)), this.vh / (r.h * (1 + 2 * padFrac))),
      this.zMin,
      this.zMax
    )
    this.fly = null
    this.z = z
    this.zTarget = z
    this.zVel = 0
    this.x = r.x + r.w / 2
    this.y = r.y + r.h / 2
    this.clampPan()
  }

  flyToRect(r: Rect, padFrac: number, now: number): void {
    const z1 = clamp(
      Math.min(this.vw / (r.w * (1 + 2 * padFrac)), this.vh / (r.h * (1 + 2 * padFrac))),
      this.zMin,
      this.zMax
    )
    const x1 = this.clampAxisAt(r.x + r.w / 2, this.worldW, this.vw, z1)
    const y1 = this.clampAxisAt(r.y + r.h / 2, this.worldH, this.vh, z1)
    const lz0 = Math.log(this.z)
    const lz1 = Math.log(z1)
    const travel = Math.hypot((x1 - this.x) * z1, (y1 - this.y) * z1)
    const dur = clamp(350 + 250 * Math.min(1, travel / this.vw) + 120 * Math.abs(lz1 - lz0), 350, 800)
    const panWorld = Math.hypot(x1 - this.x, y1 - this.y)
    const dip = 0.35 * Math.min(1, (panWorld * Math.min(this.z, z1)) / this.vw)
    this.fly = { x0: this.x, y0: this.y, lz0, x1, y1, lz1, t0: now, dur, dip }
    this.zTarget = z1
    this.zVel = 0
    this.lastNudge = now
  }

  wheelZoomAt(sx: number, sy: number, deltaY: number, now: number): void {
    this.fly = null
    this.zTarget = clamp(this.zTarget * Math.pow(WHEEL_FACTOR, -deltaY), this.zMin, this.zMax)
    if (now > this.gestureUntil || Math.hypot(sx - this.anchorSX, sy - this.anchorSY) > 3) {
      const w = this.screenToWorld(sx, sy)
      this.anchorWX = w.x
      this.anchorWY = w.y
    }
    this.anchorSX = sx
    this.anchorSY = sy
    this.gestureUntil = now + GESTURE_MS
    this.lastNudge = now
  }

  panBy(dxCss: number, dyCss: number, now: number): void {
    this.fly = null
    this.x -= dxCss / this.z
    this.y -= dyCss / this.z
    this.clampPan()
    this.lastNudge = now
  }

  /** Advance springs/tweens. Returns true while the camera is in motion. */
  update(dt: number, now: number): boolean {
    if (this.fly) {
      const f = this.fly
      const t = clamp((now - f.t0) / f.dur, 0, 1)
      const e = easeInOutCubic(t)
      this.x = f.x0 + (f.x1 - f.x0) * e
      this.y = f.y0 + (f.y1 - f.y0) * e
      const lz = f.lz0 + (f.lz1 - f.lz0) * e - f.dip * Math.sin(Math.PI * t)
      this.z = Math.exp(lz)
      if (t >= 1) {
        this.fly = null
        this.z = Math.exp(f.lz1)
        this.zTarget = this.z
        this.zVel = 0
      }
      this.clampPan()
      return true
    }
    const dz = this.zTarget - this.z
    if (Math.abs(dz) > this.z * 5e-4 || Math.abs(this.zVel) > this.z * 5e-4) {
      const a = SPRING_OMEGA * SPRING_OMEGA * dz - 2 * SPRING_OMEGA * this.zVel
      this.zVel += a * dt
      this.z += this.zVel * dt
      if (Math.abs(this.zTarget - this.z) < this.z * 5e-4 && Math.abs(this.zVel) < this.z * 5e-4) {
        this.z = this.zTarget
        this.zVel = 0
      }
      if (now < this.gestureUntil + 400) {
        this.x = this.anchorWX - (this.anchorSX - this.vw / 2) / this.z
        this.y = this.anchorWY - (this.anchorSY - this.vh / 2) / this.z
      }
      this.clampPan()
      return true
    }
    return false
  }

  settled(now: number): boolean {
    return (
      !this.fly &&
      Math.abs(this.zTarget - this.z) < this.z * 1e-3 &&
      Math.abs(this.zVel) < this.z * 1e-3 &&
      now - this.lastNudge > 90
    )
  }

  worldToScreen(wx: number, wy: number): Pt {
    return { x: (wx - this.x) * this.z + this.vw / 2, y: (wy - this.y) * this.z + this.vh / 2 }
  }

  screenToWorld(sx: number, sy: number): Pt {
    return { x: (sx - this.vw / 2) / this.z + this.x, y: (sy - this.vh / 2) / this.z + this.y }
  }

  viewRect(): Rect {
    return {
      x: this.x - this.vw / 2 / this.z,
      y: this.y - this.vh / 2 / this.z,
      w: this.vw / this.z,
      h: this.vh / this.z
    }
  }

  private clampAxisAt(c: number, world: number, view: number, z: number): number {
    const half = view / 2 / z
    if (world * z <= view) return world / 2
    return clamp(c, half, world - half)
  }

  private clampPan(): void {
    this.x = this.clampAxisAt(this.x, this.worldW, this.vw, this.z)
    this.y = this.clampAxisAt(this.y, this.worldH, this.vh, this.z)
  }
}

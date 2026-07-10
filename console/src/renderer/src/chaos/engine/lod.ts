import type { World } from '../layout'

/** Zoom bands: 1 "continents" (whole map), 2 "states" (inside a module),
 *  3 "streets" (a handful of functions, code visible). Thresholds are derived
 *  from real median tile sizes so bands land where content is readable, with
 *  15% multiplicative hysteresis on the way down so they never thrash. */
export class LodState {
  band: 1 | 2 | 3 = 1
  private z12 = Infinity
  private z23 = Infinity

  compute(world: World, vw: number, vh: number): void {
    const fit = Math.min(vw / world.w, vh / world.h)
    const area = vw * vh
    this.z12 = Math.max(Math.sqrt(area / (1.8 * Math.max(1, world.medianModArea))), fit * 1.6)
    this.z23 = Math.max(Math.sqrt(area / (5.5 * Math.max(1, world.medianFnArea))), this.z12 * 1.8)
  }

  zMax(): number {
    return this.z23 * 12
  }

  update(z: number): 1 | 2 | 3 {
    if (this.band === 1) {
      if (z >= this.z23) this.band = 3
      else if (z >= this.z12) this.band = 2
    } else if (this.band === 2) {
      if (z >= this.z23) this.band = 3
      else if (z < this.z12 / 1.15) this.band = 1
    } else {
      if (z < this.z12 / 1.15) this.band = 1
      else if (z < this.z23 / 1.15) this.band = 2
    }
    return this.band
  }
}

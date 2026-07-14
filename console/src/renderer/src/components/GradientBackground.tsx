import { useEffect, useRef } from 'react'
import { resolvePalette, type GradientPalette, type MotionMode } from './gradientThemes'

/* Full-bleed animated background: drifting blurred color blobs (a mesh-gradient look)
 * with soft CSS-glass bubbles floating in front. Ported from the gradient-lab reference
 * (assets/gradient-background/gradient-lab.reference.html) into a self-contained engine.
 *
 * Work-app adjustments vs. the lab: motion speeds are capped calm (CALM_*), the loop
 * pauses while the window is hidden, and prefers-reduced-motion renders it static. The
 * engine mutates element styles directly each frame (never React state) so the rAF loop
 * stays cheap; React only owns the two container divs. */

const TAU = Math.PI * 2
const FLOW = 10 // base travel speed (%/sec) for scroll modes
const MARGIN = 10 // keep blob centers within [MARGIN, 100-MARGIN]
const SCROLL = new Set<MotionMode>(['leftright', 'rightleft', 'falling', 'rising'])
// Calm-motion caps: the lab palettes run up to 1.72; a background behind live panels
// should drift, not race. Speeds are clamped to these before driving the loop.
const CALM_GRAD = 0.35
const CALM_BUB = 0.5
const BUBBLE_COUNT = 3
const PUSH = 0.035 // fraction of an overlap corrected per frame (soft separation)

const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const clampPct = (v: number, m: number): number => Math.max(m, Math.min(100 - m, v))
const wrapPct = (v: number): number => (((v + 20) % 140) + 140) % 140 - 20 // wrap through [-20,120)

interface Mover {
  bx: number
  by: number
  ax: number
  ay: number
  fx: number
  fy: number
  ph: number
  spd: number
  R: number
  vx: number
  vy: number
  lx: number
  ly: number
  rx: number
  ry: number
  color?: string
  rot?: number
  el?: HTMLDivElement
  ghosts?: HTMLDivElement[]
}

function makeMover(): Mover {
  const bx = rand(12, 88)
  const by = rand(15, 85)
  return {
    bx,
    by,
    ax: rand(6, 16),
    ay: rand(6, 16),
    fx: rand(0.5, 1.3),
    fy: rand(0.5, 1.3),
    ph: rand(0, TAU),
    spd: rand(0.6, 1.4),
    R: rand(18, 40),
    vx: rand(-1, 1),
    vy: rand(-1, 1),
    lx: bx,
    ly: by,
    rx: bx,
    ry: by
  }
}

function makeStopAt(color: string, x: number, y: number): Mover {
  const m = makeMover()
  m.color = color
  m.bx = m.rx = m.lx = x
  m.by = m.ry = m.ly = y
  return m
}

// motion engine: returns the target {x,y} in % of the stage for a mover in a given mode
function motion(o: Mover, mode: MotionMode, tt: number, ds: number): { x: number; y: number } {
  switch (mode) {
    case 'random':
      return {
        x: o.bx + o.ax * (Math.sin(tt * o.fx + o.ph) + 0.6 * Math.sin(tt * o.fx * 2.7 + o.ph * 1.7)),
        y: o.by + o.ay * (Math.cos(tt * o.fy + o.ph) + 0.6 * Math.cos(tt * o.fy * 2.3 + o.ph * 1.3))
      }
    case 'leftright':
      o.lx = wrapPct(o.lx + FLOW * ds * o.spd)
      return { x: o.lx, y: o.by + o.ay * 0.35 * Math.sin(tt * o.fy + o.ph) }
    case 'rightleft':
      o.lx = wrapPct(o.lx - FLOW * ds * o.spd)
      return { x: o.lx, y: o.by + o.ay * 0.35 * Math.sin(tt * o.fy + o.ph) }
    case 'falling':
      o.ly = wrapPct(o.ly + FLOW * ds * o.spd)
      return { x: o.bx + o.ax * 0.35 * Math.sin(tt * o.fx + o.ph), y: o.ly }
    case 'rising':
      o.ly = wrapPct(o.ly - FLOW * ds * o.spd)
      return { x: o.bx + o.ax * 0.35 * Math.sin(tt * o.fx + o.ph), y: o.ly }
    case 'orbit': {
      const a = tt * o.spd * 0.6 + o.ph
      const Rx = Math.min(o.R, 36)
      const Ry = Math.min(o.R * 0.62, 36)
      return { x: 50 + Rx * Math.cos(a), y: 50 + Ry * Math.sin(a) }
    }
    case 'swirl': {
      const a = tt * o.spd * 0.7 + o.ph
      const R = o.R + 8 * Math.sin(tt * 0.5 + o.ph)
      const Rx = Math.min(R, 36)
      const Ry = Math.min(R * 0.62, 36)
      return { x: 50 + Rx * Math.cos(a), y: 50 + Ry * Math.sin(a) }
    }
    case 'bounce': {
      const m = Math.hypot(o.vx, o.vy) || 1
      o.lx += (o.vx / m) * FLOW * ds * o.spd
      o.ly += (o.vy / m) * FLOW * ds * o.spd
      if (o.lx < -12 || o.lx > 112) o.vx *= -1
      if (o.ly < -12 || o.ly > 112) o.vy *= -1
      o.lx = Math.max(-12, Math.min(112, o.lx))
      o.ly = Math.max(-12, Math.min(112, o.ly))
      return { x: o.lx, y: o.ly }
    }
    case 'drift':
    default:
      return { x: o.bx + o.ax * Math.sin(tt * o.fx + o.ph), y: o.by + o.ay * Math.cos(tt * o.fy + o.ph) }
  }
}

// spread home positions apart so each blob gets its own territory
function spaceHomes(list: Mover[], minSpace: number): void {
  for (let k = 0; k < 14; k++)
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        let dx = b.bx - a.bx
        let dy = b.by - a.by
        let d = Math.hypot(dx, dy)
        if (d < 0.001) {
          dx = rand(-1, 1)
          dy = rand(-1, 1)
          d = Math.hypot(dx, dy) || 1
        }
        if (d < minSpace) {
          const p = (minSpace - d) / 2
          const nx = dx / d
          const ny = dy / d
          a.bx -= nx * p
          a.by -= ny * p
          b.bx += nx * p
          b.by += ny * p
        }
      }
  list.forEach((o) => {
    o.bx = clampPct(o.bx, MARGIN + 3)
    o.by = clampPct(o.by, MARGIN + 3)
    o.rx = o.bx
    o.ry = o.by
    o.lx = o.bx
    o.ly = o.by
  })
}

// gently push apart any two movers closer than minD (soft spring, not a hard snap)
function separate(list: Mover[], minD: number): void {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      let dx = b.rx - a.rx
      let dy = b.ry - a.ry
      let d = Math.hypot(dx, dy)
      if (d < 0.001) {
        dx = rand(-1, 1)
        dy = rand(-1, 1)
        d = Math.hypot(dx, dy) || 1
      }
      if (d < minD) {
        const p = (minD - d) * PUSH
        const nx = dx / d
        const ny = dy / d
        a.rx -= nx * p
        a.ry -= ny * p
        b.rx += nx * p
        b.ry += ny * p
      }
    }
}

// move a group: ease toward its motion path, keep spacing + on-screen (except scroll modes), then draw
function place(
  list: Mover[],
  mode: MotionMode,
  tt: number,
  ds: number,
  minD: number,
  isBubble: boolean,
  active: boolean
): void {
  const scroll = SCROLL.has(mode)
  if (active) {
    for (const o of list) {
      const tgt = motion(o, mode, tt, ds)
      if (scroll) {
        o.rx = tgt.x
        o.ry = tgt.y
      } else {
        o.rx += (tgt.x - o.rx) * 0.12
        o.ry += (tgt.y - o.ry) * 0.12
      }
    }
    if (!scroll) {
      separate(list, minD)
      for (const o of list) {
        o.rx = clampPct(o.rx, MARGIN)
        o.ry = clampPct(o.ry, MARGIN)
      }
    }
  }
  for (const o of list) {
    if (!o.el) continue
    o.el.style.left = o.rx + '%'
    o.el.style.top = o.ry + '%'
    const tf = isBubble ? `translate(-50%,-50%) rotate(${(o.rot ?? 0) * Math.sin(tt * o.fx * 0.5 + o.ph)}deg)` : null
    if (tf) o.el.style.transform = tf
    if (o.ghosts) {
      if (scroll) {
        const horiz = mode === 'leftright' || mode === 'rightleft'
        const offs = [-140, 140]
        o.ghosts.forEach((g, i) => {
          g.style.display = 'block'
          g.style.left = o.rx + (horiz ? offs[i] : 0) + '%'
          g.style.top = o.ry + (horiz ? 0 : offs[i]) + '%'
          if (tf) g.style.transform = tf
        })
      } else o.ghosts.forEach((g) => (g.style.display = 'none'))
    }
  }
}

export default function GradientBackground({ palette }: { palette: string }): JSX.Element {
  const gradientRef = useRef<HTMLDivElement>(null)
  const bubblesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const gradientEl = gradientRef.current
    const bubblesEl = bubblesRef.current
    if (!gradientEl || !bubblesEl) return

    const pal: GradientPalette = resolvePalette(palette)
    const gradSpeed = Math.min(pal.gradSpeed, CALM_GRAD)
    const bubbleSpeed = Math.min(pal.bubbleSpeed, CALM_BUB)

    // ---- build blobs (each stop = one drifting colored blob, plus two wrap-ghosts) ----
    gradientEl.innerHTML = ''
    const stops: Mover[] = pal.stops.map((s) => makeStopAt(s.color, s.x, s.y))
    for (const s of stops) {
      const el = document.createElement('div')
      el.className = 'app-bg-blob'
      gradientEl.appendChild(el)
      s.el = el
      s.ghosts = [0, 1].map(() => {
        const g = document.createElement('div')
        g.className = 'app-bg-blob'
        g.style.display = 'none'
        gradientEl.appendChild(g)
        return g
      })
      for (const e of [s.el, ...s.ghosts]) {
        e.style.setProperty('--c', s.color!)
        e.style.width = e.style.height = pal.size + 'vmax'
      }
    }
    spaceHomes(stops, 32)

    // ---- build bubbles (CSS glass, in front of the gradient, behind the UI) ----
    bubblesEl.innerHTML = ''
    const bubbles: Mover[] = []
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const size = rand(90, 190)
      const mk = (): HTMLDivElement => {
        const el = document.createElement('div')
        el.className = 'app-bg-bubble'
        el.style.width = el.style.height = size + 'px'
        return bubblesEl.appendChild(el)
      }
      const o: Mover = Object.assign(makeMover(), { el: mk(), rot: rand(-8, 8) })
      o.ghosts = [0, 1].map(() => {
        const g = mk()
        g.style.display = 'none'
        return g
      })
      bubbles.push(o)
    }
    spaceHomes(bubbles, 24)

    // ---- apply palette look ----
    gradientEl.style.filter = `blur(${pal.blur}px) saturate(1.15)`

    // ---- animation loop ----
    const reduced =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // draw the initial resting frame once (also the final frame for reduced-motion)
    place(stops, pal.gradMotion, 0, 0, 15, false, false)
    place(bubbles, pal.bubbleMotion, 0, 0, 10, true, false)
    if (reduced) return

    let raf = 0
    let tGrad = 0
    let tBub = 0
    let last = performance.now()
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      // Don't touch the DOM while the window is hidden/minimized - saves GPU + battery.
      if (document.hidden) {
        last = now
        return
      }
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      tGrad += dt * gradSpeed
      tBub += dt * bubbleSpeed
      place(stops, pal.gradMotion, tGrad, dt * gradSpeed, 15, false, true)
      place(bubbles, pal.bubbleMotion, tBub, dt * bubbleSpeed, 10, true, true)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [palette])

  return (
    <div className="app-bg" aria-hidden="true" style={{ background: resolvePalette(palette).base }}>
      <div className="app-bg-gradient" ref={gradientRef} />
      <div className="app-bg-bubbles" ref={bubblesRef} />
    </div>
  )
}

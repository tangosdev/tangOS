import type { ChaosEngine } from './engine'

/** Native pointer/wheel/keyboard listeners on the canvas. Keys bind to the canvas
 *  element only (tabIndex=0, focused on pointerdown) - never to document - so the
 *  app's popover Escape handlers and text inputs are never fought over. */
export class InputController {
  private readonly detachFns: Array<() => void> = []
  private down = false
  private dragged = false
  private downX = 0
  private downY = 0
  private lastX = 0
  private lastY = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly engine: ChaosEngine
  ) {}

  attach(): void {
    const c = this.canvas
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions
    ): void => {
      c.addEventListener(type, fn as EventListener, opts)
      this.detachFns.push(() => c.removeEventListener(type, fn as EventListener, opts))
    }
    on('pointerdown', (e) => this.onDown(e))
    on('pointermove', (e) => this.onMove(e))
    on('pointerup', (e) => this.onUp(e))
    on('pointercancel', () => {
      this.down = false
      this.dragged = false
    })
    on('pointerleave', () => this.engine.pointerLeave())
    on('wheel', (e) => this.onWheel(e), { passive: false })
    on('keydown', (e) => this.onKey(e))
  }

  detach(): void {
    for (const f of this.detachFns) f()
    this.detachFns.length = 0
  }

  private pos(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return
    this.canvas.focus()
    const p = this.pos(e)
    this.down = true
    this.dragged = false
    this.downX = p.x
    this.downY = p.y
    this.lastX = p.x
    this.lastY = p.y
    this.canvas.setPointerCapture(e.pointerId)
  }

  private onMove(e: PointerEvent): void {
    const p = this.pos(e)
    if (this.down) {
      if (!this.dragged && Math.hypot(p.x - this.downX, p.y - this.downY) > 4) this.dragged = true
      if (this.dragged) {
        this.engine.panBy(p.x - this.lastX, p.y - this.lastY)
        this.lastX = p.x
        this.lastY = p.y
        return
      }
    }
    this.lastX = p.x
    this.lastY = p.y
    this.engine.pointerMove(p.x, p.y)
  }

  private onUp(e: PointerEvent): void {
    if (!this.down) return
    this.down = false
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (!this.dragged && e.button === 0) {
      const p = this.pos(e)
      this.engine.click(p.x, p.y)
    }
    this.dragged = false
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const p = this.pos(e)
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY
    this.engine.wheel(p.x, p.y, dy)
  }

  private onKey(e: KeyboardEvent): void {
    if (this.engine.key(e.key)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
}

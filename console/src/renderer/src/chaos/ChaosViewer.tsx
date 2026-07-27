import { useEffect, useRef } from 'react'
import type { AtlasDb, AtlasFunction } from '../../../shared/types'
import { ChaosEngine } from './engine/engine'
import { InputController } from './engine/input'
import type { LayoutMode } from './types'

/** The redesigned Chaos Viewer. Drop-in for the classic Treemap in AtlasView:
 *  same data/callback contract, rendering handled by the chaos engine. Overlay
 *  chrome: the contributor-colors toggle bottom-left; the engine draws its own
 *  minimap top-right once zoomed past the overview. */
export default function ChaosViewer({
  db,
  moduleFilter,
  onModule,
  onFunction,
  onToggleCart,
  onMarqueeSelect,
  onDeselectAll,
  selectedId,
  cartRefs,
  colorBy = 'status',
  onColorBy,
  authorColors,
  authorResolve,
  authorFilter = null,
  showNearMiss = true,
  layout = 'ov'
}: {
  db: AtlasDb
  moduleFilter: string | null
  onModule: (m: string | null) => void
  onFunction: (f: AtlasFunction) => void
  onToggleCart?: (f: AtlasFunction) => void
  onMarqueeSelect?: (fns: AtlasFunction[], add: boolean) => void
  onDeselectAll?: () => void
  selectedId?: string
  cartRefs?: Set<string>
  colorBy?: 'status' | 'author'
  onColorBy?: (c: 'status' | 'author') => void
  authorColors?: Map<string, string>
  authorResolve?: Map<string, string>
  authorFilter?: string | null
  showNearMiss?: boolean
  layout?: LayoutMode
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<ChaosEngine | null>(null)
  const cbRef = useRef({ onModule, onFunction, onToggleCart, onMarqueeSelect, onDeselectAll })
  cbRef.current = { onModule, onFunction, onToggleCart, onMarqueeSelect, onDeselectAll }

  useEffect(() => {
    const canvas = canvasRef.current
    const el = wrapRef.current
    if (!canvas || !el) return
    const engine = new ChaosEngine(canvas, {
      onModule: (m) => cbRef.current.onModule(m),
      onFunction: (f) => cbRef.current.onFunction(f),
      onToggleCart: (f) => cbRef.current.onToggleCart?.(f),
      onMarqueeSelect: (fns, add) => cbRef.current.onMarqueeSelect?.(fns, add),
      onDeselectAll: () => cbRef.current.onDeselectAll?.()
    })
    engineRef.current = engine
    const input = new InputController(canvas, engine)
    input.attach()
    let t: ReturnType<typeof setTimeout> | null = null
    const apply = (): void => {
      engine.resize(
        Math.max(240, el.clientWidth - 16),
        Math.max(120, el.clientHeight - 16),
        window.devicePixelRatio || 1
      )
    }
    apply()
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t)
      t = setTimeout(apply, 150)
    })
    ro.observe(el)
    return () => {
      if (t) clearTimeout(t)
      ro.disconnect()
      input.detach()
      engine.destroy()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setData(db)
  }, [db])

  useEffect(() => {
    engineRef.current?.setOptions({
      colorBy,
      authorColors,
      authorResolve,
      authorFilter,
      moduleFilter,
      showNearMiss,
      selectedId,
      cartRefs,
      themeId: 'classic',
      layout
    })
  }, [colorBy, authorColors, authorResolve, authorFilter, moduleFilter, showNearMiss, selectedId, cartRefs, layout])

  const refocus = (): void => canvasRef.current?.focus()

  return (
    <div className="atlas-treemap aero-panel fill" ref={wrapRef} style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ display: 'block', cursor: 'pointer', borderRadius: 8, outline: 'none', touchAction: 'none' }}
      />
      {onColorBy && (
        <div className="chaos-overlay bl">
          <div className="seg">
            <button
              className={colorBy === 'status' ? 'on' : ''}
              onClick={() => {
                onColorBy('status')
                refocus()
              }}
            >
              Status
            </button>
            <button
              className={colorBy === 'author' ? 'on' : ''}
              onClick={() => {
                onColorBy('author')
                refocus()
              }}
            >
              Contributor
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, type RefObject } from 'react'

/** Close a popover on an outside click or Escape. Returns the ref to put on the wrapper element.
 *
 *  mousedown, not click, so the popover closes as the press starts - matching how the topbar
 *  popovers have always behaved. */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void): RefObject<T> {
  const ref = useRef<T>(null)
  // Held in a ref so callers can pass an inline arrow without re-subscribing every render.
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return ref
}

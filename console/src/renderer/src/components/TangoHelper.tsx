import { useEffect, useState } from 'react'
import { X, ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { frame } from '../tangoFrames'

interface Tip {
  title: string
  body: string
  emotion?: string
}

/** Bottom-right mascot holding a floating tips panel. Idle when read, "thinking" when it
 *  has unread messages, hands-up while showing a tip. Messages come from an editable file. */
export default function TangoHelper({ firstRun }: { firstRun: boolean }): JSX.Element {
  const [open, setOpen] = useState(firstRun) // auto-open the tour on first run
  const [unread, setUnread] = useState(firstRun)
  const [i, setI] = useState(0)
  const [tips, setTips] = useState<Tip[]>([])
  const [bouncing, setBouncing] = useState(false)

  useEffect(() => {
    window.tangos.getTips().then(setTips).catch(() => setTips([]))
  }, [])

  function markRead(): void {
    if (unread) {
      setUnread(false)
      window.tangos.markTourSeen()
    }
  }
  function toggle(): void {
    setBouncing(true) // quick bounce on every state change (click)
    setOpen((o) => {
      if (!o) markRead()
      return !o
    })
  }
  function close(): void {
    setOpen(false)
    markRead()
  }

  const tip = tips[i]
  // Open = he's holding the box up (hands-up). Closed = idle, or thinking if unread.
  const mascot = open ? frame('handsup') : unread ? frame('thinking') : frame('idle')

  return (
    <div className="tango-helper">
      <div className="tango-float">
        {open && (
          <div className="tango-tips">
            <div className="tt-head">
              <span>Tango says,</span>
              {tips.length > 0 && (
                <span className="tt-count">
                  {i + 1}/{tips.length}
                </span>
              )}
              {import.meta.env.DEV && (
                <button className="tt-x" onClick={() => window.tangos.openTips()} title="Edit Tango's messages (dev only)">
                  <Pencil size={13} />
                </button>
              )}
              <button className="tt-x" onClick={close} title="Hide">
                <X size={14} />
              </button>
            </div>
            <div className="tt-body">
              <b>{tip?.title ?? 'Loading…'}</b>
              <p>{tip?.body ?? ''}</p>
            </div>
            {tips.length > 1 && (
              <div className="tt-nav">
                <button onClick={() => setI((n) => (n - 1 + tips.length) % tips.length)} title="Previous">
                  <ChevronLeft size={15} />
                </button>
                <div className="tt-dots">
                  {tips.map((_, k) => (
                    <span key={k} className={k === i ? 'on' : ''} />
                  ))}
                </div>
                <button onClick={() => setI((n) => (n + 1) % tips.length)} title="Next">
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </div>
        )}
        <div
          className={`tango-mascot-wrap${bouncing ? ' bounce' : ''}`}
          onClick={toggle}
          onAnimationEnd={() => setBouncing(false)}
          title={open ? 'Hide tips' : 'Show tips'}
        >
          {!open && unread && <span className="tango-badge" />}
          <img className="tango-mascot" src={mascot} alt="Tango" draggable={false} />
        </div>
      </div>
    </div>
  )
}

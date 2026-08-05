import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import { X } from 'lucide-react'
import { frame } from '../tangoFrames'
import { richText } from '../richText'

interface Step {
  target?: string // CSS selector to spotlight; centered if absent
  title: string
  body: string
  emotion: string
}

// The first-run tour: shows off the features AND walks through the first batch. This hardcoded
// list is the fallback shown until the editable file (userData/tango-tour.txt) loads over it.
const STEPS: Step[] = [
  {
    title: "Hi, I'm Tango!",
    body: "New here? Give me a minute and I'll show you around and get your first functions matching.",
    emotion: 'smile'
  },
  {
    target: '[data-tour="toggle"]',
    title: 'Two apps, one switch',
    body: 'These buttons flip between the Chaos Controller, where your AIs live, and the Chaos Viewer, a map of every function in the game.',
    emotion: 'handsup'
  },
  {
    target: '[data-tour="mcp"]',
    title: 'Turn on MCP',
    body: 'Switch this ON so AIs can connect, then copy the prompt and paste it into your AI (Claude Code, Cursor, and friends).',
    emotion: 'smile'
  },
  {
    target: '[data-tour="settings"]',
    title: 'Keys and GitHub',
    body: 'Add an LLM API key here and that provider appears as its own box, ready to drive. Sign into GitHub too, that is how finished matches get pushed up as pull requests.',
    emotion: 'thinking'
  },
  {
    target: '[data-tour="controller"]',
    title: 'Your AI crew',
    body: 'Every connected or keyed AI becomes a box here. Click a box any time to see its stats and what it is best at.',
    emotion: 'smile'
  },
  {
    target: '[data-tour="controller"]',
    title: 'Queue up work',
    body: 'Pick a batch size (16 is a good start) and hit “Add to queue”. Or press the ∞ button and it keeps pulling fresh work until you stop it.',
    emotion: 'tongue'
  },
  {
    target: '[data-tour="controller"]',
    title: 'Drive it',
    body: 'For an AI with an API key, hit “Drive queue” and watch it match live. AIs connected over MCP pull from their queue on their own.',
    emotion: 'smile'
  },
  {
    target: '[data-tour="toggle"]',
    title: 'Hand-pick functions',
    body: "Want to choose the work yourself? Flip to the Chaos Viewer, click functions to fill your cart, then “Add chosen functions” on any AI's box.",
    emotion: 'handsup'
  },
  {
    target: '[data-tour="policies"]',
    title: 'The three switches',
    body: 'Writes lets tools change files, Review keeps changes on a review branch, and Push opens a rolling PR of matched work. Leave all three ON.',
    emotion: 'smile'
  },
  {
    title: "You're ready to go!",
    body: "I'll hang out in the corner. Click me any time for tips, and I may have messages for you later!",
    emotion: 'handsup'
  }
]

function popStyle(rect: DOMRect | null): CSSProperties {
  if (!rect) return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
  const belowRoom = window.innerHeight - rect.bottom > 280
  const top = belowRoom ? rect.bottom + 16 : Math.max(14, rect.top - 270)
  let left = rect.left + rect.width / 2 - 224
  left = Math.max(14, Math.min(left, window.innerWidth - 462))
  return { left, top }
}

export default function TangoTour({ onDone }: { onDone: () => void }): JSX.Element {
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [steps, setSteps] = useState<Step[]>(STEPS) // hardcoded until the editable file loads over it
  const step = steps[i] ?? steps[0]

  // Pull the tour text from userData/tango-tour.txt so edits show without a rebuild.
  useEffect(() => {
    window.tangos
      .getTour()
      .then((s) => {
        if (s && s.length) setSteps(s as Step[])
      })
      .catch(() => {})
  }, [])

  useLayoutEffect(() => {
    function measure(): void {
      if (!step.target) return setRect(null)
      const el = document.querySelector(step.target)
      if (!el) return setRect(null)
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      setRect(el.getBoundingClientRect())
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [i, step.target])

  const last = i === steps.length - 1
  const spot: CSSProperties | null = rect
    ? { top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }
    : null

  return (
    <div className="tour-scrim">
      {spot ? <div className="tour-spot" style={spot} /> : <div className="tour-dim" />}
      <button className="tour-skip" onClick={onDone} title="Skip the tour">
        <X size={14} /> Skip
      </button>
      <div className="tour-pop" style={popStyle(rect)}>
        <img className="tour-tango" src={frame(step.emotion)} alt="Tango" draggable={false} />
        <div className="tour-box">
          <div className="tour-box-title">{richText(step.title)}</div>
          <p className="tour-box-body">{richText(step.body)}</p>
          <div className="tour-nav">
            <div className="tt-dots">
              {steps.map((_, k) => (
                <span key={k} className={k === i ? 'on' : ''} />
              ))}
            </div>
            <div style={{ flex: 1 }} />
            {i > 0 && (
              <button className="aero-button ghost" onClick={() => setI((n) => n - 1)}>
                Back
              </button>
            )}
            <button className="aero-button" onClick={() => (last ? onDone() : setI((n) => n + 1))}>
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

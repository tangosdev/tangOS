import { useMemo } from 'react'

/** A brief tangOS "whoosh" — rising bubbles + wordmark — shown over an app switch. */
export default function Splash({ label }: { label?: string }): JSX.Element {
  const bubbles = useMemo(
    () =>
      Array.from({ length: 18 }, () => ({
        left: Math.random() * 100,
        size: 12 + Math.random() * 52,
        delay: Math.random() * 0.35,
        dur: 0.9 + Math.random() * 0.7,
        blur: Math.random() < 0.4
      })),
    []
  )
  return (
    <div className="splash">
      <div className="splash-bubbles">
        {bubbles.map((b, i) => (
          <span
            key={i}
            className={`sb${b.blur ? ' blur' : ''}`}
            style={{
              left: `${b.left}%`,
              width: b.size,
              height: b.size,
              animationDelay: `${b.delay}s`,
              animationDuration: `${b.dur}s`
            }}
          />
        ))}
      </div>
      <div className="splash-center">
        <div className="splash-word">tang<span className="os">OS</span></div>
        {label && <div className="splash-sub">{label}</div>}
      </div>
    </div>
  )
}

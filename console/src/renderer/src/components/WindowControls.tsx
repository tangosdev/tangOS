import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'

export default function WindowControls(): JSX.Element {
  const [max, setMax] = useState(false)

  useEffect(() => {
    window.tangos.isMaximized().then(setMax)
    return window.tangos.onMaximizeChange(setMax)
  }, [])

  return (
    <div className="win-controls">
      <button className="wc" onClick={() => window.tangos.minimizeWin()} title="Minimize"><Minus size={15} /></button>
      <button className="wc" onClick={() => window.tangos.maximizeToggle()} title={max ? 'Restore' : 'Maximize'}>
        {max ? <Copy size={12} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12} />}
      </button>
      <button className="wc close" onClick={() => window.tangos.closeWin()} title="Close"><X size={16} /></button>
    </div>
  )
}

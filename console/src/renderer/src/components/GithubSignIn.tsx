import { useEffect, useState } from 'react'
import { Github, Check, Copy, X } from 'lucide-react'

/** Bottom-right "Sign into GitHub" button: runs the device flow and pops a big, unmissable
 *  full-screen overlay with the user code (click to copy) + a link to github.com/login/device.
 *  Flips to "connected" once the token lands in the vault. */
export default function GithubSignIn(): JSX.Element {
  const [code, setCode] = useState<string | null>(null)
  const [uri, setUri] = useState('https://github.com/login/device')
  const [copied, setCopied] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    window.tangos.secretsInfo().then((info) => {
      if (info.secrets.some((s) => s.name === 'GITHUB_TOKEN')) setDone(true)
    })
    return window.tangos.onGithubSignedin((r) => {
      setCode(null)
      if (r.ok) setDone(true)
      else setErr(r.error ?? 'sign-in failed')
    })
  }, [])

  async function signin(): Promise<void> {
    setErr(null)
    setCopied(false)
    try {
      const { userCode, verificationUri } = await window.tangos.githubSignin()
      setCode(userCode)
      if (verificationUri) setUri(verificationUri)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }

  async function copyCode(): Promise<void> {
    if (!code) return
    await window.tangos.copy(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  if (done)
    return (
      <span className="gh-done" title="GITHUB_TOKEN stored in the vault">
        <Check size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
        GitHub connected
      </span>
    )

  return (
    <div className="gh-signin">
      <button className="tb-btn" onClick={signin} disabled={!!code} title="Store a GitHub token via device flow">
        <Github size={14} />
        {code ? 'Waiting for GitHub…' : 'Sign into GitHub'}
      </button>
      {err && <span className="gh-err">{err}</span>}

      {code && (
        <div className="gh-code-scrim">
          <div className="gh-code-modal aero-panel solid">
            <button className="dock-close gh-code-x" onClick={() => setCode(null)} title="Cancel">
              <X size={16} />
            </button>
            <Github size={26} className="gh-code-mark" />
            <h2>Enter this code on GitHub</h2>
            <p className="gh-code-sub">
              We opened <b>github.com/login/device</b> in your browser. Type or paste this code there to finish.
            </p>

            <button className="gh-code-big" onClick={copyCode} title="Click to copy">
              <span className="gh-code-value">{code}</span>
              <span className={`gh-code-copy ${copied ? 'ok' : ''}`}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? 'Copied!' : 'Click to copy'}
              </span>
            </button>

            <div className="gh-code-actions">
              <button className="mini-btn go" onClick={() => window.tangos.openExternal(uri)}>
                Open GitHub
              </button>
            </div>
            <span className="gh-code-wait">Waiting for you to approve — this closes itself once you are signed in.</span>
          </div>
        </div>
      )}
    </div>
  )
}

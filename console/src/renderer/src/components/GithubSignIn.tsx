import { useEffect, useState } from 'react'
import { Github, Check } from 'lucide-react'

/** Bottom-right "Sign into GitHub" button: runs the device flow, shows the user code,
 *  and flips to "connected" once the token lands in the vault. */
export default function GithubSignIn(): JSX.Element {
  const [code, setCode] = useState<string | null>(null)
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
    try {
      const { userCode } = await window.tangos.githubSignin()
      setCode(userCode)
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
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
        {code ? `Code: ${code}` : 'Sign into GitHub'}
      </button>
      {code && <span className="gh-hint">approve it in your browser…</span>}
      {err && <span className="gh-err">{err}</span>}
    </div>
  )
}

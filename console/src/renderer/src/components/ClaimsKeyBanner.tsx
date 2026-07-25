import { useEffect, useState } from 'react'
import { KeyRound, ExternalLink } from 'lucide-react'

const MINT_URL = 'https://tangos.dev/account'

/** Warns when there is no CLAIMS_API_KEY, because without one this console cannot take part
 *  in work coordination and duplicate work is the likely outcome.
 *
 *  Why this is worth a banner rather than a quiet note: the failure is silent and delayed. The
 *  console happily builds batches, agents happily match them, and the collision only surfaces
 *  later as duplicate matches in a PR - after the tokens are spent. Two contributors ground the
 *  same ov002 overlay for a day before anyone noticed.
 *
 *  Precisely what a missing key costs (both directions):
 *   - Nothing you work on is announced, so others can pick up the same functions.
 *   - crackloop cannot try-lock, so this console never sees anyone else's live locks either.
 *  The CLAIMS.md file filter still applies without a key, but that only covers claims someone
 *  wrote into the file by hand - it does not see API locks at all. */
export default function ClaimsKeyBanner({
  onOpenVault
}: {
  onOpenVault?: () => void
}): JSX.Element | null {
  const [missing, setMissing] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let alive = true
    async function check(): Promise<void> {
      try {
        const info = await window.tangos.secretsInfo()
        // Only warn when the project actually declares the key AND it is not stored. A repo that
        // never declares CLAIMS_API_KEY has no claims service, so the warning would be noise.
        const declared = (info.declared ?? []).includes('CLAIMS_API_KEY')
        const stored = (info.secrets ?? []).some((s) => s.name === 'CLAIMS_API_KEY')
        if (alive) setMissing(declared && !stored)
      } catch {
        if (alive) setMissing(false)
      }
    }
    check()
    // Re-check on focus so the banner clears itself as soon as the key is pasted, without a restart.
    window.addEventListener('focus', check)
    return () => {
      alive = false
      window.removeEventListener('focus', check)
    }
  }, [])

  if (!missing || dismissed) return null

  return (
    <div className="claims-warn">
      <KeyRound size={18} className="claims-warn-icon" />
      <div className="claims-warn-text">
        <strong>No claims key - your work is invisible to other contributors.</strong>
        <span>
          Nothing you match is announced, and this console cannot see anyone else&apos;s live
          locks, so the same functions can be worked twice. Sign in and mint a key to fix it.
        </span>
      </div>
      <div className="claims-warn-actions">
        <button className="claims-warn-btn" onClick={() => window.tangos.openExternal(MINT_URL)}>
          <ExternalLink size={13} /> Mint a key
        </button>
        {onOpenVault && (
          <button className="claims-warn-btn ghost" onClick={onOpenVault}>
            Paste it
          </button>
        )}
        <button
          className="claims-warn-btn ghost"
          title="Hide until the app restarts"
          onClick={() => setDismissed(true)}
        >
          Later
        </button>
      </div>
    </div>
  )
}

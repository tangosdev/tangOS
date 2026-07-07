// GitHub OAuth device flow: the user approves a short code in their browser, and we
// store the resulting token as GITHUB_TOKEN. No client secret is needed for device flow.
//
// Device flow requires a public OAuth client_id. Default is the GitHub CLI's app id (widely
// reused for read-only device-flow tokens); override per-repo with project.githubClientId.
const DEFAULT_CLIENT_ID = '178c6fc778ccc68e1d6a'

export interface DeviceCode {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number // seconds between polls
  expiresIn: number // seconds until the code expires
}

interface DeviceCodeResp {
  device_code?: string
  user_code?: string
  verification_uri?: string
  interval?: number
  expires_in?: number
  error?: string
  error_description?: string
}
interface TokenResp {
  access_token?: string
  error?: string
  error_description?: string
  interval?: number
}

/** Ask GitHub for a device + user code; returns the code to show and the URL to open. */
export async function startDeviceFlow(clientId?: string): Promise<DeviceCode> {
  const cid = clientId || DEFAULT_CLIENT_ID
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cid, scope: 'read:user' })
  })
  const d = (await r.json()) as DeviceCodeResp
  if (!d.device_code || !d.user_code || !d.verification_uri) {
    throw new Error(d.error_description || 'GitHub device-code request failed')
  }
  return {
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    deviceCode: d.device_code,
    interval: d.interval ?? 5,
    expiresIn: d.expires_in ?? 900
  }
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

/** Poll until the user approves the code (or it expires). Resolves with the access token. */
export async function pollForToken(dc: DeviceCode, clientId?: string): Promise<string> {
  const cid = clientId || DEFAULT_CLIENT_ID
  let interval = dc.interval
  const deadline = Date.now() + dc.expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cid,
        device_code: dc.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    })
    const d = (await r.json()) as TokenResp
    if (d.access_token) return d.access_token
    if (d.error === 'authorization_pending') continue
    if (d.error === 'slow_down') {
      interval = d.interval ?? interval + 5
      continue
    }
    throw new Error(d.error_description || d.error || 'authorization failed')
  }
  throw new Error('the code expired before it was approved')
}

// Find-or-create a pull request via the GitHub REST API, so a console-driven session can open
// ONE rolling PR for its matched work and keep updating it (each push refreshes the same PR).
// Uses the vault GITHUB_TOKEN; never writes credentials to disk.

interface PrRef {
  number: number
  html_url: string
}

async function gh(
  path: string,
  token: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: init?.body ? JSON.stringify(init.body) : undefined
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* empty body */
  }
  return { status: res.status, json }
}

export interface EnsurePrResult {
  ok: boolean
  url?: string
  created?: boolean
  error?: string
}

/** Return the open PR for `head` (creating it against `base` if none exists yet). */
export async function ensurePullRequest(opts: {
  owner: string
  repo: string
  head: string // branch name on the same repo
  base: string
  token: string
  title: string
  body: string
}): Promise<EnsurePrResult> {
  const { owner, repo, head, base, token, title, body } = opts
  try {
    const existing = await gh(
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
      token
    )
    if (existing.status === 200 && Array.isArray(existing.json) && existing.json.length) {
      const pr = existing.json[0] as PrRef
      return { ok: true, url: pr.html_url, created: false }
    }
    const created = await gh(`/repos/${owner}/${repo}/pulls`, token, {
      method: 'POST',
      body: { title, head, base, body, maintainer_can_modify: true, draft: false }
    })
    if (created.status === 201) {
      const pr = created.json as PrRef
      return { ok: true, url: pr.html_url, created: true }
    }
    const msg =
      (created.json as { message?: string; errors?: { message?: string }[] } | null)?.errors?.[0]?.message ??
      (created.json as { message?: string } | null)?.message ??
      `HTTP ${created.status}`
    return { ok: false, error: msg }
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) }
  }
}

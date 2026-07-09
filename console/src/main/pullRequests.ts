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

/** Return the open PR for `head` (creating it against `base` if none exists yet). When the head
 *  branch lives on a fork, pass `headOwner` = the fork owner so the PR is opened cross-repo
 *  (base repo <- forkOwner:branch); it defaults to `owner` for the same-repo case. */
export async function ensurePullRequest(opts: {
  owner: string
  repo: string
  head: string // branch name
  base: string
  token: string
  title: string
  body: string
  headOwner?: string // owner of the head branch; differs from `owner` for a fork PR
}): Promise<EnsurePrResult> {
  const { owner, repo, head, base, token, title, body } = opts
  const headRef = `${opts.headOwner ?? owner}:${head}` // GitHub accepts owner:branch for same-repo too
  try {
    const existing = await gh(
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(headRef)}`,
      token
    )
    if (existing.status === 200 && Array.isArray(existing.json) && existing.json.length) {
      const pr = existing.json[0] as PrRef
      return { ok: true, url: pr.html_url, created: false }
    }
    const created = await gh(`/repos/${owner}/${repo}/pulls`, token, {
      method: 'POST',
      body: { title, head: headRef, base, body, maintainer_can_modify: true, draft: false }
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The login of the account the token belongs to (null if the token is invalid). */
async function githubLogin(token: string): Promise<string | null> {
  const r = await gh('/user', token)
  return r.status === 200 ? ((r.json as { login?: string })?.login ?? null) : null
}

/** Whether the token can push to owner/repo (owner or collaborator). */
async function canPush(owner: string, repo: string, token: string): Promise<boolean> {
  const r = await gh(`/repos/${owner}/${repo}`, token)
  return r.status === 200 && !!(r.json as { permissions?: { push?: boolean } })?.permissions?.push
}

export interface PushTarget {
  ok: boolean
  slug?: { owner: string; repo: string } // where to PUSH the branch (base repo, or the user's fork)
  headOwner?: string // owner to name in the PR head ref (the fork owner for a cross-repo PR)
  isFork?: boolean
  error?: string
}

/** Ensure a fork of owner/repo exists under the signed-in account; wait until it's queryable
 *  (a brand-new fork is created asynchronously by GitHub, so the first push can 404 for a moment). */
async function ensureFork(owner: string, repo: string, token: string, login: string): Promise<PushTarget> {
  const created = await gh(`/repos/${owner}/${repo}/forks`, token, { method: 'POST' })
  if (created.status !== 202 && created.status !== 200) {
    const msg = (created.json as { message?: string } | null)?.message ?? `HTTP ${created.status}`
    return { ok: false, error: `couldn't fork ${owner}/${repo}: ${msg}` }
  }
  const info = created.json as { owner?: { login?: string }; name?: string }
  const forkOwner = info?.owner?.login ?? login
  const forkRepo = info?.name ?? repo
  for (let i = 0; i < 20; i++) {
    if ((await gh(`/repos/${forkOwner}/${forkRepo}`, token)).status === 200) {
      return { ok: true, slug: { owner: forkOwner, repo: forkRepo }, headOwner: forkOwner, isFork: true }
    }
    await sleep(1500)
  }
  return { ok: false, error: 'fork was requested but is still being created - try Push again in a few seconds' }
}

/** Decide where a contributor's branch should be pushed: straight to the base repo when the token
 *  has push access there, otherwise the signed-in user's fork (created on demand). The PR is always
 *  opened on the base repo - cross-repo from the fork when needed. */
export async function resolvePushTarget(
  base: { owner: string; repo: string },
  token: string
): Promise<PushTarget> {
  const login = await githubLogin(token)
  if (!login) return { ok: false, error: 'could not identify the signed-in GitHub account (token invalid or expired)' }
  if (login.toLowerCase() === base.owner.toLowerCase() || (await canPush(base.owner, base.repo, token))) {
    return { ok: true, slug: base, headOwner: base.owner, isFork: false }
  }
  return ensureFork(base.owner, base.repo, token, login)
}

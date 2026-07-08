// Canonical, deduped contributor identity from GitHub (merged commits + PR authors).
// The Atlas data credits functions by an email-derived key (the local part of the
// git author email); GitHub knows the real login. We rebuild
// that key->login map from the commits API using the same transform the data
// generator uses, so attribution dedups to one login per person.

import type { GithubCredits } from '../shared/types'

const cache = new Map<string, GithubCredits>()
const NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/
const isBot = (login: string): boolean => /\[bot\]$/i.test(login) || login === 'github-actions'

function parseRepo(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  return m ? { owner: m[1], repo: m[2] } : null
}

// Same derivation as tools/chaos_db_ci.py src_authors(): noreply login, else email local-part.
function deriveKey(email: string | undefined, name: string | undefined): string {
  if (email) {
    const m = NOREPLY.exec(email)
    if (m) return m[1]
    const local = email.split('@')[0].toLowerCase()
    if (local) return local
  }
  return (name ?? '').trim()
}

async function gh(path: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'tangOS' }
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(`https://api.github.com${path}`, { headers })
  if (!r.ok) throw new Error(`GitHub ${r.status}`)
  return r.json()
}

export async function githubCredits(url: string, token?: string): Promise<GithubCredits> {
  const empty: GithubCredits = { logins: [], keyToLogin: {}, prAuthors: [] }
  if (!url) return empty
  if (cache.has(url)) return cache.get(url)!
  const auth = (token || process.env.GITHUB_TOKEN || '').trim() || undefined
  const pr = parseRepo(url)
  if (!pr) return empty
  const base = `/repos/${pr.owner}/${pr.repo}`
  const out: GithubCredits = { logins: [], keyToLogin: {}, prAuthors: [] }

  try {
    const c = (await gh(`${base}/contributors?per_page=100`, auth)) as { login: string; contributions: number }[]
    if (Array.isArray(c)) out.logins = c.filter((x) => !isBot(x.login)).map((x) => ({ login: x.login, contributions: x.contributions }))
  } catch {
    /* rate-limited or offline */
  }

  try {
    for (let page = 1; page <= 8; page++) {
      const commits = (await gh(`${base}/commits?per_page=100&page=${page}`, auth)) as {
        author?: { login?: string }
        commit?: { author?: { email?: string; name?: string } }
      }[]
      if (!Array.isArray(commits) || commits.length === 0) break
      for (const cm of commits) {
        const login = cm.author?.login
        if (!login) continue
        const key = deriveKey(cm.commit?.author?.email, cm.commit?.author?.name)
        if (key && !out.keyToLogin[key]) out.keyToLogin[key] = login
      }
      if (commits.length < 100) break
    }
  } catch {
    /* partial map is fine */
  }

  try {
    const pulls = (await gh(`${base}/pulls?state=all&per_page=100`, auth)) as { user?: { login?: string } }[]
    if (Array.isArray(pulls)) {
      out.prAuthors = [...new Set(pulls.map((p) => p.user?.login).filter((l): l is string => !!l && !isBot(l)))]
    }
  } catch {
    /* ignore */
  }

  cache.set(url, out)
  return out
}

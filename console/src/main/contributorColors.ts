// Shared contributor colors. `contributor-colors.json` on the decomp repo's default branch maps
// GitHub login -> hex color. Every console fetches it (raw, TTL-cached, local-clone fallback) and
// overrides the generated legend palette with it, so a color one contributor picks shows up on
// EVERYONE's Atlas. Picking is local-preview only; an explicit Confirm opens a one-file PR (built
// here from upstream's file plus ONLY the caller's own login key - the UI can't write anyone
// else's). Direct commits were the v1 and reverted visually: raw.githubusercontent CDN-caches for
// ~5 min, so the post-save refetch served the stale file and stomped the fresh pick.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pushSubsetToBranch, fetchBase } from './gitsafe'
import { ensurePullRequest, resolvePushTarget } from './pullRequests'

export const COLORS_FILE = 'contributor-colors.json'
const HEX = /^#[0-9a-fA-F]{6}$/

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
      'Content-Type': 'application/json',
      'User-Agent': 'tangOS'
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

// Who the stored token belongs to - cached per token so the legend doesn't re-hit /user.
let viewerCache: { token: string; login: string | null } | null = null
export async function viewerLogin(token?: string): Promise<string | null> {
  if (!token) return null
  if (viewerCache?.token === token) return viewerCache.login
  try {
    const r = await gh('/user', token)
    const login = r.status === 200 ? ((r.json as { login?: string })?.login ?? null) : null
    viewerCache = { token, login }
    return login
  } catch {
    return null
  }
}

function parseColors(text: string): Record<string, string> {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && HEX.test(v)) out[k] = v
    return out
  } catch {
    return {}
  }
}

// Fetched copy, TTL-cached so the Atlas doesn't hammer raw.githubusercontent. Busted on a set.
let colorsCache: { key: string; at: number; colors: Record<string, string> } | null = null
const COLORS_TTL_MS = 60_000

export function bustColorsCache(): void {
  colorsCache = null
}

/** The shared color map: raw fetch off the default branch (everyone sees updates within the TTL
 *  without pulling), falling back to the local clone's copy when offline. */
export async function fetchColors(
  slug: { owner: string; repo: string } | null,
  branch: string,
  repoPath: string | null
): Promise<Record<string, string>> {
  const key = slug ? `${slug.owner}/${slug.repo}@${branch}` : (repoPath ?? '')
  if (colorsCache?.key === key && Date.now() - colorsCache.at < COLORS_TTL_MS) return colorsCache.colors
  let colors: Record<string, string> = {}
  if (slug) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${slug.owner}/${slug.repo}/${branch}/${COLORS_FILE}`)
      if (r.ok) colors = parseColors(await r.text())
    } catch {
      /* offline - fall through to the local copy */
    }
  }
  if (!Object.keys(colors).length && repoPath) {
    try {
      colors = parseColors(readFileSync(join(repoPath, COLORS_FILE), 'utf8'))
    } catch {
      /* no local file either */
    }
  }
  colorsCache = { key, at: Date.now(), colors }
  return colors
}

/** Confirm the CALLER's color: merge their login's key into upstream's file and open a one-file
 *  PR (throwaway-index branch push, fork fallback for non-collaborators). Only the caller's own
 *  key can change - the merged file is built here from upstream + one entry. Also flips the repo's
 *  delete-branch-on-merge setting (best effort, admin only) so accepted color PRs clean their
 *  branches up instead of accumulating as unimportant history. */
export async function openColorPr(
  repoPath: string,
  slug: { owner: string; repo: string },
  branch: string,
  token: string,
  color: string
): Promise<{ ok: boolean; login?: string; prUrl?: string; error?: string }> {
  if (!HEX.test(color)) return { ok: false, error: 'color must be #rrggbb' }
  const login = await viewerLogin(token)
  if (!login) return { ok: false, error: 'could not resolve your GitHub login - sign in again in Settings' }
  // Upstream's CURRENT file via the API (not the CDN-cached raw path), so the PR builds on truth.
  let existing: Record<string, string> = {}
  const cur = await gh(`/repos/${slug.owner}/${slug.repo}/contents/${COLORS_FILE}?ref=${encodeURIComponent(branch)}`, token)
  if (cur.status === 200) {
    const j = cur.json as { content?: string }
    if (j.content) existing = parseColors(Buffer.from(j.content, 'base64').toString('utf8'))
  } else if (cur.status !== 404) {
    return { ok: false, error: `could not read ${COLORS_FILE} (HTTP ${cur.status})` }
  }
  if (existing[login] === color) return { ok: true, login } // already upstream - nothing to propose
  const merged = { ...existing, [login]: color }
  const bytes = JSON.stringify(merged, null, 2) + '\n'
  const target = await resolvePushTarget(slug, token)
  if (!target.ok || !target.slug) return { ok: false, login, error: target.error ?? 'could not resolve a push target' }
  await fetchBase(repoPath, branch)
  const head = `tangos/color-${login.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
  const pushed = await pushSubsetToBranch(
    repoPath,
    head,
    branch,
    [COLORS_FILE],
    `chore: contributor color for ${login}`,
    target.slug,
    token,
    { contents: new Map([[COLORS_FILE, bytes]]) }
  )
  if (!pushed.ok) return { ok: false, login, error: `push failed: ${pushed.err.slice(-160)}` }
  const pr = await ensurePullRequest({
    owner: slug.owner,
    repo: slug.repo,
    head,
    base: branch,
    token,
    headOwner: target.headOwner,
    title: `Contributor color: ${login}`,
    body: `Sets ${login}'s contributor color to \`${color}\` in \`${COLORS_FILE}\`. One key only; opened from tangOS Console.`
  })
  if (!pr.ok) return { ok: false, login, error: `pushed, but PR failed: ${pr.error}` }
  // Accepted color PRs are not important history: ask GitHub to auto-delete merged head branches.
  // Repo-wide setting, admin-token only - non-admins fail silently and a maintainer flips it once.
  void gh(`/repos/${slug.owner}/${slug.repo}`, token, { method: 'PATCH', body: { delete_branch_on_merge: true } }).catch(() => {})
  bustColorsCache()
  return { ok: true, login, prUrl: pr.url }
}

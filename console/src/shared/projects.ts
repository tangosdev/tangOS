// The tangOS project registry: the decomps Console knows about by name.
//
// Console stays repo-agnostic - a project's tools, compiler, data source and rules all come
// from its own tangos.json. This file only answers "what can I offer in the switcher before
// anything is on disk": a display name, a clone URL, and a stable settings key.
//
// The authoritative list lives on the backend (REGISTRY_URL re-serves each repo's own
// descriptor), and the main process merges it in at boot via registerProjects - so adding
// a decomp is one commit in that decomp, not an entry here. The baked entries below are
// the first paint and the offline fallback. `id` is a settings key, so once shipped it
// never changes; rename `title` freely.

export interface ProjectEntry {
  id: string
  title: string // fallback label until the real descriptor loads and supplies project.title
  glyph: string // 1-2 chars for the switcher pill and the landing-page card
  github: string // full clone URL - our projects are spread across more than one org
  blurb: string
}

/** The one bootstrap URL Console needs: everything else comes from descriptors. */
export const REGISTRY_URL = 'https://tangos.dev/api/projects'

export const PROJECTS: ProjectEntry[] = [
  {
    id: 'sm64ds',
    title: 'Super Mario 64 DS',
    glyph: '64',
    github: 'https://github.com/tangosdev/sm64ds-decomp',
    blurb:
      'The reference repo - ships a hand-authored tangos.json exposing its full toolchain. (Running it still needs mwccarm + your own ROM.)'
  },
  {
    id: 'pictochat',
    title: 'PictoChat',
    glyph: 'PC',
    github: 'https://github.com/tangOS-decomps/pictochat-decomp',
    blurb:
      'Byte-matching the DSi chat app. (Running it needs a dsi mwccarm build plus your own title and BIOS dumps.)'
  }
]

export function projectById(id: string): ProjectEntry | undefined {
  return PROJECTS.find((p) => p.id === id)
}

/** Merge registry rows into PROJECTS in place, so every existing consumer
 *  (projectById, projectBySlug, the switcher rows) sees them without re-plumbing.
 *  A known id gets its title/github refreshed (the descriptor's words win); an
 *  unknown id is appended with a derived glyph. Never removes a baked entry -
 *  the registry being briefly wrong must not strand a cloned project's settings. */
export function registerProjects(
  rows: { id: string; title?: string | null; github?: string | null; tagline?: string | null }[]
): void {
  for (const r of rows) {
    if (!r.id) continue
    const existing = projectById(r.id)
    if (existing) {
      if (r.title) existing.title = r.title
      if (r.github) existing.github = r.github
      if (r.tagline) existing.blurb = r.tagline
    } else {
      const title = r.title || r.id
      PROJECTS.push({
        id: r.id,
        title,
        glyph: title.slice(0, 2).toUpperCase(),
        github: r.github ?? '',
        blurb: r.tagline ?? ''
      })
    }
  }
}

/** "owner/repo", lowercased, from any github URL shape (with or without .git, ssh or https). */
export function slugOf(url?: string | null): string | null {
  if (!url) return null
  const m = /github\.com[:/]+([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

export function projectBySlug(url?: string | null): ProjectEntry | undefined {
  const slug = slugOf(url)
  return slug ? PROJECTS.find((p) => slugOf(p.github) === slug) : undefined
}

/** Where to read a project's tangos.json without cloning it, for viewer-only mode. */
export function descriptorUrlFor(entry: ProjectEntry, branch = 'HEAD'): string | null {
  const slug = slugOf(entry.github)
  return slug && `https://raw.githubusercontent.com/${slug}/${branch}/tangos.json`
}

/** Settings key for a repo that isn't in the registry. `repo:pick` takes any folder, and an
 *  unidentified one must get its own stats bucket rather than borrowing another project's. */
export function customIdFor(repoPath: string): string {
  let h = 0
  const s = repoPath.toLowerCase()
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return `local:${(h >>> 0).toString(36)}`
}

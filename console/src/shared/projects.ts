// The tangOS project registry: the decomps Console knows about by name.
//
// Console stays repo-agnostic - a project's tools, compiler, data source and rules all come
// from its own tangos.json. This file only answers "what can I offer in the switcher before
// anything is on disk": a display name, a clone URL, and a stable settings key.
//
// Adding a decomp is one entry. `id` is a settings key, so once shipped it never changes;
// rename `title` freely.

export interface ProjectEntry {
  id: string
  title: string // fallback label until the real descriptor loads and supplies project.title
  glyph: string // 1-2 chars for the switcher pill and the landing-page card
  github: string // full clone URL - our projects are spread across more than one org
  blurb: string
}

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

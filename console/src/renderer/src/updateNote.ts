export interface UpdateNote {
  id: string
  title: string
  body: string
}

/** The current "Tango says" announcement. Tango wears an unread badge until the
 *  user opens him and reads it; the id is remembered in settings so each note
 *  only nags once. For the next release: bump the id and rewrite the body. */
export const UPDATE_NOTE: UpdateNote = {
  id: 'sync-repo-2026-07',
  title: 'New update!',
  body: 'Drifted clone? Settings > Sync repo resets it to a fresh copy (backs up first).'
}

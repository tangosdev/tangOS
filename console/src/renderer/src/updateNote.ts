export interface UpdateNote {
  id: string
  title: string
  body: string
}

/** The current "Tango says" announcement. Tango wears an unread badge until the
 *  user opens him and reads it; the id is remembered in settings so each note
 *  only nags once. For the next release: bump the id and rewrite the body. */
export const UPDATE_NOTE: UpdateNote = {
  id: 'atlas-viewer-2026-07',
  title: 'New update!',
  body: "Lot's of new features including; better UI, better stat tracking, nerd stat viewer in the atlas, some other stuff i cant remember, and an internal emotion counter for me!"
}

export interface Pt {
  x: number
  y: number
}

/** How the treemap is grouped: ov sections (default), one flat map by size,
 *  three status bands (uncleared -> draft -> matched), contributor sections, or one
 *  section per source file (a translation unit). */
export type LayoutMode = 'ov' | 'size' | 'match' | 'contributor' | 'tu'

/** What the tile colours mean. status = matched / near-miss / unmatched; author = who matched it;
 *  converted / linked = how far the tier of that name has got (a decomp that publishes the column). */
export type ColorBy = 'status' | 'author' | 'converted' | 'linked'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

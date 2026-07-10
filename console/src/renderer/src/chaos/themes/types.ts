export interface ThemeColors {
  matched: string
  nearMiss: string
  unmatched: string
  /** srcPath present but neither matched nor a recorded divergence. */
  draft: string
  moduleStroke: string
  selection: string
  background: string
  /** Painted under the tiles across the world bounds so the gaps between tiles
   *  show a stable, world-locked tone instead of the screen-fixed panel glass. */
  ground: string
}

export interface Theme {
  id: string
  name: string
  colors: ThemeColors
}

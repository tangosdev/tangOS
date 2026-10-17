export interface ThemeColors {
  matched: string
  nearMiss: string
  unmatched: string
  /** srcPath present but neither matched nor a recorded divergence. */
  draft: string
  /** Tier views: a matched function whose source is readable / whose unit reaches the port. */
  converted: string
  linked: string
  /** Matched, but not yet in the tier being shown. Pale so the finished part stands out. */
  pending: string
  /** Outline round every function of the selected function's translation unit. */
  tuOutline: string
  /** Reproduces the ROM with no match left to chase (asm primitive / exit stub).
   *  Painted with a hatch so it never reads as the claim wash, which is also red. */
  noMatch: string
  noMatchHatch: string
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

// Gradient-background palettes, ported from assets/gradient-background/themes.json
// (the "gradient lab" reference). Each palette is a full config for GradientBackground:
// a solid base color behind drifting blurred color blobs, plus motion settings.
// Kept as a typed module so the renderer stays self-contained (themes.json lives
// outside the renderer bundle, under assets/).

export type MotionMode =
  | 'drift'
  | 'random'
  | 'leftright'
  | 'rightleft'
  | 'falling'
  | 'rising'
  | 'orbit'
  | 'swirl'
  | 'bounce'

export interface GradientStop {
  color: string
  x: number // home position, % of the stage
  y: number
}

export interface GradientPalette {
  base: string // solid color behind the blobs
  blur: number // px of blur on the gradient layer
  size: number // blob diameter in vmax
  gradSpeed: number // gradient motion speed multiplier (see CALM_* caps in the component)
  bubbleSpeed: number // bubble motion speed multiplier
  gradMotion: MotionMode
  bubbleMotion: MotionMode
  stops: GradientStop[]
}

export const GRADIENT_PALETTES: Record<string, GradientPalette> = {
  aero: {
    base: '#5cb2ec',
    blur: 50,
    size: 120,
    gradSpeed: 0.5,
    bubbleSpeed: 0.41,
    gradMotion: 'leftright',
    bubbleMotion: 'rising',
    stops: [
      { color: '#9bd6fb', x: 76, y: 26 }, // light sky
      { color: '#7fc400', x: 24, y: 74 }, // aero green
      { color: '#b7e372', x: 58, y: 84 }, // lime
      { color: '#66bff2', x: 32, y: 42 } // blue
    ]
  },
  cyberlime: {
    base: '#00ffe1',
    blur: 10,
    size: 120,
    gradSpeed: 0.22,
    bubbleSpeed: 0.41,
    gradMotion: 'leftright',
    bubbleMotion: 'rising',
    stops: [
      { color: '#fff700', x: 87, y: 52.8 },
      { color: '#44ff00', x: 13.5, y: 47 },
      { color: '#ffea00', x: 29.1, y: 80.3 }
    ]
  },
  sunset: {
    base: '#f58a17',
    blur: 45,
    size: 120,
    gradSpeed: 1.72,
    bubbleSpeed: 0.41,
    gradMotion: 'leftright',
    bubbleMotion: 'rising',
    stops: [
      { color: '#fcb995', x: 71.5, y: 38.7 },
      { color: '#f44881', x: 67.9, y: 70.5 },
      { color: '#f2cf49', x: 32.5, y: 53.5 },
      { color: '#f0564c', x: 38.5, y: 84.9 }
    ]
  },
  rose: {
    base: '#ff7ad5',
    blur: 45,
    size: 120,
    gradSpeed: 1.72,
    bubbleSpeed: 0.41,
    gradMotion: 'leftright',
    bubbleMotion: 'rising',
    stops: [
      { color: '#e73c83', x: 71.5, y: 38.7 },
      { color: '#d6aea8', x: 67.9, y: 70.5 },
      { color: '#d3cfc7', x: 32.5, y: 53.5 },
      { color: '#cb2f41', x: 38.5, y: 84.9 }
    ]
  },
  // Very dark navy blues - deepsea wants no glare, so every stop stays deep and low-luminance.
  midnight: {
    base: '#04101d',
    blur: 45,
    size: 120,
    gradSpeed: 1.72,
    bubbleSpeed: 0.41,
    gradMotion: 'leftright',
    bubbleMotion: 'rising',
    stops: [
      { color: '#06213f', x: 60.9, y: 34.1 },
      { color: '#02060f', x: 37.1, y: 76.1 },
      { color: '#0a3357', x: 68.8, y: 72.4 },
      { color: '#04182f', x: 87, y: 48.5 }
    ]
  }
}

/** Which gradient palette each app theme uses. The Theme dropdown is the single control -
 *  the background follows it. Themes without an entry fall back to the aero palette. */
export const THEME_TO_PALETTE: Record<string, string> = {
  aero: 'aero',
  sunset: 'sunset',
  deepsea: 'midnight',
  bubblegum: 'rose',
  lemonlime: 'cyberlime'
}

export function paletteForTheme(theme: string): string {
  return THEME_TO_PALETTE[theme] ?? DEFAULT_PALETTE
}

export const DEFAULT_PALETTE = 'aero'

/** Look a palette up by id, falling back to the default for unknown/stale ids. */
export function resolvePalette(id: string): GradientPalette {
  return GRADIENT_PALETTES[id] ?? GRADIENT_PALETTES[DEFAULT_PALETTE]
}

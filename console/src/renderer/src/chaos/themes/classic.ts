import type { Theme } from './types'

/** The original Chaos Viewer look - colors copied verbatim from Treemap.tsx. */
export const classic: Theme = {
  id: 'classic',
  name: 'Classic',
  colors: {
    matched: '#3fc45f',
    nearMiss: '#eab308',
    unmatched: '#b9cadb',
    draft: '#b9cadb',
    moduleStroke: '#0d3a5c',
    selection: '#0d3a5c',
    background: 'transparent',
    ground: 'rgba(13,58,92,0.10)'
  }
}

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
    converted: '#f2a31f',
    linked: '#7c5cff',
    pending: '#b9e3c4',
    tuOutline: '#e0561b',
    noMatch: '#a8324a',
    noMatchHatch: 'rgba(255,214,224,0.55)',
    moduleStroke: '#0d3a5c',
    selection: '#0d3a5c',
    background: 'transparent',
    ground: 'rgba(13,58,92,0.10)'
  }
}

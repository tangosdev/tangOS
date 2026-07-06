// Deterministic distinct color per connected AI, so multiple agents are tellable apart.
const AI_PALETTE = [
  '#0099e0', '#7d4bd8', '#e6194B', '#f58231', '#059669',
  '#db2777', '#0ea5e9', '#d97706', '#4363d8', '#a83232', '#00a0b0', '#911eb4'
]

export function aiColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AI_PALETTE[h % AI_PALETTE.length]
}

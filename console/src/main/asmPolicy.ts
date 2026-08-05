// Is this source file a raw asm transcription pretending to be a match?
//
// The failure mode is the VACUOUS byte match. mwccarm's `dcd 0x...` directive emits the literal
// word you type, so a whole-function dcd dump assembles to the ROM bytes BY DEFINITION - the
// "match" proves only that the author copied the disassembly. PR #1072 shipped 8 such files as
// +8 matched functions this way, and the console's own gate (outputIsMatch in aiStats.ts) could
// not see it: byte equality is exactly what a transcription games, so the source TEXT is the only
// place the lie shows. This mirror lets the console refuse to credit, bank, or push one.
//
// The decomp repo's tools/asm_policy.py is the AUTHORITATIVE version of these semantics (its
// server-side gate hard-fails a PR that adds one); keep this file in sync with it. Mirrored
// exactly: a file is 'transcribed' when it contains a `dcd 0x...` word AND carries neither banner
// anywhere in the file. "HAND-ASM PRIMITIVE" says the ORIGINAL was assembly (the asm block IS the
// faithful source); "NONMATCHING" declares a draft that never claimed to be a match. The banner
// search runs over the WHOLE file, never a head window: a banner is only ever exculpatory, so a
// deep mention can excuse a file but can never condemn one.

const HAND_BANNER = 'HAND-ASM PRIMITIVE'
const DRAFT_BANNER = 'NONMATCHING'

// A dcd word is raw ROM data re-spelled; one is enough to make the file a transcription.
const DCD_RE = /\bdcd\s+0x[0-9a-fA-F]/

export function classifySource(text: string): 'ok' | 'transcribed' {
  if (text.includes(HAND_BANNER) || text.includes(DRAFT_BANNER)) return 'ok'
  return DCD_RE.test(text) ? 'transcribed' : 'ok'
}

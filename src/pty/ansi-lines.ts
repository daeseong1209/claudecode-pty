/**
 * Stateful byte-level parser that tracks ANSI escape sequences and reports
 * real line-break positions (\n in the normal state only).
 *
 * Handles CSI (ESC [), OSC (ESC ]), DCS/SOS/PM/APC (ESC P/X/^/_) with both
 * BEL (0x07) and ST (ESC \) terminators. A sub-state (`string_esc`) tracks
 * the originating string-type (osc vs dcs-family) so an embedded ESC that
 * isn't ST doesn't collapse DCS into OSC.
 */

type StringState = 'osc' | 'dcs'
type State = 'normal' | 'esc' | 'csi' | StringState | 'string_esc'

const ESC = 0x1b
const LF = 0x0a
const BEL = 0x07
const LBRACKET = 0x5b
const RBRACKET = 0x5d
const CAP_P = 0x50
const CAP_X = 0x58
const CAP_CARET = 0x5e
const CAP_UNDER = 0x5f
const BACKSLASH = 0x5c

export class AnsiLineParser {
  private state: State = 'normal'
  private lastStringState: StringState = 'osc'

  /**
   * Feed the next chunk of bytes. Returns the byte offsets, relative to `data`,
   * at which a new line starts (positions immediately after a real \n).
   *
   * Parser state persists across calls.
   */
  feed(data: Uint8Array): number[] {
    const starts: number[] = []
    for (let i = 0; i < data.length; i++) {
      const b = data[i]!
      switch (this.state) {
        case 'normal':
          if (b === ESC) {
            this.state = 'esc'
          } else if (b === LF) {
            starts.push(i + 1)
          }
          break
        case 'esc':
          if (b === LBRACKET) {
            this.state = 'csi'
          } else if (b === RBRACKET) {
            this.state = 'osc'
            this.lastStringState = 'osc'
          } else if (b === CAP_P || b === CAP_X || b === CAP_CARET || b === CAP_UNDER) {
            this.state = 'dcs'
            this.lastStringState = 'dcs'
          } else {
            this.state = 'normal'
          }
          break
        case 'csi':
          if (b >= 0x40 && b <= 0x7e) {
            this.state = 'normal'
          }
          break
        case 'osc':
        case 'dcs':
          if (b === BEL) {
            this.state = 'normal'
          } else if (b === ESC) {
            this.lastStringState = this.state
            this.state = 'string_esc'
          }
          break
        case 'string_esc':
          if (b === BACKSLASH) {
            this.state = 'normal'
          } else if (b === ESC) {
            // stay in string_esc
          } else {
            // back to the original string state
            this.state = this.lastStringState
          }
          break
      }
    }
    return starts
  }

  reset() {
    this.state = 'normal'
    this.lastStringState = 'osc'
  }
}

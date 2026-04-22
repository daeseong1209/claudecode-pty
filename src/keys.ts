/**
 * Named keys mapped to their byte-level terminal escape sequences.
 *
 * Agents should prefer named keys over raw `\x03` strings — the enum side has
 * a fixed, small vocabulary that's easy to generate correctly, and typos
 * become tool-call errors rather than "sent the wrong byte."
 */

export const KEY_MAP: Record<string, string> = {
  // Control characters
  Enter: '\r',
  Return: '\r',
  Tab: '\t',
  Esc: '\x1b',
  Escape: '\x1b',
  Backspace: '\x7f',
  Space: ' ',

  // Ctrl combinations
  CtrlA: '\x01',
  CtrlB: '\x02',
  CtrlC: '\x03',
  CtrlD: '\x04',
  CtrlE: '\x05',
  CtrlF: '\x06',
  CtrlG: '\x07',
  CtrlH: '\x08',
  CtrlI: '\x09',
  CtrlJ: '\x0a',
  CtrlK: '\x0b',
  CtrlL: '\x0c',
  CtrlM: '\x0d',
  CtrlN: '\x0e',
  CtrlO: '\x0f',
  CtrlP: '\x10',
  CtrlQ: '\x11',
  CtrlR: '\x12',
  CtrlS: '\x13',
  CtrlT: '\x14',
  CtrlU: '\x15',
  CtrlV: '\x16',
  CtrlW: '\x17',
  CtrlX: '\x18',
  CtrlY: '\x19',
  CtrlZ: '\x1a',
  CtrlBackslash: '\x1c',

  // Arrows (CSI sequences, assuming normal mode — works for most TUIs)
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',

  // Nav
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Delete: '\x1b[3~',
  Insert: '\x1b[2~',

  // Function keys
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
}

export const KEY_NAMES = Object.keys(KEY_MAP)

export function resolveKey(name: string): string | null {
  return KEY_MAP[name] ?? null
}

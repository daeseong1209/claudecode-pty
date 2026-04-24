/**
 * On-demand terminal screenshot. Spins up a headless xterm.js instance,
 * replays the session's byte stream into it, and extracts either the plain
 * visible grid or an ANSI-preserving serialization.
 *
 * Lazy by design — we don't keep a mirror emulator running per session
 * because the parse cost would double for every byte of output. Screenshots
 * are a "when the agent asks" operation, not a hot path.
 */

// @xterm/headless and @xterm/addon-serialize ship as CJS webpack bundles —
// Node ESM can't statically expose their named exports, so we default-import
// the namespace and destructure the constructors at runtime. Types come from
// the .d.ts files via `import type`, separately from the runtime values.
import xtermHeadlessPkg from '@xterm/headless'
import xtermSerializePkg from '@xterm/addon-serialize'
import type { Terminal as TerminalType } from '@xterm/headless'
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize'

const { Terminal } = xtermHeadlessPkg as unknown as {
  Terminal: new (options: Record<string, unknown>) => TerminalType
}
const { SerializeAddon } = xtermSerializePkg as unknown as {
  SerializeAddon: new () => SerializeAddonType
}

export type ScreenshotFormat = 'plain' | 'ansi'

export interface ScreenshotOptions {
  format?: ScreenshotFormat
  cols: number
  rows: number
  /**
   * Scrollback lines kept by the headless emulator. Defaults to 1000, which
   * matches xterm.js default. Bigger = slower replay on high-traffic streams.
   */
  scrollback?: number
  /** Include scrollback lines in plain output (default true). */
  includeScrollback?: boolean
  /** Include the alternate screen buffer in ANSI serialization (default true). */
  includeAltBuffer?: boolean
}

export interface ScreenshotResult {
  text: string
  format: ScreenshotFormat
  cols: number
  rows: number
  visibleLines: number
  scrollbackLines: number
}

/**
 * Render `rawStream` through a headless terminal of the given size and return
 * a screenshot.
 *
 * The headless emulator always schedules writes asynchronously — we use the
 * `write(data, callback)` form and await the callback so the parser has
 * actually processed the bytes before we read the buffer.
 */
export async function renderScreenshot(
  rawStream: string,
  options: ScreenshotOptions
): Promise<ScreenshotResult> {
  const cols = options.cols
  const rows = options.rows
  const scrollback = options.scrollback ?? 1000
  const format = options.format ?? 'plain'
  const includeScrollback = options.includeScrollback ?? true
  const includeAltBuffer = options.includeAltBuffer ?? true

  const term = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
  })

  let serializeAddon: SerializeAddonType | undefined
  if (format === 'ansi') {
    serializeAddon = new SerializeAddon()
    term.loadAddon(serializeAddon)
  }

  if (rawStream.length > 0) {
    await new Promise<void>((resolve) => term.write(rawStream, () => resolve()))
  }

  const activeBuffer = term.buffer.active
  const scrollbackLines = activeBuffer.length - rows > 0 ? activeBuffer.length - rows : 0

  let text: string
  if (format === 'ansi' && serializeAddon) {
    text = serializeAddon.serialize({
      excludeAltBuffer: !includeAltBuffer,
      scrollback: includeScrollback ? undefined : 0,
    })
  } else {
    // Plain text: walk the buffer, translateToString(true) trims trailing spaces.
    const lines: string[] = []
    const startRow = includeScrollback ? 0 : scrollbackLines
    for (let y = startRow; y < activeBuffer.length; y++) {
      const line = activeBuffer.getLine(y)
      if (!line) continue
      lines.push(line.translateToString(true))
    }
    // Drop trailing blank lines (xterm pre-fills the screen).
    while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop()
    text = lines.join('\n')
  }

  term.dispose()

  return {
    text,
    format,
    cols,
    rows,
    visibleLines: rows,
    scrollbackLines,
  }
}

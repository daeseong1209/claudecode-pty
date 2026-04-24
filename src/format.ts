import type { PTYSessionInfo } from './pty/types.js'

/**
 * Output formatting helpers. XML-tag wrappers around structured data. These
 * are NOT real XML — content is not escaped; agents should treat the tags as
 * markers, not parse as a DOM.
 */

export const MAX_LINE_DISPLAY_LENGTH = 2000

export function formatLine(lineNumber: number, text: string, maxLength = MAX_LINE_DISPLAY_LENGTH) {
  const numStr = (lineNumber + 1).toString().padStart(6, '0')
  const truncated = text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
  return `${numStr}| ${truncated}`
}

/**
 * Strip ANSI control sequences from a string:
 *   - CSI sequences (ESC [ ... final-byte)
 *   - OSC sequences (ESC ] ... BEL or ESC \)
 *   - DCS / SOS / PM / APC (ESC P/X/^/_ ... ESC \)
 *   - Bare single-char escapes (ESC <single byte>)
 *   - Carriage returns preceding a real line break are preserved by the line
 *     splitter, so we remove lone `\r` here (it would show up as a weird gap).
 *
 * This is a lightweight rewrite — doesn't try to be a full VT parser, but
 * covers >99% of what shows up in build logs / REPL output.
 */
export function stripAnsi(input: string): string {
  // Fast path: no ESC at all. Still drop all CRs so `\r\n` normalizes to `\n`
  // and lone `\r` redraw artifacts disappear.
  if (!input.includes('\x1b')) {
    return input.replace(/\r/g, '')
  }
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    if (c === 0x1b) {
      // ESC — figure out what kind.
      const next = input.charCodeAt(i + 1)
      if (next === 0x5b /* [ */) {
        // CSI — consume until final byte in 0x40..0x7E
        i += 2
        while (i < input.length) {
          const b = input.charCodeAt(i)
          if (b >= 0x40 && b <= 0x7e) break
          i++
        }
        continue
      }
      if (next === 0x5d /* ] */ || next === 0x50 /* P */ || next === 0x58 /* X */ || next === 0x5e /* ^ */ || next === 0x5f /* _ */) {
        // OSC/DCS/SOS/PM/APC — consume until BEL or ESC \
        i += 2
        while (i < input.length) {
          const b = input.charCodeAt(i)
          if (b === 0x07) break // BEL
          if (b === 0x1b && input.charCodeAt(i + 1) === 0x5c) {
            i += 1 // will advance past backslash via outer loop
            break
          }
          i++
        }
        continue
      }
      // Any other 2-byte escape — skip the ESC + next byte.
      i += 1
      continue
    }
    if (c === 0x0d /* \r */) {
      // Drop lone CRs that aren't followed by LF (terminal redraw artifacts).
      if (input.charCodeAt(i + 1) !== 0x0a) continue
      // Preserve `\r\n` sequences by letting \n through next iteration.
      continue
    }
    out += input[i]
  }
  return out
}

export function formatSessionList(sessions: PTYSessionInfo[]): string {
  if (sessions.length === 0) return '<pty_list>\n(no active PTY sessions)\n</pty_list>'
  const body: string[] = ['<pty_list>']
  for (const s of sessions) body.push(...formatSessionSummary(s))
  body.push(`Total: ${sessions.length} session(s)`)
  body.push('</pty_list>')
  return body.join('\n')
}

export function formatSessionSummary(s: PTYSessionInfo): string[] {
  const exitInfo = s.exitCode !== null && s.exitCode !== undefined ? ` | exit: ${s.exitCode}` : ''
  const signalInfo = isRealSignal(s.exitSignal) ? ` | signal: ${s.exitSignal}` : ''
  const timedOutInfo = s.timedOut ? ' | TIMED OUT' : ''
  const timeoutInfo = s.timeoutSeconds !== undefined ? ` | timeout: ${s.timeoutSeconds}s` : ''
  const truncInfo =
    s.droppedLines > 0 ? ` | truncated ${s.droppedLines} lines / ${s.droppedBytes} bytes` : ''
  return [
    `[${s.id}] ${s.title}`,
    `  Description: ${s.description}`,
    `  Command: ${s.command} ${s.args.join(' ')}`,
    `  Status: ${s.status}${timedOutInfo}${exitInfo}${signalInfo}`,
    `  PID: ${s.pid}${timeoutInfo}`,
    `  Buffer: ${s.lineCount} lines / ${s.byteLength} bytes${truncInfo}`,
    `  Size: ${s.cols}x${s.rows}`,
    `  Workdir: ${s.workdir}`,
    `  Created: ${s.createdAt}`,
    '',
  ]
}

export function formatSpawned(s: PTYSessionInfo): string {
  return [
    '<pty_spawned>',
    `ID: ${s.id}`,
    `Title: ${s.title}`,
    `Description: ${s.description}`,
    `Command: ${s.command} ${s.args.join(' ')}`,
    `Workdir: ${s.workdir}`,
    `Size: ${s.cols}x${s.rows}`,
    `PID: ${s.pid}`,
    `Status: ${s.status}`,
    `NotifyOnExit: ${s.notifyOnExit}`,
    `TimeoutSeconds: ${s.timeoutSeconds ?? 'none'}`,
    '</pty_spawned>',
  ].join('\n')
}

export type KillOutcome = 'killed' | 'cleaned' | 'noop'

export function formatKilled(s: PTYSessionInfo, outcome: KillOutcome, cleanup: boolean): string {
  let headline: string
  switch (outcome) {
    case 'killed':
      headline = cleanup
        ? `Kill signal sent to ${s.id}; session will be removed when the process actually exits.`
        : `Kill signal sent to ${s.id}; session retained for log access.`
      break
    case 'cleaned':
      headline = `Cleaned up already-exited session ${s.id} (session removed).`
      break
    case 'noop':
      headline = `Session ${s.id} is already in status '${s.status}'; nothing to do (pass cleanup=true to remove).`
      break
  }
  return [
    '<pty_killed>',
    headline,
    `Title: ${s.title}`,
    `Command: ${s.command} ${s.args.join(' ')}`,
    `Final line count: ${s.lineCount}`,
    '</pty_killed>',
  ].join('\n')
}

export function formatReadPayload(
  s: PTYSessionInfo,
  lines: Array<{ lineNumber: number; text: string }>,
  meta: {
    mode: 'range' | 'tail' | 'grep'
    offset: number
    limit: number
    totalLines: number
    hasMore: boolean
    pattern?: string
    matchCount?: number
    searchTruncated?: boolean
    stripAnsi?: boolean
  }
): string {
  const attrs = [`id="${s.id}"`, `status="${s.status}"`, `mode="${meta.mode}"`]
  if (meta.pattern) attrs.push(`pattern="${escapeAttr(meta.pattern)}"`)
  const header = `<pty_output ${attrs.join(' ')}>`
  const body: string[] = [header]

  if (s.droppedLines > 0) {
    body.push(
      `<truncated bytes="${s.droppedBytes}" lines="${s.droppedLines}">(${s.droppedLines} earlier lines were dropped to stay under buffer capacity)</truncated>`
    )
  }

  if (lines.length === 0) {
    if (meta.pattern) {
      body.push(`(no matches for pattern '${meta.pattern}' in the scanned range)`)
    } else {
      body.push('(buffer empty at this range)')
    }
  } else {
    for (const { lineNumber, text } of lines) {
      const rendered = meta.stripAnsi ? stripAnsi(text) : text
      body.push(formatLine(lineNumber, rendered))
    }
  }

  body.push('')
  if (meta.pattern) {
    const matches = meta.matchCount ?? lines.length
    const trunc = meta.searchTruncated ? ' (search capped — see note)' : ''
    if (meta.searchTruncated) {
      body.push(
        `(scan was bounded; ${lines.length} of at least ${matches} matches visible. If offset > match count you'll see zero lines here — try a smaller offset.)`
      )
    } else if (meta.hasMore) {
      body.push(
        `(${lines.length} of ${matches} matches shown; total buffer ${s.lineCount} lines. offset=${meta.offset + lines.length} for next page${trunc})`
      )
    } else {
      body.push(
        `(${matches} match${matches === 1 ? '' : 'es'} shown; total buffer ${s.lineCount} lines${trunc})`
      )
    }
  } else {
    if (meta.hasMore) {
      body.push(
        `(showing ${lines.length} lines; total ${meta.totalLines}. offset=${meta.offset + lines.length} for next page)`
      )
    } else {
      body.push(`(end of buffer; total ${meta.totalLines} lines)`)
    }
  }

  body.push('</pty_output>')
  return body.join('\n')
}

export function formatExitNotification(
  s: PTYSessionInfo,
  exitCode: number | null,
  signal: number | string | undefined,
  lastLine: string,
  timedOut: boolean
): string {
  const truncatedLast = lastLine.length > 250 ? `${lastLine.slice(0, 250)}…` : lastLine
  const lines = [
    '<pty_exited>',
    `ID: ${s.id}`,
    `Description: ${s.description}`,
    `Exit Code: ${exitCode === null ? 'null (signal-killed)' : exitCode}`,
    `Signal: ${isRealSignal(signal) ? signal : 'none'}`,
    `TimeoutSeconds: ${s.timeoutSeconds ?? 'none'}`,
    `Timed Out: ${timedOut ? 'yes' : 'no'}`,
    `Output Lines: ${s.lineCount}`,
    `Dropped: ${s.droppedLines} lines / ${s.droppedBytes} bytes`,
    `Last Line: ${truncatedLast}`,
    '</pty_exited>',
  ]
  if (timedOut) {
    lines.push(
      '',
      'Process reached its configured timeout and was killed. Use pty_read to inspect final output.'
    )
  } else if (isRealSignal(signal)) {
    lines.push('', `Process was terminated by signal '${signal}'. Use pty_read to inspect output.`)
  } else if (exitCode === 0) {
    lines.push('', 'Use pty_read to check full output if needed.')
  } else {
    lines.push('', 'Process exited non-zero. Use pty_read with a `pattern` to search for errors.')
  }
  return lines.join('\n')
}

/**
 * node-pty on Unix reports `signal = 0` for clean exits. Treat that (and
 * undefined / null) as "no signal" so we don't print `Signal: 0` and don't
 * misclassify a clean exit as a signal death.
 */
export function isRealSignal(signal: number | string | undefined | null): boolean {
  if (signal === undefined || signal === null) return false
  if (typeof signal === 'number') return signal !== 0
  if (typeof signal === 'string') return signal.length > 0 && signal !== '0'
  return false
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '\\"')
}

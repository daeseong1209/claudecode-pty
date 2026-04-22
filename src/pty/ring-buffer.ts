/**
 * Line-oriented ring buffer for PTY output.
 *
 * Changes from v0.2.0:
 *   - enforceCapacity's current-line trim now rounds the byte cut-point to a
 *     UTF-8 codepoint boundary so mid-char drops don't inject U+FFFD.
 *   - search() handles offset > scanned-match-range: when `offset` lands past
 *     the matches we actually observed, we surface the honest pagination
 *     counters so callers don't see "no matches" alongside a nonzero footer.
 *   - `truncated` is true any time the scanCap cut off unscanned lines OR the
 *     caller's offset outran what we could count, so downstream messaging is
 *     always honest.
 */

import { AnsiLineParser } from './ansi-lines.js'

export interface SearchMatch {
  lineNumber: number
  text: string
}

export class RingBuffer {
  private lines: string[] = []
  private head = 0
  private currentLine: string[] = []
  private hasCurrent = false
  private bytesInBuffer = 0
  private droppedLines = 0
  private droppedBytes = 0
  private linesSeenTotal = 0
  private parser = new AnsiLineParser()
  private readonly capacity: number

  constructor(capacity = 1_000_000) {
    this.capacity = capacity
  }

  get lineCount(): number {
    const complete = this.lines.length - this.head
    return complete + (this.hasCurrent ? 1 : 0)
  }

  get byteLength(): number {
    return this.bytesInBuffer
  }

  get firstLineNumber(): number {
    return this.droppedLines
  }

  get wasTruncated(): boolean {
    return this.droppedLines > 0 || this.droppedBytes > 0
  }

  get truncationInfo() {
    return { lines: this.droppedLines, bytes: this.droppedBytes }
  }

  append(data: Buffer | string): void {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
    if (bytes.length === 0) return

    const lineStarts = this.parser.feed(bytes)
    this.bytesInBuffer += bytes.length

    let cursor = 0
    for (const start of lineStarts) {
      if (start - 1 > cursor) {
        const segBytes = bytes.subarray(cursor, start - 1)
        this.currentLine.push(segBytes.toString('utf-8'))
      }
      const completed = this.currentLine.length === 0 ? '' : this.currentLine.join('')
      this.lines.push(completed)
      this.linesSeenTotal += 1
      this.currentLine = []
      this.hasCurrent = false
      cursor = start
    }

    if (cursor < bytes.length) {
      const tail = bytes.subarray(cursor)
      this.currentLine.push(tail.toString('utf-8'))
      this.hasCurrent = true
    }

    this.enforceCapacity()
    this.compactHead()
  }

  readLines(offset: number, count: number): Array<{ lineNumber: number; text: string }> {
    if (count <= 0 || offset < 0) return []
    const completeCount = this.lines.length - this.head
    const totalVisible = completeCount + (this.hasCurrent ? 1 : 0)
    if (offset >= totalVisible) return []

    const actualCount = Math.min(count, totalVisible - offset)
    const result: Array<{ lineNumber: number; text: string }> = []
    const firstAbs = this.droppedLines + offset

    const completedEnd = Math.min(offset + actualCount, completeCount)
    for (let i = offset; i < completedEnd; i++) {
      result.push({ lineNumber: firstAbs + (i - offset), text: this.lines[this.head + i]! })
    }
    if (this.hasCurrent && offset + actualCount > completeCount) {
      result.push({
        lineNumber: this.droppedLines + completeCount,
        text: this.currentLine.join(''),
      })
    }
    return result
  }

  readTail(count: number): Array<{ lineNumber: number; text: string }> {
    const total = this.lineCount
    const start = Math.max(0, total - count)
    return this.readLines(start, count)
  }

  /**
   * Single-pass search. Counts every match within the scan cap but only
   * collects the requested [offset, offset+limit) window.
   *
   * `truncated` is true if:
   *   - the scan cap cut us off before scanning all lines, OR
   *   - the caller's offset is beyond our observed match count (so we can't
   *     say for sure "there are no more matches")
   */
  search(
    pattern: RegExp,
    options: { maxLines?: number; offset?: number; limit?: number } = {}
  ): { matches: SearchMatch[]; totalMatches: number; truncated: boolean } {
    const maxLines = options.maxLines ?? 100_000
    const offset = options.offset ?? 0
    const limit = options.limit
    const safePattern = this.stripGlobal(pattern)

    const completeCount = this.lines.length - this.head
    const totalVisible = completeCount + (this.hasCurrent ? 1 : 0)
    const scanCap = Math.min(maxLines, totalVisible)

    const matches: SearchMatch[] = []
    let totalMatches = 0
    let scanned = 0

    const shouldCollect = () =>
      totalMatches >= offset && (limit === undefined || matches.length < limit)

    for (let i = 0; i < completeCount && scanned < scanCap; i++, scanned++) {
      const line = this.lines[this.head + i]!
      if (safePattern.test(line)) {
        if (shouldCollect()) {
          matches.push({ lineNumber: this.droppedLines + i, text: line })
        }
        totalMatches += 1
      }
    }
    if (this.hasCurrent && scanned < scanCap) {
      const line = this.currentLine.join('')
      if (safePattern.test(line)) {
        if (shouldCollect()) {
          matches.push({ lineNumber: this.droppedLines + completeCount, text: line })
        }
        totalMatches += 1
      }
    }

    // A scan that stopped before the full buffer can't report a correct "no
    // more matches" — flag truncated so the caller surfaces that honestly.
    // Same story when the requested page starts past the last match we saw.
    const truncatedByCap = scanCap < totalVisible
    const truncatedByOffset = offset > totalMatches
    return { matches, totalMatches, truncated: truncatedByCap || truncatedByOffset }
  }

  clear(): void {
    this.lines = []
    this.head = 0
    this.currentLine = []
    this.hasCurrent = false
    this.bytesInBuffer = 0
    this.droppedLines = 0
    this.droppedBytes = 0
    this.linesSeenTotal = 0
    this.parser.reset()
  }

  private enforceCapacity(): void {
    while (this.bytesInBuffer > this.capacity && this.lines.length > this.head) {
      const dropped = this.lines[this.head]!
      this.lines[this.head] = ''
      const droppedBytes = Buffer.byteLength(dropped, 'utf-8') + 1
      this.bytesInBuffer -= droppedBytes
      this.droppedBytes += droppedBytes
      this.droppedLines += 1
      this.head += 1
    }
    // If the current in-progress line alone exceeds capacity, clamp it but
    // round the cut-point up to a UTF-8 codepoint boundary so we never drop
    // mid-character (which would corrupt to U+FFFD).
    if (this.bytesInBuffer > this.capacity && this.hasCurrent) {
      const joined = this.currentLine.join('')
      const joinedBuf = Buffer.from(joined, 'utf-8')
      const joinedBytes = joinedBuf.length
      const excess = this.bytesInBuffer - this.capacity
      if (excess > 0 && excess < joinedBytes) {
        // Advance past any UTF-8 continuation bytes (0b10xxxxxx) at `excess`.
        let cut = excess
        while (cut < joinedBytes && (joinedBuf[cut]! & 0xc0) === 0x80) cut++
        if (cut >= joinedBytes) {
          // Would drop everything — take nothing instead of corrupting.
          this.currentLine = []
          this.hasCurrent = false
          this.bytesInBuffer -= joinedBytes
          this.droppedBytes += joinedBytes
        } else {
          const kept = joinedBuf.subarray(cut).toString('utf-8')
          this.currentLine = [kept]
          this.bytesInBuffer -= cut
          this.droppedBytes += cut
        }
      }
    }
  }

  private compactHead(): void {
    if (this.head > 1024 && this.head > this.lines.length / 2) {
      this.lines = this.lines.slice(this.head)
      this.head = 0
    }
  }

  private stripGlobal(pattern: RegExp): RegExp {
    if (!pattern.global) return pattern
    const flags = pattern.flags.replace('g', '')
    return new RegExp(pattern.source, flags)
  }
}

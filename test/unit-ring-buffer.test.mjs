import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RingBuffer } from '../dist/pty/ring-buffer.js'

test('appends and reads complete lines', () => {
  const rb = new RingBuffer()
  rb.append('hello\nworld\n')
  const lines = rb.readLines(0, 10)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].text, 'hello')
  assert.equal(lines[1].text, 'world')
  assert.equal(lines[0].lineNumber, 0)
  assert.equal(lines[1].lineNumber, 1)
})

test('tracks partial (in-progress) line separately', () => {
  const rb = new RingBuffer()
  rb.append('done\nin progress')
  assert.equal(rb.lineCount, 2)
  const lines = rb.readLines(0, 10)
  assert.equal(lines[0].text, 'done')
  assert.equal(lines[1].text, 'in progress')
})

test('completes in-progress line on next newline', () => {
  const rb = new RingBuffer()
  rb.append('hello ')
  rb.append('world\n')
  const lines = rb.readLines(0, 10)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, 'hello world')
})

test('readTail returns last N lines in order', () => {
  const rb = new RingBuffer()
  rb.append('a\nb\nc\nd\ne\n')
  const tail = rb.readTail(3)
  assert.deepEqual(
    tail.map((l) => l.text),
    ['c', 'd', 'e']
  )
})

test('truncates oldest lines when capacity exceeded', () => {
  const rb = new RingBuffer(50)
  for (let i = 0; i < 100; i++) rb.append(`line-${i}\n`)
  assert.ok(rb.wasTruncated)
  assert.ok(rb.truncationInfo.lines > 0)
  assert.ok(rb.byteLength <= 60)
  const last = rb.readTail(1)
  assert.equal(last[0].text, 'line-99')
  assert.ok(last[0].lineNumber >= 99)
})

test('search returns matches with absolute line numbers', () => {
  const rb = new RingBuffer()
  rb.append('error: foo\n')
  rb.append('info: bar\n')
  rb.append('error: baz\n')
  const { matches, totalMatches } = rb.search(/error/)
  assert.equal(totalMatches, 2)
  assert.equal(matches.length, 2)
  assert.equal(matches[0].text, 'error: foo')
  assert.equal(matches[0].lineNumber, 0)
  assert.equal(matches[1].text, 'error: baz')
  assert.equal(matches[1].lineNumber, 2)
})

test('search strips global flag to avoid stateful bleed', () => {
  const rb = new RingBuffer()
  rb.append('match\nmatch\nmatch\n')
  const { matches } = rb.search(/match/g)
  assert.equal(matches.length, 3)
})

test('search pagination only materializes the requested page', () => {
  const rb = new RingBuffer()
  for (let i = 0; i < 500; i++) rb.append('matchy line ' + i + '\n')
  const res = rb.search(/matchy/, { offset: 100, limit: 10 })
  assert.equal(res.totalMatches, 500)
  assert.equal(res.matches.length, 10)
  assert.equal(res.matches[0].lineNumber, 100)
  assert.equal(res.matches[9].lineNumber, 109)
})

test('ANSI CSI with embedded \\n does not create a new line', () => {
  const rb = new RingBuffer()
  rb.append('\x1b[31mred\x1b[0m\nplain\n')
  const lines = rb.readLines(0, 10)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].text.includes('red'))
  assert.equal(lines[1].text, 'plain')
})

test('clear resets state', () => {
  const rb = new RingBuffer()
  rb.append('foo\nbar\n')
  rb.clear()
  assert.equal(rb.lineCount, 0)
  assert.equal(rb.byteLength, 0)
  assert.equal(rb.readLines(0, 10).length, 0)
  assert.ok(!rb.wasTruncated)
})

test('handles UTF-8 multi-byte characters', () => {
  const rb = new RingBuffer()
  rb.append('héllo\n日本語\n🚀 rocket\n')
  const lines = rb.readLines(0, 10)
  assert.equal(lines[0].text, 'héllo')
  assert.equal(lines[1].text, '日本語')
  assert.equal(lines[2].text, '🚀 rocket')
})

// ============================================================
// v0.2.1 — NEW
// ============================================================

test('search marks truncated=true when offset outruns observed matches', () => {
  const rb = new RingBuffer()
  for (let i = 0; i < 10; i++) rb.append('matchy ' + i + '\n')
  // We only have 10 matches — asking for offset=50 can't confidently say
  // "no more matches"; `truncated` must be true.
  const res = rb.search(/matchy/, { offset: 50, limit: 10 })
  assert.equal(res.matches.length, 0)
  assert.equal(res.totalMatches, 10)
  assert.equal(res.truncated, true)
})

test('current-line UTF-8 trim does not corrupt into U+FFFD', () => {
  // Capacity 10 bytes. 日本語 = 9 bytes; filler " " = 1 byte; "X" = 1 byte — 11 bytes total
  // forces enforceCapacity to trim the current in-progress line.
  const rb = new RingBuffer(10)
  rb.append(' 日本語X')
  const lines = rb.readLines(0, 10)
  // After trim, whatever we have should be valid UTF-8 — no U+FFFD.
  for (const l of lines) {
    assert.ok(!l.text.includes('�'), `unexpected U+FFFD in '${l.text}'`)
  }
})

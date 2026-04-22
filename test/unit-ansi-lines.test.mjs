import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnsiLineParser } from '../dist/pty/ansi-lines.js'

test('plain bytes: reports every \\n as a line start', () => {
  const p = new AnsiLineParser()
  const starts = p.feed(Buffer.from('ab\ncd\ne'))
  assert.deepEqual(starts, [3, 6])
})

test('CSI sequence with embedded \\n does NOT report a line start', () => {
  const p = new AnsiLineParser()
  const starts = p.feed(Buffer.from('\x1b[0;0\nm'))
  assert.deepEqual(starts, [])
})

test('OSC terminated by BEL with inner \\n ignored', () => {
  const p = new AnsiLineParser()
  const starts = p.feed(Buffer.from('\x1b]0;a\nb\x07after\n'))
  assert.equal(starts.length, 1)
  assert.equal(starts[0], Buffer.from('\x1b]0;a\nb\x07after\n').length)
})

test('OSC terminated by ESC \\ (ST)', () => {
  const p = new AnsiLineParser()
  const starts = p.feed(Buffer.from('\x1b]0;title\x1b\\after\n'))
  assert.equal(starts.length, 1)
})

test('state persists across feed calls', () => {
  const p = new AnsiLineParser()
  p.feed(Buffer.from('\x1b['))
  const starts = p.feed(Buffer.from('0;0\nm\nafter\n'))
  assert.ok(starts.length >= 1)
  assert.ok(starts[0] >= 5)
})

test('reset clears state', () => {
  const p = new AnsiLineParser()
  p.feed(Buffer.from('\x1b['))
  p.reset()
  const starts = p.feed(Buffer.from('\n'))
  assert.deepEqual(starts, [1])
})

test('unknown single-byte escape consumes one byte then returns to normal', () => {
  const p = new AnsiLineParser()
  // Bytes: [0]=ESC, [1]='7', [2..6]='after', [7]='\n', [8]='x'. Line start at 8.
  const starts = p.feed(Buffer.from('\x1b7after\nx'))
  assert.deepEqual(starts, [8])
})

test('DCS with embedded ESC-that-is-not-ST restores DCS state (not OSC)', () => {
  // Start DCS (ESC P), embed a harmless ESC (not followed by \), then a \n
  // that must NOT register as a line start because we're still inside DCS.
  // Finish DCS properly with ESC \, then an actual line break.
  const p = new AnsiLineParser()
  const buf = Buffer.from('\x1bP some \x1b @ data \n still-dcs \x1b\\real-line\n')
  const starts = p.feed(buf)
  // Only the final \n (after ESC \) should register.
  assert.equal(starts.length, 1, `unexpected starts: ${JSON.stringify(starts)}`)
  // That \n is the last byte; its index + 1 = buffer length.
  assert.equal(starts[0], buf.length)
})

test('OSC with embedded ESC-that-is-not-ST restores OSC state', () => {
  const p = new AnsiLineParser()
  const buf = Buffer.from('\x1b]0;title\x1b abc \n still-osc \x07after\n')
  const starts = p.feed(buf)
  assert.equal(starts.length, 1)
  assert.equal(starts[0], buf.length)
})

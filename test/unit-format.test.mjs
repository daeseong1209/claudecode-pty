import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatExitNotification, formatKilled, isRealSignal, stripAnsi } from '../dist/format.js'

test('isRealSignal: 0 / null / undefined / "" → false', () => {
  assert.equal(isRealSignal(0), false)
  assert.equal(isRealSignal(undefined), false)
  assert.equal(isRealSignal(null), false)
  assert.equal(isRealSignal(''), false)
  assert.equal(isRealSignal('0'), false)
})

test('isRealSignal: SIGTERM / 15 / SIGSEGV → true', () => {
  assert.equal(isRealSignal('SIGTERM'), true)
  assert.equal(isRealSignal(15), true)
  assert.equal(isRealSignal('SIGSEGV'), true)
})

test('formatExitNotification does NOT print "Signal: 0" on clean exit', () => {
  const info = {
    id: 'pty_x', title: 't', description: 'd', command: 'bash',
    args: ['-c', 'echo hi'], workdir: '/tmp', cols: 80, rows: 24,
    status: 'exited', notifyOnExit: true, timedOut: false, exitCode: 0,
    exitSignal: 0, pid: 1234, createdAt: '2026-04-21T00:00:00.000Z',
    lineCount: 1, byteLength: 3, droppedLines: 0, droppedBytes: 0,
  }
  const out = formatExitNotification(info, 0, 0, 'hi', false)
  assert.ok(out.includes('Signal: none'))
  assert.ok(!out.includes('Signal: 0'))
})

test('formatExitNotification prints real signal name', () => {
  const info = {
    id: 'pty_x', title: 't', description: 'd', command: 'bash',
    args: [], workdir: '/tmp', cols: 80, rows: 24, status: 'killed',
    notifyOnExit: true, timedOut: false, exitCode: null, exitSignal: 'SIGTERM',
    pid: 1234, createdAt: '2026-04-21T00:00:00.000Z',
    lineCount: 0, byteLength: 0, droppedLines: 0, droppedBytes: 0,
  }
  const out = formatExitNotification(info, null, 'SIGTERM', '', false)
  assert.ok(out.includes('Signal: SIGTERM'))
  assert.ok(out.includes('terminated by signal'))
})

test('formatKilled distinguishes killed / cleaned / noop', () => {
  const s = {
    id: 'pty_x', title: 't', description: 'd', command: 'sh', args: [],
    workdir: '/', cols: 80, rows: 24, status: 'exited', notifyOnExit: false,
    timedOut: false, exitCode: 0, exitSignal: undefined, pid: 1,
    createdAt: '', lineCount: 0, byteLength: 0, droppedLines: 0, droppedBytes: 0,
  }
  assert.ok(formatKilled(s, 'killed', false).includes('Kill signal sent'))
  assert.ok(formatKilled(s, 'cleaned', true).includes('Cleaned up'))
  assert.ok(formatKilled(s, 'noop', false).includes('nothing to do'))
})

// ============================================================
// v0.3.0 — stripAnsi
// ============================================================

test('stripAnsi: no-op on plain text', () => {
  assert.equal(stripAnsi('hello world'), 'hello world')
})

test('stripAnsi: removes CSI color codes', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m text'), 'red text')
})

test('stripAnsi: removes cursor movement', () => {
  assert.equal(stripAnsi('before\x1b[2K\x1b[Gafter'), 'beforeafter')
})

test('stripAnsi: removes OSC terminated by BEL', () => {
  assert.equal(stripAnsi('\x1b]0;window title\x07visible'), 'visible')
})

test('stripAnsi: removes OSC terminated by ESC\\', () => {
  assert.equal(stripAnsi('\x1b]0;title\x1b\\visible'), 'visible')
})

test('stripAnsi: removes bracketed-paste markers', () => {
  assert.equal(stripAnsi('\x1b[?2004hbefore\x1b[?2004l'), 'before')
})

test('stripAnsi: drops lone carriage returns', () => {
  assert.equal(stripAnsi('abc\rdef'), 'abcdef')
})

test('stripAnsi: preserves \\r\\n sequences', () => {
  // \r is dropped but \n stays
  assert.equal(stripAnsi('abc\r\ndef'), 'abc\ndef')
})

test('stripAnsi: handles unknown single-byte escapes', () => {
  assert.equal(stripAnsi('a\x1b7b'), 'ab')
})

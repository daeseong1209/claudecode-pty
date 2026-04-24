import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderScreenshot } from '../dist/pty/screenshot.js'

test('screenshot: plain format of simple output', async () => {
  const result = await renderScreenshot('hello\r\nworld\r\n', {
    format: 'plain',
    cols: 80,
    rows: 24,
  })
  assert.ok(result.text.includes('hello'))
  assert.ok(result.text.includes('world'))
  assert.equal(result.format, 'plain')
  assert.equal(result.cols, 80)
  assert.equal(result.rows, 24)
})

test('screenshot: plain format strips ANSI colors', async () => {
  const result = await renderScreenshot('\x1b[31mRED\x1b[0m plain\r\n', {
    format: 'plain',
    cols: 80,
    rows: 24,
  })
  assert.ok(!result.text.includes('\x1b['), 'plain must not contain escape')
  assert.ok(result.text.includes('RED'))
  assert.ok(result.text.includes('plain'))
})

test('screenshot: ansi format preserves color codes', async () => {
  const result = await renderScreenshot('\x1b[31mRED\x1b[0m\r\n', {
    format: 'ansi',
    cols: 80,
    rows: 24,
  })
  assert.ok(result.text.includes('\x1b['), 'ansi format should preserve escape')
  assert.ok(result.text.includes('RED'))
})

test('screenshot: empty stream yields empty grid', async () => {
  const result = await renderScreenshot('', {
    format: 'plain',
    cols: 80,
    rows: 24,
  })
  assert.equal(result.text, '')
  assert.equal(result.scrollbackLines, 0)
})

test('screenshot: alternate screen buffer (vim-style) with includeAltBuffer', async () => {
  // \x1b[?1049h = enter alt buffer, \x1b[?1049l = leave
  const altBuffer = '\x1b[?1049h\x1b[2J\x1b[Halt-content\x1b[?1049l'
  const withAlt = await renderScreenshot(altBuffer, {
    format: 'ansi',
    cols: 80,
    rows: 24,
    includeAltBuffer: true,
  })
  // Without alt buffer shouldn't have `alt-content` serialized.
  // With or without, the final screen is post-exit (normal buffer).
  // Just check the call doesn't throw.
  assert.equal(withAlt.format, 'ansi')
})

test('screenshot: cursor move + overwrite leaves only final state', async () => {
  // Type "hello", move cursor back 5, overwrite "WORLD"
  const stream = 'hello\x1b[5D' + 'WORLD\r\n'
  const result = await renderScreenshot(stream, {
    format: 'plain',
    cols: 80,
    rows: 24,
  })
  // After cursor move + overwrite, the visible line should be "WORLD"
  assert.ok(result.text.includes('WORLD'), `expected WORLD, got: ${result.text}`)
  assert.ok(!result.text.includes('hello'), `expected overwrite, got: ${result.text}`)
})

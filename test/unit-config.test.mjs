import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../dist/config.js'

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'claudecode-pty-cfg-'))
  mkdirSync(join(home, '.claudecode-pty'), { recursive: true })
  const prevHome = process.env.HOME
  process.env.HOME = home
  return {
    home,
    restore: () => {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
    },
  }
}

test('missing config returns defaults', () => {
  const h = makeHome()
  try {
    const cfg = loadConfig('.claudecode-pty')
    assert.equal(cfg.defaultAction, 'allow')
    assert.deepEqual(cfg.allow, [])
    assert.deepEqual(cfg.deny, [])
  } finally {
    h.restore()
  }
})

test('valid config is loaded', () => {
  const h = makeHome()
  try {
    writeFileSync(
      join(h.home, '.claudecode-pty', 'config.json'),
      JSON.stringify({
        allow: ['npm **'],
        deny: ['rm **'],
        defaultAction: 'deny',
        maxConcurrentSessions: 8,
      })
    )
    const cfg = loadConfig('.claudecode-pty')
    assert.equal(cfg.defaultAction, 'deny')
    assert.deepEqual(cfg.allow, ['npm **'])
    assert.deepEqual(cfg.deny, ['rm **'])
    assert.equal(cfg.maxConcurrentSessions, 8)
  } finally {
    h.restore()
  }
})

test('unparseable config logs a warning to stderr and falls back to defaults', async () => {
  const h = makeHome()
  try {
    writeFileSync(join(h.home, '.claudecode-pty', 'config.json'), '{ this is not json')
    // Capture stderr
    const origWrite = process.stderr.write.bind(process.stderr)
    let stderrBuf = ''
    process.stderr.write = (chunk, ...rest) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      return origWrite(chunk, ...rest)
    }
    const origConsoleError = console.error
    console.error = (...args) => {
      stderrBuf += args.join(' ') + '\n'
    }
    try {
      const cfg = loadConfig('.claudecode-pty')
      assert.equal(cfg.defaultAction, 'allow', 'falls back to defaults')
      assert.ok(
        /WARNING.*not valid JSON/i.test(stderrBuf),
        `expected stderr warning, got:\n${stderrBuf}`
      )
    } finally {
      process.stderr.write = origWrite
      console.error = origConsoleError
    }
  } finally {
    h.restore()
  }
})

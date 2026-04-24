import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../dist/pty/session.js'

function makeSession() {
  const s = new Session({ command: 'bash', description: 'wait test' })
  // Fake out the process — we're testing the waitFor hooks, not node-pty.
  s.internal = s.internal || {}
  return s
}

test('waitFor(pattern) resolves when a newly appended line matches', async () => {
  const s = makeSession()
  // Kick off the wait BEFORE the matching append.
  const wait = s.waitFor({ pattern: /ready/, timeoutMs: 2000 })
  // Simulate output.
  s.buffer.append('starting up\n')
  s.buffer.append('loading config\n')
  s.buffer.append('server ready on 8080\n')
  const result = await wait
  assert.equal(result.reason, 'pattern')
  assert.equal(result.match.text, 'server ready on 8080')
  assert.equal(result.match.lineNumber, 2)
})

test('waitFor(pattern) also matches the in-progress line (no trailing \\n)', async () => {
  const s = makeSession()
  const wait = s.waitFor({ pattern: /prompt>/, timeoutMs: 2000 })
  s.buffer.append('loading\n')
  s.buffer.append('prompt> ') // no newline — REPL waiting for input
  const result = await wait
  assert.equal(result.reason, 'pattern')
  assert.ok(result.match.text.includes('prompt>'))
})

test('waitFor(idleMs) resolves after quiet period', async () => {
  const s = makeSession()
  const start = Date.now()
  const result = await s.waitFor({ idleMs: 150, timeoutMs: 2000 })
  const elapsed = Date.now() - start
  assert.equal(result.reason, 'idle')
  assert.ok(elapsed >= 140 && elapsed < 400, `elapsed=${elapsed}ms`)
})

test('waitFor(idleMs) resets on each append', async () => {
  const s = makeSession()
  const wait = s.waitFor({ idleMs: 100, timeoutMs: 2000 })
  // Keep feeding for 300ms so idle timer keeps resetting.
  const ticker = setInterval(() => s.buffer.append('tick\n'), 30)
  setTimeout(() => clearInterval(ticker), 300)
  const result = await wait
  // Should NOT have resolved before ticks stopped + 100ms idle.
  assert.ok(result.elapsedMs >= 300, `expected >=300ms, got ${result.elapsedMs}ms`)
  assert.equal(result.reason, 'idle')
})

test('waitFor(timeoutMs) resolves as "timeout" when nothing else fires', async () => {
  const s = makeSession()
  const start = Date.now()
  const result = await s.waitFor({ pattern: /will-never-match/, timeoutMs: 150 })
  const elapsed = Date.now() - start
  assert.equal(result.reason, 'timeout')
  assert.ok(elapsed >= 140 && elapsed < 400)
})

test('waitFor on already-exited session resolves immediately as "exit"', async () => {
  const s = makeSession()
  // Fake exit state directly on internal (testing-only hack).
  s.internal.status = 'exited'
  s.exited = true
  s.internal.exitCode = 0
  const start = Date.now()
  const result = await s.waitFor({ untilExit: true, timeoutMs: 5000 })
  const elapsed = Date.now() - start
  assert.equal(result.reason, 'exit')
  assert.ok(elapsed < 50, `should resolve immediately, got ${elapsed}ms`)
})

test('pattern match takes precedence over idle and timeout', async () => {
  const s = makeSession()
  const wait = s.waitFor({
    pattern: /found/,
    idleMs: 5000,
    timeoutMs: 5000,
  })
  s.buffer.append('found it\n')
  const result = await wait
  assert.equal(result.reason, 'pattern')
})

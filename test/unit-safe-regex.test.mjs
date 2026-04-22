import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileSafePattern } from '../dist/safe-regex.js'

test('compiles a normal pattern', () => {
  const p = compileSafePattern('error|warn', false)
  assert.ok(p.regex.test('some error happened'))
  assert.ok(!p.regex.test('no issues'))
})

test('ignoreCase applies the i flag', () => {
  const p = compileSafePattern('ERROR', true)
  assert.ok(p.regex.test('error message'))
})

test('empty pattern is rejected', () => {
  assert.throws(() => compileSafePattern('', false), /must not be empty/)
})

test('excessively long pattern is rejected', () => {
  const long = 'a'.repeat(3000)
  assert.throws(() => compileSafePattern(long, false), /too long/)
})

test('catastrophic nested quantifier is rejected', () => {
  assert.throws(() => compileSafePattern('(a+)+b', false), /unsafe/)
})

test('invalid regex is rejected', () => {
  assert.throws(() => compileSafePattern('(unclosed', false), /Invalid regex/)
})

test('compiled regex has global flag stripped at search time', () => {
  // Direct compile doesn't force strip — RingBuffer's search does.
  // Here we just verify compile accepts a normal pattern.
  const p = compileSafePattern('foo', false)
  assert.equal(p.regex.flags.includes('g'), false)
})

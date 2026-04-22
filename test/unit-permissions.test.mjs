import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPermission } from '../dist/permissions.js'

const baseConfig = {
  allow: [],
  deny: [],
  defaultAction: 'allow',
  maxConcurrentSessions: 32,
  ringBufferBytes: 1_000_000,
}

test('positional exact match', () => {
  const cfg = { ...baseConfig, deny: ['npm run dev'] }
  assert.equal(checkPermission(cfg, 'npm', ['run', 'dev']).action, 'deny')
  assert.equal(checkPermission(cfg, 'npm', ['run', 'build']).action, 'allow')
  assert.equal(checkPermission(cfg, 'npm', ['run', 'dev', '--port', '3000']).action, 'allow')
})

test('`*` matches exactly one argument', () => {
  const cfg = { ...baseConfig, deny: ['git push *'] }
  assert.equal(checkPermission(cfg, 'git', ['push', 'main']).action, 'deny')
  assert.equal(checkPermission(cfg, 'git', ['push', 'origin', 'main']).action, 'allow')
  assert.equal(checkPermission(cfg, 'git', ['push']).action, 'allow')
})

test('`**` matches zero or more trailing args', () => {
  const cfg = { ...baseConfig, allow: ['npm **'], defaultAction: 'deny' }
  assert.equal(checkPermission(cfg, 'npm', []).action, 'allow')
  assert.equal(checkPermission(cfg, 'npm', ['run']).action, 'allow')
  assert.equal(checkPermission(cfg, 'npm', ['run', 'dev']).action, 'allow')
  assert.equal(checkPermission(cfg, 'cargo', ['build']).action, 'deny')
})

test('deny wins over allow when both match', () => {
  const cfg = {
    ...baseConfig,
    allow: ['npm **'],
    deny: ['npm publish **'],
  }
  assert.equal(checkPermission(cfg, 'npm', ['run', 'dev']).action, 'allow')
  assert.equal(
    checkPermission(cfg, 'npm', ['publish', '--access', 'public']).action,
    'deny'
  )
})

test('`**` prefix + suffix pattern anchors both sides', () => {
  const cfg = { ...baseConfig, allow: ['git ** -- src/'], defaultAction: 'deny' }
  assert.equal(checkPermission(cfg, 'git', ['log', '--', 'src/']).action, 'allow')
  assert.equal(checkPermission(cfg, 'git', ['log', '-n', '5', '--', 'src/']).action, 'allow')
  assert.equal(checkPermission(cfg, 'git', ['log', '--', 'other/']).action, 'deny')
})

test('multiple `**` in a single pattern is rejected', () => {
  const cfg = { ...baseConfig, allow: ['npm ** run **'], defaultAction: 'deny' }
  assert.equal(checkPermission(cfg, 'npm', ['run', 'dev']).action, 'deny')
})

test('defaultAction=deny blocks anything unmatched', () => {
  const cfg = { ...baseConfig, defaultAction: 'deny' }
  assert.equal(checkPermission(cfg, 'whatever', []).action, 'deny')
})

test('no subsequence semantics (regression test)', () => {
  const cfg = { ...baseConfig, deny: ['npm run dev'] }
  assert.equal(checkPermission(cfg, 'npm', ['foo', 'run', 'bar', 'dev']).action, 'allow')
})

// ============================================================
// v0.2.1 — NEW
// ============================================================

test('bare `**` pattern means "anything allowed"', () => {
  const cfg = { ...baseConfig, allow: ['**'], defaultAction: 'deny' }
  assert.equal(checkPermission(cfg, 'ls', []).action, 'allow')
  assert.equal(checkPermission(cfg, 'ls', ['-la']).action, 'allow')
  assert.equal(checkPermission(cfg, 'cargo', ['build', '--release']).action, 'allow')
})

test('absolute path command matches basename rule (path normalization)', () => {
  const cfg = { ...baseConfig, deny: ['rm **'] }
  assert.equal(checkPermission(cfg, '/bin/rm', ['-rf', '/tmp/foo']).action, 'deny')
  assert.equal(checkPermission(cfg, '/usr/bin/rm', ['-rf', '/tmp/foo']).action, 'deny')
})

test('relative path command matches basename rule', () => {
  const cfg = { ...baseConfig, deny: ['deploy.sh **'] }
  assert.equal(checkPermission(cfg, './scripts/deploy.sh', ['prod']).action, 'deny')
})

test('slashless command unchanged by normalization', () => {
  const cfg = { ...baseConfig, deny: ['rm **'] }
  assert.equal(checkPermission(cfg, 'rm', ['-rf', '/tmp/foo']).action, 'deny')
  assert.equal(checkPermission(cfg, 'ls', ['-la']).action, 'allow')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCommands, normalizeCommandHead } from '../dist/shell-parse.js'

test('simple command', () => {
  const cmds = extractCommands('echo hello\n')
  assert.deepEqual(cmds, [{ command: 'echo', args: ['hello'] }])
})

test('semicolon and && separate statements', () => {
  const cmds = extractCommands('a 1; b 2 && c 3\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['a', 'b', 'c']
  )
})

test('pipe splits statements (both sides checked)', () => {
  const cmds = extractCommands('ls -la | grep foo\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['ls', 'grep']
  )
})

test('redirects skip the target token', () => {
  const cmds = extractCommands('echo hi > out.txt\n')
  assert.deepEqual(cmds, [{ command: 'echo', args: ['hi'] }])
})

test('single quotes prevent splitting', () => {
  const cmds = extractCommands("echo 'a; b && c'\n")
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['echo']
  )
})

test('double quotes prevent splitting but allow escapes', () => {
  const cmds = extractCommands('echo "don\'t split; this"\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['echo']
  )
})

test('command substitution is extracted recursively', () => {
  const cmds = extractCommands('echo $(rm -rf /)\n')
  const names = cmds.map((c) => c.command).sort()
  assert.deepEqual(names, ['echo', 'rm'])
})

test('backtick substitution is extracted recursively', () => {
  const cmds = extractCommands('echo `whoami`\n')
  const names = cmds.map((c) => c.command).sort()
  assert.deepEqual(names, ['echo', 'whoami'])
})

test('env prefix is stripped', () => {
  const cmds = extractCommands('FOO=bar BAZ=qux npm test\n')
  assert.deepEqual(cmds, [{ command: 'npm', args: ['test'] }])
})

test('array-index env prefix is stripped (arr[0]=x)', () => {
  const cmds = extractCommands('arr[0]=x rm -rf /tmp/foo\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['rm']
  )
})

test('line comment is stripped', () => {
  const cmds = extractCommands('echo hi # this is a comment rm -rf /\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['echo']
  )
})

test('empty input yields no commands', () => {
  assert.deepEqual(extractCommands(''), [])
  assert.deepEqual(extractCommands('\n\n  \n'), [])
})

// ============================================================
// v0.2.1 — shell-parse bypass closures
// ============================================================

test('subshell (cmd) is unwrapped so inner command is extracted', () => {
  const cmds = extractCommands('(rm -rf /tmp/foo)\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['rm']
  )
})

test('brace group { cmd; } is unwrapped', () => {
  const cmds = extractCommands('{ rm -rf /tmp/foo; }\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['rm']
  )
})

test('nested subshell peels multiple layers', () => {
  const cmds = extractCommands('( ( rm -rf / ) )\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['rm']
  )
})

test('process substitution <(cmd) is extracted', () => {
  const cmds = extractCommands('diff <(cat a) <(rm -rf /)\n')
  const names = cmds.map((c) => c.command).sort()
  assert.ok(names.includes('rm'))
  assert.ok(names.includes('cat'))
  assert.ok(names.includes('diff'))
})

test('process substitution >(cmd) is extracted', () => {
  const cmds = extractCommands('tee >(rm -rf /tmp/x)\n')
  const names = cmds.map((c) => c.command).sort()
  assert.ok(names.includes('rm'))
  assert.ok(names.includes('tee'))
})

test('bash keyword `if` is skipped so real command surfaces', () => {
  const cmds = extractCommands('if rm -rf /tmp/foo; then echo ok; fi\n')
  const names = cmds.map((c) => c.command)
  assert.ok(names.includes('rm'), `expected rm, got ${JSON.stringify(names)}`)
  assert.ok(names.includes('echo'))
})

test('bash keyword `for` skips the loop preamble `NAME in LIST;`', () => {
  const cmds = extractCommands('for i in 1 2 3; do rm -rf /tmp/foo; done\n')
  const names = cmds.map((c) => c.command)
  assert.ok(names.includes('rm'))
  // Must NOT include `i` or the list items as heads
  assert.ok(!names.includes('i'))
  assert.ok(!names.includes('1'))
})

test('bash keyword `while` is skipped', () => {
  const cmds = extractCommands('while rm -rf /tmp/foo; do break; done\n')
  const names = cmds.map((c) => c.command)
  assert.ok(names.includes('rm'))
})

test('bash `!` negator is stripped', () => {
  const cmds = extractCommands('! rm -rf /tmp/foo\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['rm']
  )
})

// ============================================================
// v0.2.2 — critical bypass closures from second review
// ============================================================

test('deep nesting beyond 5 layers still unwraps (no cap)', () => {
  const cmds = extractCommands('((((((((((rm -rf /))))))))))\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['rm']
  )
})

test('adjacent subshells `(a) (b)` each extracted separately', () => {
  const cmds = extractCommands('(rm -rf /) (echo safe)\n')
  const names = cmds.map((c) => c.command).sort()
  assert.ok(names.includes('rm'), `expected rm in ${JSON.stringify(names)}`)
  assert.ok(names.includes('echo'))
})

test('function NAME { body } extracts body command, not NAME', () => {
  const cmds = extractCommands('function foo { rm -rf /tmp/foo; }\n')
  const names = cmds.map((c) => c.command)
  assert.ok(names.includes('rm'), `expected rm in ${JSON.stringify(names)}`)
  assert.ok(!names.includes('foo'))
})

test('coproc keyword is skipped', () => {
  const cmds = extractCommands('coproc rm -rf /tmp/foo\n')
  const names = cmds.map((c) => c.command)
  assert.ok(names.includes('rm'), `expected rm in ${JSON.stringify(names)}`)
  assert.ok(!names.includes('coproc'))
})

test('exec / env / command / builtin / nice / nohup / ionice wrappers unpeel', () => {
  for (const wrapper of ['exec', 'env', 'command', 'builtin', 'nice', 'nohup', 'ionice']) {
    const cmds = extractCommands(`${wrapper} rm -rf /tmp/foo\n`)
    const names = cmds.map((c) => c.command)
    assert.ok(names.includes('rm'), `wrapper=${wrapper} expected rm, got ${JSON.stringify(names)}`)
  }
})

test('env with KEY=VAL pairs then command still reaches inner command', () => {
  const cmds = extractCommands('env FOO=bar BAZ=qux rm -rf /tmp/foo\n')
  assert.deepEqual(
    cmds.map((c) => c.command),
    ['rm']
  )
})

test('case ARM;; esac — arm body is extracted', () => {
  const cmds = extractCommands('case x in a) rm -rf /tmp/foo;; esac\n')
  const names = cmds.map((c) => c.command)
  assert.ok(names.includes('rm'), `expected rm in ${JSON.stringify(names)}`)
  assert.ok(!names.includes('x'))
})

test('case with paren pattern — `(pattern) body;;` extracts body', () => {
  const cmds = extractCommands('case x in (a) rm -rf /tmp/foo;; esac\n')
  const names = cmds.map((c) => c.command)
  assert.ok(names.includes('rm'))
})

// ------------------------------------------------------------
// normalizeCommandHead — basename normalization
// ------------------------------------------------------------

test('normalizeCommandHead strips absolute path', () => {
  assert.equal(normalizeCommandHead('/bin/rm'), 'rm')
  assert.equal(normalizeCommandHead('/usr/local/bin/npm'), 'npm')
})

test('normalizeCommandHead strips relative path', () => {
  assert.equal(normalizeCommandHead('./scripts/deploy.sh'), 'deploy.sh')
  assert.equal(normalizeCommandHead('../tool'), 'tool')
})

test('normalizeCommandHead leaves slash-free tokens alone', () => {
  assert.equal(normalizeCommandHead('rm'), 'rm')
  assert.equal(normalizeCommandHead('npm'), 'npm')
})

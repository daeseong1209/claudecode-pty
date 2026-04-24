import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = join(__dirname, '..', 'dist', 'index.js')

class McpClient {
  constructor() {
    this.proc = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: '/tmp/claudecode-pty-test-home-' + process.pid },
    })
    this.nextId = 1
    this.pendingById = new Map()
    this.notifications = []
    this.buf = ''
    this.proc.stdout.setEncoding('utf-8')
    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk) => {
      process.stderr.write('[server stderr] ' + chunk)
    })
    this.proc.on('exit', (code) => {
      for (const [, pending] of this.pendingById) {
        pending.reject(new Error(`server exited early (code ${code})`))
      }
      this.pendingById.clear()
    })
  }

  onStdout(chunk) {
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined && this.pendingById.has(msg.id)) {
        const pending = this.pendingById.get(msg.id)
        this.pendingById.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error.message))
        else pending.resolve(msg.result)
      } else {
        this.notifications.push(msg)
      }
    }
  }

  request(method, params) {
    const id = this.nextId++
    const msg = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingById.has(id)) {
          this.pendingById.delete(id)
          reject(new Error(`timeout waiting for response to ${method}`))
        }
      }, 10000)
      timer.unref?.()
      this.pendingById.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    })
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params }
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  close() {
    try {
      this.proc.kill('SIGTERM')
    } catch {}
  }
}

async function withClient(fn) {
  const client = new McpClient()
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { logging: {} },
      clientInfo: { name: 'test-client', version: '0.0.1' },
    })
    assert.equal(init.serverInfo.name, 'claudecode-pty')
    client.notify('notifications/initialized', {})
    await fn(client)
  } finally {
    client.close()
  }
}

test('lists 8 pty tools', async () => {
  await withClient(async (client) => {
    const result = await client.request('tools/list', {})
    const names = result.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'pty_kill',
      'pty_list',
      'pty_read',
      'pty_resize',
      'pty_send_key',
      'pty_spawn',
      'pty_wait',
      'pty_write',
    ])
  })
})

test('pty_write submit=true appends newline and submits command', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'read LINE; echo "got: $LINE"'],
        description: 'pty_write submit test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]
    await new Promise((r) => setTimeout(r, 200))

    // Single call — no separate pty_send_key Enter needed.
    await client.request('tools/call', {
      name: 'pty_write',
      arguments: { id, text: 'hello-submit', submit: true },
    })

    await new Promise((r) => setTimeout(r, 400))

    const readResult = await client.request('tools/call', {
      name: 'pty_read',
      arguments: { id, tail: 20 },
    })
    assert.ok(
      readResult.content[0].text.includes('got: hello-submit'),
      `expected echoed input, got:\n${readResult.content[0].text}`
    )

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('pty_read stripAnsi=true removes color codes from output', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'printf "\\x1b[31mRED\\x1b[0m\\n\\x1b[32mGREEN\\x1b[0m\\n"'],
        description: 'stripAnsi test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]
    await new Promise((r) => setTimeout(r, 300))

    const rawRead = await client.request('tools/call', {
      name: 'pty_read',
      arguments: { id, tail: 10, stripAnsi: false },
    })
    assert.ok(rawRead.content[0].text.includes('\x1b['), 'raw read should include ESC')

    const cleanRead = await client.request('tools/call', {
      name: 'pty_read',
      arguments: { id, tail: 10, stripAnsi: true },
    })
    assert.ok(!cleanRead.content[0].text.includes('\x1b['), 'stripped read must not include ESC')
    assert.ok(cleanRead.content[0].text.includes('RED'))
    assert.ok(cleanRead.content[0].text.includes('GREEN'))

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('pty_wait resolves on pattern match', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'sleep 0.3; echo "READY marker"; sleep 10'],
        description: 'pty_wait pattern test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]

    const waitResult = await client.request('tools/call', {
      name: 'pty_wait',
      arguments: { id, pattern: 'READY', timeoutSeconds: 5 },
    })
    const text = waitResult.content[0].text
    assert.ok(text.includes('Reason: pattern'), `expected pattern match, got:\n${text}`)
    assert.ok(text.includes('READY marker'))

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('pty_wait untilExit=true resolves when process exits', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'echo hi; sleep 0.3; exit 0'],
        description: 'pty_wait exit test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]

    const waitResult = await client.request('tools/call', {
      name: 'pty_wait',
      arguments: { id, untilExit: true, timeoutSeconds: 5 },
    })
    const text = waitResult.content[0].text
    assert.ok(text.includes('Reason: exit'), `expected exit, got:\n${text}`)
    assert.ok(text.includes('Exit Code: 0'))

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('pty_wait timeoutSeconds returns timeout (not error) when nothing fires', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'sleep 30'],
        description: 'pty_wait timeout test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]

    const waitResult = await client.request('tools/call', {
      name: 'pty_wait',
      arguments: { id, pattern: 'never-fires', timeoutSeconds: 1 },
    })
    const text = waitResult.content[0].text
    assert.ok(!waitResult.isError, 'timeout should not be isError')
    assert.ok(text.includes('Reason: timeout'), `expected timeout, got:\n${text}`)

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('can spawn a PTY, read its output, and kill it (full round-trip)', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'echo hello-pty; sleep 0.2; echo done'],
        description: 'round-trip test session',
      },
    })
    const spawnText = spawnResult.content[0].text
    const idMatch = spawnText.match(/ID: (pty_[a-f0-9]+)/)
    assert.ok(idMatch, `expected ID in: ${spawnText}`)
    const id = idMatch[1]

    await new Promise((r) => setTimeout(r, 600))

    const readResult = await client.request('tools/call', {
      name: 'pty_read',
      arguments: { id, tail: 10 },
    })
    const readText = readResult.content[0].text
    assert.ok(readText.includes('hello-pty'), `expected 'hello-pty' in output:\n${readText}`)
    assert.ok(readText.includes('done'), `expected 'done' in output:\n${readText}`)

    const listResult = await client.request('tools/call', {
      name: 'pty_list',
      arguments: {},
    })
    assert.ok(listResult.content[0].text.includes(id))

    const killResult = await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
    assert.ok(killResult.content[0].text.includes(id))
  })
})

test('pty_read rejects catastrophic regex', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'echo hi; sleep 0.1'],
        description: 'regex safety test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]
    await new Promise((r) => setTimeout(r, 300))

    const result = await client.request('tools/call', {
      name: 'pty_read',
      arguments: { id, pattern: '(a+)+b' },
    })
    assert.ok(result.isError, 'expected isError=true for unsafe pattern')
    assert.ok(result.content[0].text.includes('unsafe'))

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('pty_send_key sends a named key', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'read LINE; echo "got: $LINE"'],
        description: 'send-key test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]

    await new Promise((r) => setTimeout(r, 200))

    await client.request('tools/call', {
      name: 'pty_write',
      arguments: { id, text: 'typed-text' },
    })
    await client.request('tools/call', {
      name: 'pty_send_key',
      arguments: { id, key: 'Enter' },
    })

    await new Promise((r) => setTimeout(r, 400))

    const readResult = await client.request('tools/call', {
      name: 'pty_read',
      arguments: { id, tail: 20 },
    })
    assert.ok(
      readResult.content[0].text.includes('got: typed-text'),
      `expected echoed input in:\n${readResult.content[0].text}`
    )

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('pty_list filters by status', async () => {
  await withClient(async (client) => {
    const result = await client.request('tools/call', {
      name: 'pty_list',
      arguments: { status: 'running' },
    })
    assert.ok(result.content[0].text.includes('<pty_list>'))
  })
})

test('unsafe timeout scheduling kills a stuck process', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'sleep 30'],
        description: 'timeout test',
        timeoutSeconds: 1,
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]

    await new Promise((r) => setTimeout(r, 2500))

    const listResult = await client.request('tools/call', {
      name: 'pty_list',
      arguments: {},
    })
    assert.ok(
      listResult.content[0].text.includes('TIMED OUT') ||
        listResult.content[0].text.includes('killed'),
      `expected timeout marker in:\n${listResult.content[0].text}`
    )

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('pty_resize rejects exited sessions', async () => {
  await withClient(async (client) => {
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'echo bye'],
        description: 'resize-rejection test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]
    await new Promise((r) => setTimeout(r, 400))

    const result = await client.request('tools/call', {
      name: 'pty_resize',
      arguments: { id, cols: 80, rows: 24 },
    })
    assert.ok(result.isError, 'expected resize on non-running session to be an error')
    assert.ok(
      /only running sessions/i.test(result.content[0].text),
      `expected message in:\n${result.content[0].text}`
    )

    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })
  })
})

test('pty_kill with cleanup=true on a TERM-trapping child waits for actual exit', async () => {
  await withClient(async (client) => {
    // Child traps SIGTERM and refuses to exit for 2 seconds, then exits.
    const spawnResult = await client.request('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: [
          '-c',
          "trap 'echo TERM-ignored' TERM; for i in 1 2 3 4; do sleep 1; done; echo done-loop",
        ],
        description: 'trap-term test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]
    await new Promise((r) => setTimeout(r, 300))

    // Kill with cleanup=true. The child will trap and keep running; our
    // manager must NOT remove the session from the map until the child
    // actually exits (either naturally or after our 5s SIGKILL escalation).
    await client.request('tools/call', {
      name: 'pty_kill',
      arguments: { id, cleanup: true },
    })

    // Session should still be listed right after kill (status 'killing' or 'killed')
    const immediate = await client.request('tools/call', {
      name: 'pty_list',
      arguments: {},
    })
    assert.ok(
      immediate.content[0].text.includes(id),
      `session should persist during grace period; got:\n${immediate.content[0].text}`
    )

    // After SIGKILL escalation (5s grace) the child is dead, and cleanup has fired.
    await new Promise((r) => setTimeout(r, 6000))
    const after = await client.request('tools/call', {
      name: 'pty_list',
      arguments: {},
    })
    assert.ok(
      !after.content[0].text.includes(id),
      `session should be cleaned up after child exits; still present in:\n${after.content[0].text}`
    )
  })
})

test('pty_write denies commands that match deny rules, respecting quotes', async () => {
  // Spin up a server with a custom HOME pointing at a fresh temp dir so we
  // can drop a config.json with specific rules.
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'claudecode-pty-pwtest-'))
  mkdirSync(join(home, '.claudecode-pty'), { recursive: true })
  writeFileSync(
    join(home, '.claudecode-pty', 'config.json'),
    JSON.stringify({
      allow: ['bash **', 'echo **'],
      deny: ['rm **'],
      defaultAction: 'allow',
    })
  )

  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home },
  })
  const pending = new Map()
  let nextId = 1
  let buf = ''
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        }
      } catch {}
    }
  })
  proc.stderr.on('data', () => {})
  const req = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error('timeout ' + method))
        }
      }, 8000)
      timer.unref?.()
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })

  try {
    await req('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    })
    proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'
    )

    const spawnResult = await req('tools/call', {
      name: 'pty_spawn',
      arguments: {
        command: 'bash',
        args: ['-c', 'cat > /dev/null'],
        description: 'permission pty_write test',
      },
    })
    const id = spawnResult.content[0].text.match(/ID: (pty_[a-f0-9]+)/)[1]
    await new Promise((r) => setTimeout(r, 200))

    // This should be denied by `rm **`
    const denied = await req('tools/call', {
      name: 'pty_write',
      arguments: { id, text: 'rm -rf /\n' },
    })
    assert.ok(denied.isError, 'rm command should be denied')

    // Harmless echo of a string that contains "rm" inside quotes should NOT be denied.
    const allowed = await req('tools/call', {
      name: 'pty_write',
      arguments: { id, text: 'echo "rm should stay inside quotes"\n' },
    })
    assert.ok(!allowed.isError, `quoted rm should not trigger deny; got:\n${allowed.content[0].text}`)

    await req('tools/call', { name: 'pty_kill', arguments: { id, cleanup: true } })
  } finally {
    proc.kill('SIGTERM')
  }
})

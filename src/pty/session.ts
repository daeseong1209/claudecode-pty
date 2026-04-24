import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { randomBytes } from 'node:crypto'
import { RingBuffer } from './ring-buffer.js'
import type { PTYSessionInternal, PTYSessionInfo, SpawnOptions } from './types.js'

export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 40
export const KILL_GRACE_MS = 5000
const SESSION_ID_BYTES = 8

function generateId(
  existing?: { has(id: string): boolean }
): string {
  for (let i = 0; i < 16; i++) {
    const id = `pty_${randomBytes(SESSION_ID_BYTES).toString('hex')}`
    if (!existing || !existing.has(id)) return id
  }
  // Astronomically unlikely; surface loudly.
  throw new Error('Failed to generate a unique session id after 16 attempts')
}

export interface SessionExitEvent {
  session: Session
  exitCode: number | null
  signal: number | string | undefined
  timedOut: boolean
}

export type ExitCallback = (event: SessionExitEvent) => void

/**
 * Reason a `waitFor` call resolved.
 *   - `pattern` — a newly appended line matched the regex
 *   - `exit`    — the session exited before any of the above fired
 *   - `idle`    — no new output for the caller-supplied idle window
 *   - `timeout` — the absolute timeout elapsed first
 */
export type WaitReason = 'pattern' | 'exit' | 'idle' | 'timeout'

export interface WaitResult {
  reason: WaitReason
  /** If reason === 'pattern', the line that matched. */
  match?: { lineNumber: number; text: string }
  /** Final status snapshot at the time of resolution. */
  status: string
  /** Exit code if reason === 'exit' (may be null for signal death). */
  exitCode?: number | null
  /** Signal name/number if reason === 'exit'. */
  signal?: number | string
  /** Milliseconds elapsed since the call started. */
  elapsedMs: number
}

export interface WaitOptions {
  /** Resolve when an appended line matches this regex. */
  pattern?: RegExp
  /** Resolve if no new output arrives for this many milliseconds. */
  idleMs?: number
  /** Absolute timeout — resolves with `timeout` after this many milliseconds. Required. */
  timeoutMs: number
}

/**
 * A single PTY session. Wraps one node-pty IPty, a ring buffer, lifecycle
 * state, and optional timeout.
 *
 * Lifecycle:
 *   - `kill(signal)` sends the given signal (default SIGTERM) and schedules a
 *     SIGKILL escalation after KILL_GRACE_MS if the child traps/ignores.
 *   - `markCleanupOnExit()` asks the manager to drop this session from the
 *     registry only after the child actually exits — so a slow-dying or
 *     SIGTERM-trapping process is never orphaned off the map.
 *   - `resize()` rejects non-running sessions and only mutates stored cols/rows
 *     after the native resize succeeds, so failures don't poison toInfo().
 *   - `onExit` is idempotent: duplicate fires from node-pty are ignored.
 */
export class Session {
  readonly id: string
  readonly buffer: RingBuffer
  readonly createdAt: Date
  readonly command: string
  readonly args: string[]
  readonly workdir: string
  readonly env?: Record<string, string>
  readonly title: string
  readonly description: string
  readonly notifyOnExit: boolean
  readonly timeoutSeconds?: number

  private internal: PTYSessionInternal
  private timeoutHandle: NodeJS.Timeout | undefined
  private killEscalationHandle: NodeJS.Timeout | undefined
  private cleanupRequested = false
  private exited = false
  private exitCallbacks: ExitCallback[] = []

  constructor(
    opts: SpawnOptions,
    ringCapacity = 1_000_000,
    existingIds?: { has(id: string): boolean }
  ) {
    this.id = generateId(existingIds)
    this.createdAt = new Date()
    this.command = opts.command
    this.args = opts.args ?? []
    this.workdir = opts.workdir ?? process.cwd()
    this.env = opts.env
    this.title =
      opts.title ??
      (`${opts.command} ${this.args.join(' ')}`.trim() || `Terminal ${this.id.slice(-4)}`)
    this.description = opts.description
    this.notifyOnExit = opts.notifyOnExit ?? false
    this.timeoutSeconds = opts.timeoutSeconds
    this.buffer = new RingBuffer(ringCapacity)

    const cols = opts.cols ?? DEFAULT_COLS
    const rows = opts.rows ?? DEFAULT_ROWS

    this.internal = {
      id: this.id,
      title: this.title,
      description: this.description,
      command: this.command,
      args: this.args,
      workdir: this.workdir,
      env: this.env,
      cols,
      rows,
      status: 'running',
      exitCode: null,
      exitSignal: undefined,
      pid: 0,
      createdAt: this.createdAt,
      notifyOnExit: this.notifyOnExit,
      timeoutSeconds: this.timeoutSeconds,
      timedOut: false,
      process: null,
    }
  }

  start(): void {
    const mergedEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') mergedEnv[k] = v
    }
    if (this.env) {
      for (const [k, v] of Object.entries(this.env)) mergedEnv[k] = v
    }

    let proc: IPty
    try {
      proc = pty.spawn(this.command, this.args, {
        name: 'xterm-256color',
        cols: this.internal.cols,
        rows: this.internal.rows,
        cwd: this.workdir,
        env: mergedEnv,
      })
    } catch (err) {
      throw new Error(
        `Failed to spawn PTY for '${this.command}': ${err instanceof Error ? err.message : String(err)}`
      )
    }

    this.internal.process = proc
    this.internal.pid = proc.pid

    proc.onData((data: string) => {
      this.buffer.append(data)
    })

    proc.onExit(({ exitCode, signal }) => {
      // Idempotency: node-pty can double-fire on some platforms. Do nothing on
      // the second pass — status, exit code, listeners must not be replayed.
      if (this.exited) return
      this.exited = true
      this.clearTimers()
      const wasKilling = this.internal.status === 'killing'
      this.internal.status = wasKilling ? 'killed' : 'exited'
      // Preserve a null exitCode when the child was signal-killed so callers
      // can distinguish "exited(0)" from "killed by signal".
      this.internal.exitCode = typeof exitCode === 'number' ? exitCode : null
      this.internal.exitSignal = signal
      const event: SessionExitEvent = {
        session: this,
        exitCode: this.internal.exitCode,
        signal,
        timedOut: this.internal.timedOut,
      }
      for (const cb of this.exitCallbacks) {
        try {
          cb(event)
        } catch {
          // ignore callback errors
        }
      }
    })

    if (this.timeoutSeconds !== undefined) {
      this.scheduleTimeout(this.timeoutSeconds)
    }
  }

  write(data: string): boolean {
    if (this.internal.status !== 'running' || !this.internal.process) {
      return false
    }
    try {
      this.internal.process.write(data)
      return true
    } catch {
      return false
    }
  }

  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0 || !Number.isInteger(cols) || !Number.isInteger(rows)) {
      throw new Error('cols and rows must be positive integers')
    }
    if (this.internal.status !== 'running') {
      throw new Error(
        `Cannot resize PTY '${this.id}': status is '${this.internal.status}'; only running sessions can be resized.`
      )
    }
    if (!this.internal.process) {
      throw new Error(`Cannot resize PTY '${this.id}': process handle missing`)
    }
    try {
      this.internal.process.resize(cols, rows)
    } catch (err) {
      throw new Error(
        `Failed to resize PTY: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    // Only record the new size after the native resize succeeded.
    this.internal.cols = cols
    this.internal.rows = rows
  }

  /**
   * Send a signal to the child. Accepts re-kills while `killing` so a second
   * call with SIGKILL (or any explicit signal) during the grace window is
   * delivered immediately instead of being silently dropped.
   *
   * Returns false only when the session has already fully exited (no child to
   * signal). Returns true in every other case and actually forwards `sig` to
   * the child via node-pty.
   */
  kill(signal?: string): boolean {
    if (this.internal.status === 'exited' || this.internal.status === 'killed') {
      return false
    }
    const sig = signal || 'SIGTERM'
    if (this.internal.status === 'running') {
      this.internal.status = 'killing'
    }
    try {
      this.internal.process?.kill(sig)
    } catch {
      // ignore
    }
    // SIGKILL supersedes any pending escalation — clear it so we don't re-send.
    if (sig === 'SIGKILL' && this.killEscalationHandle) {
      clearTimeout(this.killEscalationHandle)
      this.killEscalationHandle = undefined
    }
    if (sig !== 'SIGKILL' && !this.killEscalationHandle) {
      this.killEscalationHandle = setTimeout(() => {
        this.killEscalationHandle = undefined
        if (this.internal.status === 'killing' && this.internal.process) {
          try {
            this.internal.process.kill('SIGKILL')
          } catch {
            // ignore
          }
        }
      }, KILL_GRACE_MS)
      this.killEscalationHandle.unref?.()
    }
    return true
  }

  markCleanupOnExit(): void {
    this.cleanupRequested = true
  }

  get wantsCleanup(): boolean {
    return this.cleanupRequested
  }

  onExit(cb: ExitCallback): void {
    this.exitCallbacks.push(cb)
  }

  /**
   * Wait for something observable on this session, returning a structured
   * WaitResult. The promise always resolves (never rejects); callers inspect
   * `reason` to distinguish pattern-match / exit / idle / timeout.
   *
   * Rules:
   *   - If the session is already exited, resolves immediately with reason='exit'.
   *   - If pattern is supplied, only lines completed AFTER the call starts
   *     can trigger it — this matches the "wait for next match" intent.
   *   - The idle timer is reset every time the buffer appends (complete OR
   *     in-progress line). If no appends happen for idleMs, resolve.
   *   - timeoutMs is absolute; whichever of the four resolves first wins.
   */
  waitFor(options: WaitOptions): Promise<WaitResult> {
    const start = Date.now()
    return new Promise<WaitResult>((resolve) => {
      let resolved = false
      let idleHandle: NodeJS.Timeout | undefined
      let timeoutHandle: NodeJS.Timeout | undefined
      let unsubscribeAppend: (() => void) | undefined
      let unsubscribeExit: (() => void) | undefined

      const finish = (result: WaitResult) => {
        if (resolved) return
        resolved = true
        if (idleHandle) clearTimeout(idleHandle)
        if (timeoutHandle) clearTimeout(timeoutHandle)
        unsubscribeAppend?.()
        unsubscribeExit?.()
        resolve(result)
      }

      const snapshot = () => ({
        status: this.internal.status,
        exitCode: this.internal.exitCode,
        signal: this.internal.exitSignal,
        elapsedMs: Date.now() - start,
      })

      // Session already done — resolve immediately.
      if (this.exited) {
        finish({
          reason: 'exit',
          ...snapshot(),
        })
        return
      }

      const resetIdleTimer = () => {
        if (options.idleMs === undefined) return
        if (idleHandle) clearTimeout(idleHandle)
        idleHandle = setTimeout(() => {
          finish({ reason: 'idle', ...snapshot() })
        }, options.idleMs)
        idleHandle.unref?.()
      }

      // Subscribe to buffer appends.
      unsubscribeAppend = this.buffer.onAppend((event) => {
        // Reset idle timer on any new bytes.
        resetIdleTimer()
        // Pattern matching: scan newly completed lines.
        if (options.pattern) {
          for (const line of event.completedLines) {
            if (options.pattern.test(line.text)) {
              finish({
                reason: 'pattern',
                match: line,
                ...snapshot(),
              })
              return
            }
          }
          // Also check the current in-progress line (for REPL prompts etc.).
          if (event.currentLine && options.pattern.test(event.currentLine.text)) {
            finish({
              reason: 'pattern',
              match: event.currentLine,
              ...snapshot(),
            })
          }
        }
      })

      // Subscribe to exit.
      const exitCb: ExitCallback = (evt) => {
        finish({
          reason: 'exit',
          status: this.internal.status,
          exitCode: evt.exitCode,
          signal: evt.signal,
          elapsedMs: Date.now() - start,
        })
      }
      this.exitCallbacks.push(exitCb)
      unsubscribeExit = () => {
        const idx = this.exitCallbacks.indexOf(exitCb)
        if (idx !== -1) this.exitCallbacks.splice(idx, 1)
      }

      // Absolute timeout.
      timeoutHandle = setTimeout(() => {
        finish({ reason: 'timeout', ...snapshot() })
      }, options.timeoutMs)
      timeoutHandle.unref?.()

      // Seed the idle timer — a session that was silent BEFORE the call also
      // counts toward idle.
      resetIdleTimer()
    })
  }

  get status() {
    return this.internal.status
  }

  get pid() {
    return this.internal.pid
  }

  get timedOut() {
    return this.internal.timedOut
  }

  toInfo(): PTYSessionInfo {
    const trunc = this.buffer.truncationInfo
    return {
      id: this.id,
      title: this.title,
      description: this.description,
      command: this.command,
      args: this.args,
      workdir: this.workdir,
      cols: this.internal.cols,
      rows: this.internal.rows,
      status: this.internal.status,
      notifyOnExit: this.notifyOnExit,
      timeoutSeconds: this.timeoutSeconds,
      timedOut: this.internal.timedOut,
      exitCode: this.internal.exitCode,
      exitSignal: this.internal.exitSignal,
      pid: this.internal.pid,
      createdAt: this.createdAt.toISOString(),
      lineCount: this.buffer.lineCount,
      byteLength: this.buffer.byteLength,
      droppedLines: trunc.lines,
      droppedBytes: trunc.bytes,
    }
  }

  private scheduleTimeout(seconds: number): void {
    this.timeoutHandle = setTimeout(() => {
      this.timeoutHandle = undefined
      if (this.internal.status !== 'running') return
      this.internal.timedOut = true
      this.kill('SIGTERM')
    }, seconds * 1000)
    this.timeoutHandle.unref?.()
  }

  private clearTimers(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = undefined
    }
    if (this.killEscalationHandle) {
      clearTimeout(this.killEscalationHandle)
      this.killEscalationHandle = undefined
    }
  }
}

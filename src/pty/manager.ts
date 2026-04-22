import { Session, type ExitCallback, type SessionExitEvent } from './session.js'
import type { PTYSessionInfo, SpawnOptions } from './types.js'

export interface ManagerOptions {
  maxConcurrentSessions?: number
  ringBufferCapacity?: number
}

/**
 * Registry of live and recently-exited Sessions. Enforces a concurrency cap
 * and fans exit events to subscribed listeners.
 *
 * `kill(id, cleanup=true)` is deferred: the session is only removed from
 * the registry when the child actually exits, so a SIGTERM-trapping process
 * can't be orphaned off the map — even across multiple kill calls.
 */
export class PTYManager {
  private sessions = new Map<string, Session>()
  private exitListeners: ExitCallback[] = []
  private readonly maxConcurrentSessions: number
  private readonly ringBufferCapacity: number

  constructor(options: ManagerOptions = {}) {
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? 32
    this.ringBufferCapacity = options.ringBufferCapacity ?? 1_000_000
  }

  spawn(opts: SpawnOptions): Session {
    const running = [...this.sessions.values()].filter((s) => s.status === 'running').length
    if (running >= this.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent PTY sessions (${this.maxConcurrentSessions}) reached. Kill an existing session before spawning a new one.`
      )
    }
    const session = new Session(opts, this.ringBufferCapacity)
    session.onExit(this.handleSessionExit)
    session.start()
    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  list(filter?: { status?: PTYSessionInfo['status'] | PTYSessionInfo['status'][] }): Session[] {
    const sessions = [...this.sessions.values()]
    if (!filter || !filter.status) return sessions
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
    return sessions.filter((s) => statuses.includes(s.status))
  }

  /**
   * Returns a structured status describing what the call did:
   *   - 'not_found': no such session
   *   - 'killed':    was running OR already mid-kill; signal sent (if running),
   *                  cleanup (if requested) is deferred to onExit
   *   - 'cleaned':   was already exited, removed from registry
   *   - 'noop':      was already exited, cleanup=false, nothing to do
   */
  kill(
    id: string,
    cleanup = false,
    signal?: string
  ): 'not_found' | 'killed' | 'cleaned' | 'noop' {
    const session = this.sessions.get(id)
    if (!session) return 'not_found'
    // If the child is still alive (running) or on its way out (killing), send
    // the signal and defer cleanup to onExit. NEVER delete the map entry while
    // the child could still be running, or it becomes orphaned/unreachable.
    if (session.status === 'running' || session.status === 'killing') {
      // In either state, forward the signal. Session.kill now accepts a
      // re-kill during `killing` so explicit SIGKILL escalation lands.
      session.kill(signal)
      if (cleanup) session.markCleanupOnExit()
      return 'killed'
    }
    if (cleanup) {
      this.sessions.delete(id)
      return 'cleaned'
    }
    return 'noop'
  }

  /**
   * Asks every running session to die, marks them for cleanup, and returns a
   * Promise that resolves when they have all actually exited (up to a timeout).
   *
   * Callers (like the stdio shutdown path) should `await` this before
   * process.exit so the SIGKILL escalation timer has a chance to run.
   */
  async clearAll(timeoutMs = 6000): Promise<void> {
    const running: Session[] = []
    for (const [id, session] of [...this.sessions.entries()]) {
      if (session.status === 'running' || session.status === 'killing') {
        if (session.status === 'running') session.kill('SIGTERM')
        session.markCleanupOnExit()
        running.push(session)
      } else {
        this.sessions.delete(id)
      }
    }
    if (running.length === 0) return
    await Promise.race([
      Promise.all(
        running.map(
          (s) =>
            new Promise<void>((resolve) => {
              if (s.status !== 'running' && s.status !== 'killing') {
                resolve()
                return
              }
              s.onExit(() => resolve())
            })
        )
      ),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs)
        t.unref?.()
      }),
    ])
  }

  onExit(cb: ExitCallback): () => void {
    this.exitListeners.push(cb)
    return () => {
      const idx = this.exitListeners.indexOf(cb)
      if (idx !== -1) this.exitListeners.splice(idx, 1)
    }
  }

  get runningCount(): number {
    return [...this.sessions.values()].filter((s) => s.status === 'running').length
  }

  get totalCount(): number {
    return this.sessions.size
  }

  private handleSessionExit = (event: SessionExitEvent): void => {
    for (const listener of this.exitListeners) {
      try {
        listener(event)
      } catch {
        // ignore
      }
    }
    if (event.session.wantsCleanup) {
      this.sessions.delete(event.session.id)
    }
  }
}

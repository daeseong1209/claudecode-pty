import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PTYManager } from '../pty/manager.js'
import { formatExitNotification, isRealSignal } from '../format.js'

const LOGGER_NAME = 'claudecode-pty'

/**
 * Classify an exit into an MCP logging level.
 *
 *   - error:   non-zero exit code AND not a soft signal. Also covers crash
 *              signals (SIGSEGV / SIGABRT / SIGBUS / SIGFPE / SIGILL).
 *   - warning: explicit timeout OR soft termination signal (SIGTERM / SIGINT /
 *              SIGHUP / SIGQUIT) OR killed-by-signal with unknown class.
 *   - info:    clean `exitCode === 0`.
 */
function classifyExit(
  exitCode: number | null,
  signal: number | string | undefined,
  timedOut: boolean
): 'info' | 'warning' | 'error' {
  if (timedOut) return 'warning'
  const realSignal = isRealSignal(signal)
  if (realSignal) {
    const s = typeof signal === 'string' ? signal.toUpperCase() : String(signal)
    const crash = new Set(['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGILL'])
    if (crash.has(s)) return 'error'
    const soft = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'])
    if (soft.has(s)) return 'warning'
    return 'warning'
  }
  if (exitCode === 0) return 'info'
  return 'error'
}

/**
 * Wire the manager's session-exit events to MCP logging notifications.
 * Uses the public `McpServer.sendLoggingMessage` API. If the client didn't
 * advertise logging capability, the SDK's internal check rejects — we swallow
 * silently (both sync-throws and promise-rejections).
 */
export function wireExitNotifications(server: McpServer, manager: PTYManager): () => void {
  return manager.onExit((event) => {
    if (!event.session.notifyOnExit) return
    const info = event.session.toInfo()
    const tail = event.session.buffer.readTail(1)
    const lastLine = tail.length > 0 ? tail[tail.length - 1]!.text : ''
    const body = formatExitNotification(
      info,
      event.exitCode,
      event.signal,
      lastLine,
      event.timedOut
    )
    const level = classifyExit(event.exitCode, event.signal, event.timedOut)
    try {
      const p = server.sendLoggingMessage({ level, logger: LOGGER_NAME, data: body })
      if (p && typeof (p as Promise<void>).catch === 'function') {
        ;(p as Promise<void>).catch(() => {
          // Client may not support logging capability — swallow.
        })
      }
    } catch {
      // Sync throws too — swallow.
    }
  })
}

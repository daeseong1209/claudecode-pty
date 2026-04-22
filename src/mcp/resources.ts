import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PTYManager } from '../pty/manager.js'

/**
 * Expose session state as MCP resources so clients can browse without calling
 * tools.
 *
 *   pty://sessions        — JSON list of all sessions (summary shape)
 *   pty://sessions/{id}   — per-session detail: info + last 100 lines of buffer
 */
export function registerResources(server: McpServer, manager: PTYManager): void {
  server.registerResource(
    'pty-sessions',
    'pty://sessions',
    {
      title: 'PTY Sessions',
      description: 'JSON list of all PTY sessions (running, exited, killed)',
      mimeType: 'application/json',
    },
    async (uri) => {
      const infos = manager.list().map((s) => s.toInfo())
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ sessions: infos, count: infos.length }, null, 2),
          },
        ],
      }
    }
  )

  server.registerResource(
    'pty-session-detail',
    new ResourceTemplate('pty://sessions/{id}', {
      list: async () => ({
        resources: manager.list().map((s) => ({
          uri: `pty://sessions/${s.id}`,
          name: `pty-session-${s.id}`,
          title: `PTY ${s.id} (${s.status})`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'PTY Session Detail',
      description: 'Per-session metadata plus the last 100 lines of the buffer',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const idRaw = variables.id
      const id = Array.isArray(idRaw) ? idRaw[0] : idRaw
      if (!id) {
        throw new Error('Missing session id in URI')
      }
      const session = manager.get(String(id))
      if (!session) {
        throw new Error(`PTY session '${id}' not found`)
      }
      const info = session.toInfo()
      const tail = session.buffer.readTail(100)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                session: info,
                recentLines: tail,
                truncation: session.buffer.truncationInfo,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )
}

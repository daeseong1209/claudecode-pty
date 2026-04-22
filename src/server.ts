import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { PTYManager } from './pty/manager.js'
import { registerTools } from './mcp/tools.js'
import { registerResources } from './mcp/resources.js'
import { wireExitNotifications } from './mcp/notifications.js'

const SERVER_NAME = 'claudecode-pty'
const CONFIG_DIR_NAME = '.claudecode-pty'

/**
 * Resolve the shipped package version so the value we advertise over MCP
 * `initialize` always matches what's actually installed. Falls back to
 * 'unknown' if the file is missing or unreadable (should never happen for a
 * built package).
 */
function readServerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // dist/ is one level under package root
    const pkgPath = join(here, '..', 'package.json')
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: unknown }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
  } catch {
    // ignore
  }
  return 'unknown'
}

const SERVER_VERSION = readServerVersion()

export async function startMcpServer(): Promise<void> {
  const config = loadConfig(CONFIG_DIR_NAME)
  const manager = new PTYManager({
    maxConcurrentSessions: config.maxConcurrentSessions,
    ringBufferCapacity: config.ringBufferBytes,
  })

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, logging: {} } }
  )

  registerTools(server, manager, config)
  registerResources(server, manager)
  wireExitNotifications(server, manager)

  const transport = new StdioServerTransport()

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await manager.clearAll()
    } catch {
      // ignore
    }
    try {
      await server.close()
    } catch {
      // ignore
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await server.connect(transport)
}

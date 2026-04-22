#!/usr/bin/env node
import { startMcpServer } from './server.js'

startMcpServer().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[claudecode-pty] fatal:', err instanceof Error ? err.stack || err.message : err)
  process.exit(1)
})
